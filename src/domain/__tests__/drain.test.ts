import { planDrain, type DrainRow } from '../drain';
import type { Entry, MergeRule } from '../merge';

/**
 * The drain plan (`obscura-proto/KIT_API.md` §3, §4.1).
 *
 * Every assertion here is about **not losing a message**. An inbox row is the only copy — the kit
 * already acked, so the server deleted its own — which makes "consume" irreversible and makes the
 * difference between `consume`, `discard` and *neither* the whole subject of this file.
 */

const models = new Map<string, MergeRule>([
  ['directMessage', 'APPEND'],
  ['story', 'APPEND'],
  ['pix', 'REPLACE'],
  ['profile', 'REPLACE'],
]);

let nextId = 1;
function row(over: Partial<DrainRow> = {}): DrainRow {
  return {
    id: nextId++,
    kind: 'MODEL_SYNC',
    modelKey: 'directMessage',
    entryId: `entry_${nextId}`,
    op: 'CREATE',
    sentAt: 1_000,
    senderDeviceId: 'device_peer',
    payload: JSON.stringify({ content: 'hi' }),
    ...over,
  };
}

beforeEach(() => {
  nextId = 1;
});

const empty = new Map<string, ReadonlyMap<string, Entry>>();

describe('the happy path', () => {
  it('merges a row and consumes it', () => {
    const r = row({ entryId: 'dm_1' });

    const plan = planDrain([r], models, empty);

    expect(plan.consume).toEqual([r.id]);
    expect(plan.discard).toEqual([]);
    expect(plan.writes.get('directMessage')).toEqual([
      { id: 'dm_1', sentAt: 1_000, authorDeviceId: 'device_peer', data: { content: 'hi' } },
    ]);
  });

  it('carries the authenticated sender device as the merge tie-break, not anything from the payload', () => {
    const r = row({
      entryId: 'p_1',
      modelKey: 'pix',
      senderDeviceId: 'device_authenticated',
      payload: JSON.stringify({ authorDeviceId: 'device_CLAIMED_BY_PEER' }),
    });

    const plan = planDrain([r], models, empty);

    expect(plan.writes.get('pix')?.[0].authorDeviceId).toBe('device_authenticated');
  });

  it('records a DELETE as the app-level tombstone the app understands', () => {
    const r = row({ entryId: 'dm_1', op: 'DELETE' });

    const plan = planDrain([r], models, empty);

    expect(plan.writes.get('directMessage')?.[0].data).toEqual({ content: 'hi', _deleted: true });
  });
});

describe('rows the app cannot process', () => {
  /**
   * §4.1: the kit inboxes an unknown arm rather than destroying it, because declining to ack
   * composes with the server's oldest-first eviction into a remote wipe. But the app has no more
   * idea what it is than the kit did — so it says so, out loud, and the row leaves the queue.
   */
  it('discards an unknown kind rather than skipping it', () => {
    const r = row({ kind: 'UNKNOWN', modelKey: null, entryId: null });

    const plan = planDrain([r], models, empty);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'unknown-kind' }]);
    expect(plan.consume).toEqual([]);
  });

  it('discards a model this version of the app does not know', () => {
    const r = row({ modelKey: 'somethingNewer' });

    const plan = planDrain([r], models, empty);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'unknown-model' }]);
  });

  it('discards a payload that is not a JSON object', () => {
    const notObject = planDrain([row({ payload: '"just a string"' })], models, empty);
    const notJSON = planDrain([row({ payload: '{{{' })], models, empty);

    expect(notObject.discard[0].reason).toBe('unparsable-payload');
    expect(notJSON.discard[0].reason).toBe('unparsable-payload');
  });

  /**
   * `senderDeviceId` is the REPLACE tie-break and must be the AUTHENTICATED device (SPEC §0.10
   * rule 4). Without it two devices receiving the same pair of writes in different orders converge
   * to different states — silently, and invisibly to single-device testing.
   */
  it('discards a row with no authenticated sender device', () => {
    const r = row({ senderDeviceId: null });

    const plan = planDrain([r], models, empty);

    expect(plan.discard).toEqual([{ id: r.id, reason: 'missing-fields' }]);
  });

  /**
   * **The property the whole design rests on: every row is accounted for.** A row that is neither
   * consumed nor discarded stays at the head of the queue forever — `inboxDepth()` never reaches
   * zero and the drain wedges, because §3.4 deferred the `after:` cursor on the explicit condition
   * that the app never skips.
   */
  it('accounts for every row — nothing is silently skipped', () => {
    const rows = [
      row({ entryId: 'ok_1' }),
      row({ kind: 'UNKNOWN' }),
      row({ modelKey: 'unknownModel' }),
      row({ payload: 'not json' }),
      row({ senderDeviceId: null }),
      row({ entryId: 'ok_2' }),
    ];

    const plan = planDrain(rows, models, empty);

    const accounted = [...plan.consume, ...plan.discard.map((d) => d.id)].sort((a, b) => a - b);
    expect(accounted).toEqual(rows.map((r) => r.id));
  });
});

