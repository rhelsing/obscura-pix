/**
 * Draining the kit's inbox (`obscura-proto/KIT_API.md` §3).
 *
 * This is the app's half of the reset: the kit stores bytes it cannot read, and this decides what
 * they mean. It is the second piece of domain logic to move out of the kits, after `merge.ts`.
 *
 * ## The contract, and why each step is where it is
 *
 * ```
 * peek(limit) → for each row: classify → merge → put → consume | discard
 * ```
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

import { merge, type Entry, type MergeRule } from './merge';

/** The kit's inbox row, narrowed to what the drain actually reads. */
export interface DrainRow {
  id: number;
  kind: string;
  modelKey: string | null;
  entryId: string | null;
  op: string | null;
  sentAt: number | null;
  senderDeviceId: string | null;
  payload: string;
}

/** Why a row could not be processed. Carried into `discard(ids, reason)` and the security log. */
export type DiscardReason =
  | 'unknown-kind'
  | 'unknown-model'
  | 'missing-fields'
  | 'unparsable-payload';

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
 */
export function planDrain(
  rows: readonly DrainRow[],
  knownModels: ReadonlyMap<string, MergeRule>,
  state: ReadonlyMap<string, ReadonlyMap<string, Entry>>,
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
    // tie-break and must be the AUTHENTICATED device (SPEC §0.10 rule 4) — a row without one cannot
    // be ordered deterministically, so storing it would make two devices converge differently.
    if (row.entryId === null || row.sentAt === null || row.senderDeviceId === null) {
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
    const rule = knownModels.get(model)!;
    const entry: Entry = {
      id: row.entryId,
      sentAt: row.sentAt,
      authorDeviceId: row.senderDeviceId,
      // A DELETE arrives as an entry the app records as deleted. The kit no longer has an opinion
      // about tombstones — this is the app's `_deleted` convention, in the app's own payload.
      data: row.op === 'DELETE' ? { ...data, _deleted: true } : data,
    };

    const current = working.get(model) ?? new Map(state.get(model) ?? new Map());
    const next = merge(rule, current, [entry]);
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
