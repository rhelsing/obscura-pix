import { Obscura, type InboxRow } from '../native/ObscuraModule';
import { planDrain, type DrainRow, type ModelRules } from '../domain/drain';
import type { Entry } from '../domain/merge';
import { obscuraSchema } from '../models/schema';
import { withEntryLock } from './entryLock';
import { logError } from '../utils/log';

/**
 * Drain the kit's inbox into the app's own store (`obscura-native/docs/KIT_API.md` §3).
 *
 * `drain.ts` decides *what* should happen; this performs it. They are separate because the decision
 * is worth testing without a kit, and because the **order of the effects** is the part that can lose
 * a message — so it lives in one short function where it can be read at a glance:
 *
 * ```
 * peek → plan → WRITE entries → THEN consume → discard
 * ```
 *
 * Write-before-consume is not a preference. The inbox row is the only copy of the message: the kit
 * already acked, so the server deleted its own. Consuming before the entry is durably stored is a
 * message destroyed with no way to notice. If a write throws, the rows stay in the inbox and the
 * next drain reprocesses them — which is safe precisely because `peek` is side-effect free and
 * `merge` is idempotent.
 */

/**
 * `schema.ts` translated into what the drain needs per model: the merge rule (`gset` is immutable,
 * `lww` is last-writer-wins) and the authorization rules.
 *
 * The authorization rules are derived from the same declarations the *send* side uses, so the two
 * directions cannot disagree: a model whose audience is a conversation is exactly a model whose
 * inbound entries must name a conversation between this user and the sender.
 */
function modelRules(): Map<string, ModelRules> {
  const rules = new Map<string, ModelRules>();
  for (const [model, config] of Object.entries(obscuraSchema)) {
    const c = config as {
      sync?: string;
      audience?: { kind: string; field?: string };
      ownerIdPrefix?: string;
    };
    rules.set(model, {
      merge: c.sync === 'gset' ? 'APPEND' : 'REPLACE',
      conversationField: c.audience?.kind === 'conversation' ? c.audience.field : undefined,
      ownerIdPrefix: c.ownerIdPrefix,
    });
  }
  return rules;
}

function toDrainRow(row: InboxRow): DrainRow {
  return {
    id: row.id,
    kind: row.kind,
    modelKey: row.modelKey,
    entryId: row.entryId,
    op: row.op,
    sentAt: row.sentAt,
    // Server-stamped sender identity (NATIVE_CONTRACT §0.10).
    senderUserId: row.senderUserId,
    senderDeviceId: row.senderDeviceId,
    payload: row.payload,
  };
}

async function currentState(models: Iterable<string>): Promise<Map<string, Map<string, Entry>>> {
  const state = new Map<string, Map<string, Entry>>();
  for (const model of models) {
    const stored = await Obscura.entryAll(model);
    const byId = new Map<string, Entry>();
    for (const e of stored) {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        // Our own stored row failed to parse. It cannot participate in a merge, but it must not stop
        // the drain either — an unreadable local row is a bug to fix, not a reason to stop
        // delivering everything behind it.
        logError('drain.parseStored:' + model, new Error(`entry ${e.id} is not JSON`));
        continue;
      }
      byId.set(e.id, { id: e.id, sentAt: e.sentAt, authorDeviceId: e.authorDeviceId, data });
    }
    state.set(model, byId);
  }
  return state;
}

export interface DrainResult {
  /** Rows written to the entry store. */
  written: number;
  consumed: number;
  discarded: number;
  /** Models whose entries changed, so the caller can refresh only those. */
  touched: string[];
}

/**
 * Drain up to `limit` rows. Returns what happened, so the caller can refresh the right slices.
 *
 * Serialised against every other entry writer by `withEntryLock`. That is load-bearing, not
 * defensive: this function READS the current state, decides, then writes — and a write landing
 * inside that window is computed against a snapshot that never saw it, so the merge silently
 * reverts it. See `entryLock.ts` for the concrete failure.
 */
export async function drainInbox(limit = 50): Promise<DrainResult> {
  return withEntryLock(() => drainInboxUnlocked(limit));
}

const EMPTY_RESULT: DrainResult = { written: 0, consumed: 0, discarded: 0, touched: [] };

