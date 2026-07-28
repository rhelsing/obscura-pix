import { drainInbox, drainInboxFully } from '../drainInbox';
import { Obscura } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

/**
 * The drain, end to end against the in-memory kit double.
 *
 * `drain.test.ts` covers the decision; this covers the **effects and their order**, which is the
 * part that can destroy a message. An inbox row is the only copy — the kit already acked, so the
 * server deleted its own — so "consume" is irreversible and everything here is about what happens
 * before it.
 *
 * None of this was testable before the double existed: every bridge call resolved `null`.
 */

const bridge = getFakeBridge();

describe('draining', () => {
  it('writes the entry and consumes the row', async () => {
    bridge.__deliverInbox({
      modelKey: 'directMessage',
      entryId: 'dm_1',
      payload: JSON.stringify({ conversationId: 'a_b', content: 'hello' }),
    });

    const result = await drainInbox();

    expect(result).toMatchObject({ written: 1, consumed: 1, discarded: 0, touched: ['directMessage'] });
    expect(await Obscura.inboxDepth()).toBe(0);
    const stored = await Obscura.entryAll('directMessage');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].data)).toEqual({ conversationId: 'a_b', content: 'hello' });
  });

  it('preserves the authenticated sender device as the stored tie-break', async () => {
    bridge.__deliverInbox({
      modelKey: 'pix', entryId: 'p_1', senderDeviceId: 'device_authenticated',
      payload: JSON.stringify({ viewedAt: 0 }),
    });

    await drainInbox();

    expect((await Obscura.entryAll('pix'))[0].authorDeviceId).toBe('device_authenticated');
  });

  it('does nothing when the inbox is empty', async () => {
    const result = await drainInbox();

    expect(result).toEqual({ written: 0, consumed: 0, discarded: 0, touched: [] });
    expect(bridge.__calls).not.toContain('entryPut');
  });
});

describe('the effect ORDER', () => {
  /**
   * **The load-bearing test.** The row must be written before it is consumed, because consuming
   * destroys the only copy. Asserted on the actual call sequence rather than on the end state,
   * because the end state looks identical either way — and looks identical right up until a write
   * fails.
   */
  it('writes the entry BEFORE consuming the row', async () => {
    bridge.__deliverInbox({ entryId: 'dm_1', payload: JSON.stringify({ content: 'x' }) });

    await drainInbox();

    const put = bridge.__calls.indexOf('entryPut');
    const consume = bridge.__calls.indexOf('inboxConsume');
    expect(put).toBeGreaterThanOrEqual(0);
    expect(consume).toBeGreaterThan(put);
  });

  /**
   * The consequence of that order, and the reason it is worth enforcing: if the write fails, the row
   * is still in the inbox, so the next drain reprocesses it. Nothing is lost. That is safe only
   * because `peek` is side-effect free and `merge` is idempotent.
   */
  it('leaves the row in the inbox when the write fails', async () => {
    bridge.__deliverInbox({ entryId: 'dm_1', payload: JSON.stringify({ content: 'x' }) });
    bridge.__failNext('entryPut', 'ENTRY_PUT_ERROR', 'disk full');

    await expect(drainInbox()).rejects.toThrow();

    expect(await Obscura.inboxDepth()).toBe(1);
    expect(bridge.__calls).not.toContain('inboxConsume');
  });

  it('recovers on the next drain after a failed write', async () => {
    bridge.__deliverInbox({ entryId: 'dm_1', payload: JSON.stringify({ content: 'x' }) });
    bridge.__failNext('entryPut', 'ENTRY_PUT_ERROR');
    await expect(drainInbox()).rejects.toThrow();

    const result = await drainInbox();

    expect(result).toMatchObject({ written: 1, consumed: 1 });
    expect(await Obscura.inboxDepth()).toBe(0);
    expect(await Obscura.entryAll('directMessage')).toHaveLength(1);
  });
});

