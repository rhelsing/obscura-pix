/**
 * **Vendored, not submoduled** (2026-07-30). These vectors used to be read from
 * `proto/conformance/merge.json` through the git submodule. `RESET.md`'s "The `merge.json` handover"
 * requires the opposite order: pix must be reading a LOCAL copy before the file is deleted from
 * obscura-proto, or the deletion breaks pix's only merge coverage the day it lands.
 *
 * They stop being a cross-implementation contract the moment the kits' merge engine is deleted —
 * one implementation left means a fixture, not a contract. This is that transition, done in the
 * order the document asks for.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { mergeAll, type Entry, type MergeRule } from '../merge';

/**
 * `obscura-proto/conformance/merge.json`, run against this app's merge implementation.
 *
 * **Why these vectors live here now.** They pinned behaviour the KITS implemented, and the kits'
 * engine was deleted on 2026-07-31 — so they were ported BEFORE the deletion, while there was still
 * something to check the TypeScript against. There is now exactly one implementation left, which is
 * why `conformance/merge.json` stopped being a contract and became this repo's fixture
 * (`obscura-proto/KIT_API.md` §8.2, "merge.json is a contract today and a fixture tomorrow").
 *
 * **The port is partial, and deliberately explicit about it.** Four of the six cases carry over;
 * two pin tombstone semantics that retired with `deleteEntry` (zero callers in this app, and now
 * absent from the bridge entirely). Those two are asserted as *recognised and retired* rather than
 * quietly filtered out — a port that silently drops half a contract is how a contract stops being
 * one.
 */

const VECTORS = join(__dirname, '../__fixtures__/merge.json');

interface VectorOp {
  id: string;
  ts: number;
  authorDeviceId: string;
  data: Record<string, unknown>;
}
interface VectorCase {
  name: string;
  sync: 'gset' | 'lww';
  applyOrders: string[];
  ops: VectorOp[];
  /** Cases assert different field sets: GSet asserts id/data, LWW also asserts the winning device. */
  expect: {
    entries: Array<{ id: string; authorDeviceId?: string; data?: Record<string, unknown> }>;
  };
}

const suite: { cases: VectorCase[] } = JSON.parse(readFileSync(VECTORS, 'utf8'));

/** The kit's wire vocabulary -> this app's. `gset`/`lww` are the CRDT names being retired. */
const RULE: Record<string, MergeRule> = { gset: 'APPEND', lww: 'REPLACE' };

const toEntry = (op: VectorOp): Entry => ({
  id: op.id,
  sentAt: op.ts,
  authorDeviceId: op.authorDeviceId,
  data: op.data,
});

const isTombstoneCase = (c: VectorCase) =>
  c.ops.some((op) => Object.prototype.hasOwnProperty.call(op.data, '_deleted'));

const portable = suite.cases.filter((c) => !isTombstoneCase(c));
const retired = suite.cases.filter(isTombstoneCase);

describe('merge.json conformance', () => {
  it('the vector file is present and was not silently emptied', () => {
    // Guards the port itself: a wrong path or a renamed file would otherwise make every
    // vector-driven test below vacuously pass by iterating an empty list.
    expect(suite.cases.length).toBe(6);
    expect(portable.length).toBe(4);
    expect(retired.length).toBe(2);
  });

  describe.each(portable.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const rule = RULE[testCase.sync];

    it.each(testCase.applyOrders)('applied in %s order', (order) => {
      const ops = testCase.ops.map(toEntry);
      const applied = order === 'reverse' ? [...ops].reverse() : ops;

      const state = mergeAll(rule, applied);

      // Compare exactly the fields each expectation states — the LWW cases assert the winning
      // `authorDeviceId`, which IS the tie-break assertion, while the GSet cases assert only
      // `id`/`data`. Projecting to a fixed shape would either fail spuriously on the former or
      // silently skip the property the vector exists to pin.
      const expected = [...testCase.expect.entries].sort((a, b) => a.id.localeCompare(b.id));
      const byId = new Map([...state.values()].map((e) => [e.id, e]));

      // Count first: projection compares the entries the vector names, so an extra entry in the
      // merged state would otherwise go unnoticed.
      expect(byId.size).toBe(expected.length);

      const actual = expected.map((exp) => {
        const got = byId.get(exp.id);
        expect(got).toBeDefined();
        const projected: Record<string, unknown> = { id: got!.id };
        if ('authorDeviceId' in exp) projected.authorDeviceId = got!.authorDeviceId;
        if ('data' in exp) projected.data = got!.data;
        return projected;
      });

      expect(actual).toEqual(expected);
    });

    it('converges: forward and reverse produce identical state', () => {
      // The property the applyOrders exist to check, asserted directly rather than inferred from
      // two separate passes both matching a fixture.
      const ops = testCase.ops.map(toEntry);
      const forward = mergeAll(rule, ops);
      const reverse = mergeAll(rule, [...ops].reverse());
      expect([...forward.entries()].sort()).toEqual([...reverse.entries()].sort());
    });
  });

  it('the two tombstone cases are retired with deletes, not accidentally dropped', () => {
    // SPEC §2.3 was DELETED with tombstones: `deleteEntry` had zero callers in this app and is now
    // gone from the bridge on all three surfaces, so the whole tombstone-ordering design was dead on
    // arrival. Naming them here means the port is a decision with a record, not an omission someone
    // discovers later.
    expect(retired.map((c) => c.name)).toEqual([
      'LWW newer tombstone wins: a later delete removes the entry, order-independent',
      'LWW stale write does not resurrect a newer tombstone, order-independent',
    ]);
  });
});