describe('merging within a batch', () => {
  /**
   * Two rows touching one entry must resolve against **each other**, not just against stored state.
   * Otherwise the second silently wins on arrival order rather than on the merge rule — the
   * divergence `SPEC.md` §2.2 describes, reachable inside a single `peek`.
   */
  it('resolves two rows for the same entry by the rule, not by arrival order', () => {
    const older = row({ modelKey: 'pix', entryId: 'p', sentAt: 1_000, payload: JSON.stringify({ v: 'old' }) });
    const newer = row({ modelKey: 'pix', entryId: 'p', sentAt: 9_000, payload: JSON.stringify({ v: 'new' }) });

    const forward = planDrain([older, newer], models, empty);
    const reverse = planDrain([newer, older], models, empty);

    expect(forward.writes.get('pix')).toHaveLength(1);
    expect(forward.writes.get('pix')?.[0].data).toEqual({ v: 'new' });
    expect(reverse.writes.get('pix')?.[0].data).toEqual({ v: 'new' });
  });

  /**
   * A losing write must not be queued. `entryPut` is a BLIND upsert (§8.1) — the app decides who
   * wins — so writing the loser after the winner would overwrite the winner with it. Consuming it is
   * still right: the row WAS processed, and the correct outcome was "keep what we have".
   */
  it('consumes but does not write a row that loses the merge', () => {
    const stored: Entry = { id: 'p', sentAt: 9_000, authorDeviceId: 'device_x', data: { v: 'stored' } };
    const state = new Map([['pix', new Map([['p', stored]])]]);
    const loser = row({ modelKey: 'pix', entryId: 'p', sentAt: 1_000, payload: JSON.stringify({ v: 'older' }) });

    const plan = planDrain([loser], models, state);

    expect(plan.consume).toEqual([loser.id]);
    expect(plan.writes.get('pix') ?? []).toEqual([]);
  });

  /** APPEND is first-write-wins, so a redelivered duplicate must not overwrite the original. */
  it('keeps the first write for an APPEND model', () => {
    const first: Entry = { id: 'dm', sentAt: 1_000, authorDeviceId: 'd', data: { content: 'first' } };
    const state = new Map([['directMessage', new Map([['dm', first]])]]);
    const dup = row({ entryId: 'dm', sentAt: 9_000, payload: JSON.stringify({ content: 'second' }) });

    const plan = planDrain([dup], models, state);

    expect(plan.consume).toEqual([dup.id]);
    expect(plan.writes.get('directMessage') ?? []).toEqual([]);
  });

  /**
   * Reprocessing must converge, because `peek` is side-effect free and a crash between peek and
   * consume means the same rows come back. That is the crash-safety property the design trades for.
   */
  it('is idempotent — draining the same batch twice reaches the same state', () => {
    const rows = [
      row({ modelKey: 'pix', entryId: 'p', sentAt: 1_000, payload: JSON.stringify({ v: 'a' }) }),
      row({ modelKey: 'pix', entryId: 'p', sentAt: 9_000, payload: JSON.stringify({ v: 'b' }) }),
    ];

    const first = planDrain(rows, models, empty);
    const afterFirst = new Map([
      ['pix', new Map((first.writes.get('pix') ?? []).map((e) => [e.id, e] as const))],
    ]);
    const second = planDrain(rows, models, afterFirst);

    expect(first.writes.get('pix')?.[0].data).toEqual({ v: 'b' });
    // Second pass changes nothing — the winner already won.
    expect(second.writes.get('pix') ?? []).toEqual([]);
    expect(second.consume).toEqual(rows.map((r) => r.id));
  });

  it('queues one write per entry id, not one per row', () => {
    const rows = [
      row({ modelKey: 'pix', entryId: 'p', sentAt: 1_000, payload: JSON.stringify({ v: 1 }) }),
      row({ modelKey: 'pix', entryId: 'p', sentAt: 2_000, payload: JSON.stringify({ v: 2 }) }),
      row({ modelKey: 'pix', entryId: 'p', sentAt: 3_000, payload: JSON.stringify({ v: 3 }) }),
    ];

    const plan = planDrain(rows, models, empty);

    expect(plan.writes.get('pix')).toHaveLength(1);
    expect(plan.writes.get('pix')?.[0].data).toEqual({ v: 3 });
    expect(plan.consume).toHaveLength(3);
  });
});

describe('the empty case', () => {
  it('plans nothing for no rows', () => {
    const plan = planDrain([], models, empty);

    expect(plan.consume).toEqual([]);
    expect(plan.discard).toEqual([]);
    expect(plan.writes.size).toBe(0);
  });
});