describe('rows the app cannot process', () => {
  /**
   * §4.1's rule, and the condition §3.4's deferral of the `after:` cursor rests on: an unprocessable
   * row must be DISCARDED, not skipped. Skipped, it sits at the head of the queue forever and the
   * drain wedges — `inboxDepth()` never reaches zero.
   */
  it('discards an unknown kind and empties the inbox', async () => {
    bridge.__deliverInbox({ kind: 'SOMETHING_NEWER', modelKey: null, entryId: null, payload: 'opaque' });

    const result = await drainInbox();

    expect(result.discarded).toBe(1);
    expect(await Obscura.inboxDepth()).toBe(0);
    expect(bridge.__discarded).toEqual([{ ids: [expect.any(Number)], reason: 'unknown-kind' }]);
  });

  it('discards with a reason the kit can log, grouped by reason', async () => {
    bridge.__deliverInbox({ kind: 'UNKNOWN_A', modelKey: null, entryId: null, payload: 'x' });
    bridge.__deliverInbox({ kind: 'UNKNOWN_B', modelKey: null, entryId: null, payload: 'y' });
    bridge.__deliverInbox({ modelKey: 'notAModel', payload: '{}' });

    await drainInbox();

    const reasons = bridge.__discarded.map((d) => d.reason).sort();
    expect(reasons).toEqual(['unknown-kind', 'unknown-model']);
    // Two unknown-kind rows, one call.
    expect(bridge.__discarded.find((d) => d.reason === 'unknown-kind')?.ids).toHaveLength(2);
  });

  it('processes the good rows in a batch that also contains bad ones', async () => {
    bridge.__deliverInbox({ entryId: 'ok_1', payload: JSON.stringify({ content: 'a' }) });
    bridge.__deliverInbox({ kind: 'UNKNOWN', modelKey: null, entryId: null, payload: 'x' });
    bridge.__deliverInbox({ entryId: 'ok_2', payload: JSON.stringify({ content: 'b' }) });

    const result = await drainInbox();

    expect(result).toMatchObject({ written: 2, consumed: 2, discarded: 1 });
    expect(await Obscura.inboxDepth()).toBe(0);
  });
});

describe('merging against what is already stored', () => {
  it('does not overwrite a newer entry with an older redelivered one', async () => {
    await Obscura.entryPut('pix', 'p', JSON.stringify({ v: 'newer' }), 9_000, 'device_a');
    bridge.__deliverInbox({
      modelKey: 'pix', entryId: 'p', sentAt: 1_000, payload: JSON.stringify({ v: 'older' }),
    });

    const result = await drainInbox();

    // Consumed — it WAS processed, and the right outcome was "keep what we have".
    expect(result).toMatchObject({ written: 0, consumed: 1 });
    expect(JSON.parse((await Obscura.entryAll('pix'))[0].data)).toEqual({ v: 'newer' });
  });

  it('keeps the first write for an APPEND model when a duplicate arrives', async () => {
    await Obscura.entryPut('directMessage', 'dm', JSON.stringify({ content: 'first' }), 1_000, 'd');
    bridge.__deliverInbox({
      entryId: 'dm', sentAt: 9_000, payload: JSON.stringify({ content: 'second' }),
    });

    await drainInbox();

    expect(JSON.parse((await Obscura.entryAll('directMessage'))[0].data)).toEqual({ content: 'first' });
  });

  /**
   * Draining twice must reach the same state, because a crash between peek and consume means the
   * same rows come back. This is the property that makes write-before-consume safe rather than
   * merely careful.
   */
  it('is idempotent across a re-drain of the same rows', async () => {
    const row = {
      modelKey: 'pix' as const, entryId: 'p', sentAt: 5_000,
      payload: JSON.stringify({ v: 'once' }),
    };
    bridge.__deliverInbox(row);
    await drainInbox();

    // The kit redelivers and the app reprocesses.
    bridge.__deliverInbox(row);
    await drainInbox();

    const stored = await Obscura.entryAll('pix');
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0].data)).toEqual({ v: 'once' });
  });
});

describe('draining fully', () => {
  it('keeps going until the inbox is empty', async () => {
    for (let i = 0; i < 12; i += 1) {
      bridge.__deliverInbox({ entryId: `dm_${i}`, payload: JSON.stringify({ content: `m${i}` }) });
    }

    const result = await drainInboxFully(5);

    expect(result.consumed).toBe(12);
    expect(await Obscura.inboxDepth()).toBe(0);
    expect(await Obscura.entryAll('directMessage')).toHaveLength(12);
  });

  it('reports every model it touched, once', async () => {
    bridge.__deliverInbox({ modelKey: 'directMessage', entryId: 'a', payload: '{}' });
    bridge.__deliverInbox({ modelKey: 'story', entryId: 'b', payload: '{}' });
    bridge.__deliverInbox({ modelKey: 'directMessage', entryId: 'c', payload: '{}' });

    const result = await drainInboxFully(1);

    expect(result.touched.sort()).toEqual(['directMessage', 'story']);
  });

  it('terminates on an inbox of only undrainable rows', async () => {
    bridge.__deliverInbox({ kind: 'UNKNOWN', modelKey: null, entryId: null, payload: 'x' });

    const result = await drainInboxFully(5);

    expect(result.discarded).toBe(1);
    expect(await Obscura.inboxDepth()).toBe(0);
  });
});