async function drainInboxUnlocked(limit: number): Promise<DrainResult> {
  const rows = await Obscura.inboxPeek(limit);
  if (rows.length === 0) return { ...EMPTY_RESULT };

  // Authorization needs to know who I am, and there is no safe default: an empty `selfUserId` would
  // make every conversation check fail closed and discard real mail. Refuse to drain instead — the
  // rows stay in the inbox and the next trigger retries, which is what `peek` being side-effect free
  // is for.
  const selfUserId = (await Obscura.getUserId()) ?? '';
  if (selfUserId === '') {
    logError('drain.noIdentity', new Error('inbox drain skipped: the session identity is not loaded'));
    return { ...EMPTY_RESULT };
  }

  const rules = modelRules();
  // Only the models this batch mentions need loading. Loading all of them would make every drain
  // proportional to the whole store rather than to the batch.
  const mentioned = new Set(
    rows.map((r) => r.modelKey).filter((m): m is string => m !== null && rules.has(m)),
  );
  const state = await currentState(mentioned);

  const plan = planDrain(rows.map(toDrainRow), rules, state, selfUserId);

  // 1. WRITE FIRST. A row is only safe to consume once its entry is durably stored.
  let written = 0;
  const touched: string[] = [];
  for (const [model, entries] of plan.writes) {
    for (const entry of entries) {
      await Obscura.entryPut(
        model,
        entry.id,
        JSON.stringify(entry.data),
        entry.sentAt,
        entry.authorDeviceId,
      );
      written += 1;
    }
    if (entries.length > 0) touched.push(model);
  }

  // 2. THEN consume. If step 1 threw, we never get here and the rows are redelivered next drain.
  if (plan.consume.length > 0) await Obscura.inboxConsume(plan.consume);

  // 3. Discard what can never be processed — data loss, chosen out loud, grouped by reason so the
  //    kit's security log says WHY rather than just how many (§3.3 rule 5).
  //
  //    Rule 5 also requires it to be **surfaced**, not merely logged by the kit: "it is data loss,
  //    chosen deliberately, and must never be the quiet path". Passing the reason across the bridge
  //    and saying nothing app-side left the app's own log — the one the debug screen shows — silent
  //    about every discard. `unauthorized-sender` in particular is a security event: it means
  //    somebody sent this device an entry they were not entitled to write.
  const byReason = new Map<string, number[]>();
  for (const { id, reason } of plan.discard) {
    byReason.set(reason, [...(byReason.get(reason) ?? []), id]);
  }
  for (const [reason, ids] of byReason) {
    await Obscura.inboxDiscard(ids, reason);
    logError('inbox.discard:' + reason, new Error(`discarded ${ids.length} inbox row(s): ${reason}`));
  }

  return {
    written,
    consumed: plan.consume.length,
    discarded: plan.discard.length,
    touched,
  };
}

/**
 * Drain repeatedly until the inbox is empty.
 *
 * Bounded by `maxBatches` rather than looping on `inboxDepth() > 0`: a row that is somehow neither
 * consumed nor discarded would spin forever, and a drain that cannot terminate is worse than one
 * that stops early and reports it. `drain.ts` guarantees every row is accounted for, so this bound
 * should never be reached — which is exactly why hitting it is worth logging.
 */
export async function drainInboxFully(limit = 50, maxBatches = 100): Promise<DrainResult> {
  const total: DrainResult = { written: 0, consumed: 0, discarded: 0, touched: [] };
  const touched = new Set<string>();
  let hitTheBound = true;

  for (let i = 0; i < maxBatches; i += 1) {
    const result = await drainInbox(limit);
    total.written += result.written;
    total.consumed += result.consumed;
    total.discarded += result.discarded;
    result.touched.forEach((m) => touched.add(m));
    if (result.consumed + result.discarded === 0) {
      hitTheBound = false;
      break;
    }
  }

  // Logged AFTER the loop, and only when the bound was actually reached with rows still waiting.
  // The old test — `i === maxBatches - 1` inside the loop — fired whenever the last permitted batch
  // made progress, which includes the batch that *emptied* the inbox: a clean finish reported as a
  // failure, every time the row count happened to be a multiple of the batch size.
  if (hitTheBound) {
    const depth = await Obscura.inboxDepth();
    if (depth > 0) {
      logError(
        'drain.maxBatches',
        new Error(`${depth} row(s) still in the inbox after ${maxBatches} batches`),
      );
    }
  }

  total.touched = [...touched];
  return total;
}
