/**
 * Local fixtures for the application-owned merge implementation.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { mergeAll, type Entry, type MergeRule } from '../merge';

/**
 * `obscura-proto/conformance/merge.json`, run against this app's merge implementation.
 *
 * Four cases cover the current APPEND and REPLACE rules. Two tombstone cases are
 * recognized but unsupported because the app has no delete operation.
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

/** Fixture vocabulary mapped to the app's merge rules. */
const RULE: Record<string, MergeRule> = { gset: 'APPEND', lww: 'REPLACE' };

const toEntry = (op: VectorOp): Entry => ({
  id: op.id,
  sentAt: op.ts,
  authorDeviceId: op.authorDeviceId,
  data: op.data,
});

const isTombstoneCase = (c: VectorCase) =>
  c.ops.some((op) => Object.prototype.hasOwnProperty.call(op.data, '_deleted'));

const supported = suite.cases.filter((c) => !isTombstoneCase(c));
const tombstones = suite.cases.filter(isTombstoneCase);

describe('merge.json conformance', () => {
  it('the vector file is present and was not silently emptied', () => {
    // Guards the port itself: a wrong path or a renamed file would otherwise make every
    // vector-driven test below vacuously pass by iterating an empty list.
    expect(suite.cases.length).toBe(6);
    expect(supported.length).toBe(4);
    expect(tombstones.length).toBe(2);
  });

  describe.each(supported.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
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

  it('recognizes the unsupported tombstone cases', () => {
    expect(tombstones.map((c) => c.name)).toEqual([
      'LWW newer tombstone wins: a later delete removes the entry, order-independent',
      'LWW stale write does not resurrect a newer tombstone, order-independent',
    ]);
  });
});
