/**
 * Draining the kit's inbox (`obscura-native/docs/KIT_API.md` §3).
 *
 * The kit stores opaque bytes; the application decides what they mean.
 *
 * ## The contract, and why each step is where it is
 *
 * ```
 * peek(limit) → for each row: classify → AUTHORIZE → attribute → merge → put → consume | discard
 * ```
 *
 * - **Authorize before storing.** Delivery is not authorization: any authenticated user can deliver
 *   to any device (KIT_API §4.1), so arrival does not prove that the sender may write a row.
 *
 * - **`peek` is side-effect free.** Draining twice without consuming returns the same rows. That is
 *   the crash-safety property, not a bug: an app that dies mid-drain reprocesses, and `merge.ts`'s
 *   rules are idempotent so reprocessing converges.
 * - **Consume only what was durably written.** An inbox row is the ONLY copy — the kit already
 *   acked, so the server deleted its own. A row consumed before its entry is stored is a message
 *   destroyed. So this writes first, then consumes, and consumes only the ids it actually wrote.
 * - **A row the app cannot process is `discard`ed, not skipped.** §4.1's rule, and the condition
 *   §3.4's deferral of the `after:` cursor rests on: with no cursor, a row that is skipped sits at
 *   the head of the queue forever, `inboxDepth()` never reaches zero, and the drain wedges. Skipping
 *   is the one behaviour that is never correct here.
 *
 * ## What this file deliberately does not do
 *
 * No network, no bridge, no storage. It takes rows and the current state and returns a **plan**:
 * what to write, what to consume, what to discard. That keeps the decision testable without a kit,
 * and keeps the effects in one place (`inboxDrain.ts`) where their ordering is visible.
 */

import { parseConversationId } from './conversation';
import { merge, type Entry, type MergeRule } from './merge';
import { AUTHOR_USER_ID } from '../models/schema';

/** The kit's inbox row, narrowed to what the drain actually reads. */
export interface DrainRow {
  id: number;
  kind: string;
  modelKey: string | null;
  entryId: string | null;
  op: string | null;
  sentAt: number | null;
  /**
   * The sending **user**, stamped by transport and accepted after Signal decryption.
   */
  senderUserId: string;
  /** The device whose Signal session decrypted this — cryptographic attribution, and the tie-break. */
  senderDeviceId: string | null;
  payload: string;
}

/** Why a row could not be processed. Carried into `discard(ids, reason)` and the security log. */
export type DiscardReason =
  | 'unknown-kind'
  | 'unknown-model'
  | 'missing-fields'
  | 'unparsable-payload'
  | 'unauthorized-sender';

/**
 * What the app knows about a model, as the drain needs it.
 *
 * The two optional rules are this app's **authorization** policy — the answer to "may *this* sender
 * write *this* entry". They are optional because they are not universal: `story` has neither, and
 * that is a real gap rather than an oversight (see `authorize`).
 */
export interface ModelRules {
  merge: MergeRule;
  /**
   * The payload field naming a 1:1 conversation. Set for conversation-scoped models: the id must be
   * canonical two-party and must name **both** this user and the authenticated sender.
   */
  conversationField?: string;
  /**
   * An entry-id prefix that binds an entry to its owner: the id MUST be
   * `${ownerIdPrefix}${senderUserId}`. Set for `profile`, whose id is guessable by construction.
   */
  ownerIdPrefix?: string;
}

/**
 * May this authenticated sender write this entry? `null` when yes.
 *
 * **Friendship is deliberately NOT required.** Any authenticated user can deliver to any device
 * (KIT_API §4.1), so a stranger's entry reaches the inbox no matter what — but a `discard` is
 * permanent data loss, and gating it on a friend graph that updates over a *different* message than
 * the entry itself would drop real mail on the accept/first-message race. The screens instead
 * resolve every name through the friend graph, so a stranger's entry is stored and never attributed
 * to anybody. What is checked here is narrower and unconditional: an entry must be consistent with
 * who actually sent it.
 *
 * `story` has no rule beyond attribution: it carries no id or field that binds it
 * to an author, so the authenticated sender becomes the author.
 */
function authorize(
  row: DrainRow,
  rules: ModelRules,
  data: Record<string, unknown>,
  selfUserId: string,
): DiscardReason | null {
  if (rules.ownerIdPrefix !== undefined && row.entryId !== rules.ownerIdPrefix + row.senderUserId) {
    return 'unauthorized-sender';
  }

  if (rules.conversationField !== undefined) {
    const raw = data[rules.conversationField];
    if (typeof raw !== 'string') return 'unauthorized-sender';
    // FORMAT, owned by `conversation.ts` and shared with the send side (`audience.ts`) so the two
    // directions cannot disagree about what a conversation id is.
    const participants = parseConversationId(raw);
    if (participants === null) return 'unauthorized-sender';
    // MEMBERSHIP, and it is stricter here than on the send side: the two participants must be ME and
    // the person who actually sent this. A conversation between two other people is not mine to
    // store, and a conversation between me and Alice is not something a stranger may write into.
    if (!participants.includes(selfUserId)) return 'unauthorized-sender';
    if (!participants.includes(row.senderUserId)) return 'unauthorized-sender';
  }

  return null;
}

export interface DrainPlan {
  /** Entries to write, grouped by model. Already merged against current state. */
  writes: Map<string, Entry[]>;
  /** Row ids safe to consume — every one of them is represented in `writes`. */
  consume: number[];
  /** Row ids that can never be processed, with the reason. Data loss, chosen out loud. */
  discard: Array<{ id: number; reason: DiscardReason }>;
}

/**
 * Decide what to do with a batch of inbox rows.
 *
 * `knownModels` is the app's schema: a `modelKey` outside it comes from a newer peer and cannot be
 * stored, because the app has nowhere to put it and no way to render it.
 *
 * `state` is the current entries per model, keyed by entry id — the merge input. It is not mutated.
 *
 * `selfUserId` is this device's authenticated user. It is required, not optional: the conversation
 * rule is meaningless without it, and defaulting it to `''` would silently authorize everything.
 */
export function planDrain(
  rows: readonly DrainRow[],
  knownModels: ReadonlyMap<string, ModelRules>,
  state: ReadonlyMap<string, ReadonlyMap<string, Entry>>,
  selfUserId: string,
): DrainPlan {
  const plan: DrainPlan = { writes: new Map(), consume: [], discard: [] };
  // Merge accumulates within the batch too: two rows touching one entry id must resolve against
  // each other, not just against what was already stored. Otherwise the second silently wins on
  // arrival order rather than on the merge rule.
  const working = new Map<string, Map<string, Entry>>();

  for (const row of rows) {
    // §4.1: an arm the kit did not recognise. The kit preserved it rather than destroying it, and
    // preserving it was right — but the app has no more idea what it is than the kit did.
    if (row.kind !== 'MODEL_SYNC') {
      plan.discard.push({ id: row.id, reason: 'unknown-kind' });
      continue;
    }

    // A newer peer's model. Not corrupt, just unreadable here.
    if (row.modelKey === null || !knownModels.has(row.modelKey)) {
      plan.discard.push({ id: row.id, reason: 'unknown-model' });
      continue;
    }

    // MODEL_SYNC-derived fields the merge cannot work without. `senderDeviceId` is the REPLACE
    // tie-break and must be the session-attributed device (NATIVE_CONTRACT §0.10 rule 4) — a row without one cannot
    // be ordered deterministically, so storing it would make two devices converge differently.
    // `senderUserId` is the authorization and attribution input: without it there is nothing to
    // check a claim against and nothing to attribute the entry to.
    if (
      row.entryId === null || row.sentAt === null ||
      row.senderDeviceId === null || row.senderUserId === ''
    ) {
      plan.discard.push({ id: row.id, reason: 'missing-fields' });
      continue;
    }

    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('payload is not a JSON object');
      }
      data = parsed as Record<string, unknown>;
    } catch {
      // A peer sent something this app cannot read. Not a crash and not a retry: retrying parses the
      // same bytes to the same failure forever, which is exactly how a drain wedges.
      plan.discard.push({ id: row.id, reason: 'unparsable-payload' });
      continue;
    }

    const model = row.modelKey;
    const rules = knownModels.get(model)!;

    const unauthorized = authorize(row, rules, data, selfUserId);
    if (unauthorized !== null) {
      plan.discard.push({ id: row.id, reason: unauthorized });
      continue;
    }

    const current = working.get(model) ?? new Map(state.get(model) ?? new Map());

    // ATTRIBUTION. The authenticated sender becomes the author — except when this device already
    // holds the entry, in which case the author it already recorded stands.
    //
    // The exception is what makes a REPLACE model with two legitimate writers work. A `pix` is
    // created by Alice and updated by Bob (the viewed-receipt), so on Alice's device Bob's update
    // must not flip the entry's author to Bob and turn "Bob viewed your pix" into "Bob sent you a
    // pix". The author is fixed by whoever this device saw first and is never taken from the
    // payload — a peer can put anything in `_authorUserId` and it is overwritten here every time.
    //
    // Known ordering wrinkle, and it is a mislabel rather than a leak: if Bob's receipt reaches
    // Alice's *second* device before Alice's own create does, that device records Bob as the author.
    // Both candidates are the conversation's two participants, which `authorize` has already pinned.
    const prior = current.get(row.entryId)?.data[AUTHOR_USER_ID];
    const entry: Entry = {
      id: row.entryId,
      sentAt: row.sentAt,
      authorDeviceId: row.senderDeviceId,
      data: {
        ...data,
        [AUTHOR_USER_ID]: typeof prior === 'string' ? prior : row.senderUserId,
      },
    };

    const next = merge(rules.merge, current, [entry]);
    working.set(model, next);
    plan.consume.push(row.id);

    // Record the write only if the merge actually took this entry. An APPEND duplicate, or a REPLACE
    // that lost on `(sentAt, authorDeviceId)`, changes nothing — writing it anyway would overwrite
    // the winner with the loser, because `entryPut` is a BLIND upsert by design (§8.1). The row is
    // still consumed: it was processed correctly, and the correct outcome was "keep what we have".
    if (next.get(entry.id) === entry) {
      const writes = plan.writes.get(model) ?? [];
      // Last write for an id wins within a batch — `next` already resolved the order, so replacing
      // an earlier queued write for the same id keeps one `entryPut` per entry rather than several.
      const existingIndex = writes.findIndex((w) => w.id === entry.id);
      if (existingIndex >= 0) writes[existingIndex] = entry;
      else writes.push(entry);
      plan.writes.set(model, writes);
    }
  }

  return plan;
}
