import { Obscura, onObscuraEvent, conversationId, type ObscuraEvent } from '../ObscuraModule';
import { getFakeBridge } from '../__fixtures__/reactNativeMock';

/**
 * The bridge boundary, exercised through the real `ObscuraModule.ts` against the in-memory kit
 * double.
 *
 * **Every assertion here was unreachable before the double existed.** Under the old noop `Proxy`,
 * every bridge call resolved `null` and `onObscuraEvent` returned a no-op unsubscribe having
 * subscribed to nothing — so a test of any of this would have passed while asserting nothing. The
 * first test below is the proof of that, and it is deliberately first.
 *
 * Rewritten 2026-07-30: these used to drive `defineModels` / `createEntry` / `allEntries`, which no
 * longer exist on either kit (§10 step 4). The same properties are now checked against the surface
 * that replaced them — `entryPut` / `entryAll` / `inboxPeek` / `sendEntry`.
 */

const bridge = getFakeBridge();

describe('the double is actually installed', () => {
  /**
   * The regression this whole fixture exists to prevent: if `ObscuraModule` ever falls back to its
   * noop `Proxy` again — a changed module name, a broken `jest.mock`, a renamed export — every other
   * test in this file keeps passing while asserting nothing at all. This one fails instead.
   */
  it('resolves real values, not the noop Proxy that resolves null', async () => {
    await Obscura.entryPut('directMessage', 'dm_1', JSON.stringify({ content: 'hi' }), 1_000, 'device_a');

    const stored = await Obscura.entryAll('directMessage');
    expect(stored).toHaveLength(1);
    expect(bridge.__calls).toContain('entryPut');
  });

  it('delivers events, which the noop emitter never did', () => {
    const seen: ObscuraEvent[] = [];
    const off = onObscuraEvent((e) => seen.push(e));

    bridge.__setConnectionState('connected');

    expect(seen).toEqual([{ type: 'connectionChanged', state: 'connected' }]);
    off();
  });

  it('stops delivering after unsubscribe, so a test cannot leak into the next', () => {
    const seen: ObscuraEvent[] = [];
    const off = onObscuraEvent((e) => seen.push(e));

    // Deliver one BEFORE unsubscribing. Without it this passes vacuously in a world where no event
    // is ever delivered — which is precisely the world this fixture exists to leave behind.
    bridge.__setConnectionState('connecting');
    expect(seen).toHaveLength(1);

    off();
    bridge.__setConnectionState('connected');

    expect(seen).toHaveLength(1);
    expect(bridge.__listenerCount()).toBe(0);
  });
});

describe('the JSON boundary', () => {
  /**
   * `data` and `payload` cross as opaque JSON **strings** in both directions. That is the whole
   * point of the new surface: the kit stores bytes it does not parse, so what comes back is what
   * went in — byte for byte, not re-serialised.
   *
   * The old bridge did the opposite. `entryToMap` flattened a map field by field and fell back to
   * `v.toString()` for anything that was not a String/Number/Boolean, so nested objects and arrays
   * arrived as their Kotlin `toString`. The nested-payload test below is the one that would have
   * caught it.
   */
  it('round-trips a payload the kit never parses', async () => {
    const data = { conversationId: 'a_b', content: 'hello', senderUsername: 'alice' };

    await Obscura.entryPut('directMessage', 'dm_1', JSON.stringify(data), 1_000, 'device_a');

    const [stored] = await Obscura.entryAll('directMessage');
    expect(JSON.parse(stored.data)).toEqual(data);
    expect(stored.authorDeviceId).toBe('device_a');
  });

  it('round-trips nested and unicode payloads without mangling them', async () => {
    const captionMeta = JSON.stringify({ style: 'bold', x: 0.5, colour: '#fff' });
    const data = { content: 'sunset 🌅', captionMeta, tags: ['a', 'b'], meta: { nested: true } };

    await Obscura.entryPut('story', 's_1', JSON.stringify(data), 2_000, 'device_a');

    const [stored] = await Obscura.entryAll('story');
    expect(JSON.parse(stored.data)).toEqual(data);
  });

  it('rejects a non-string payload, so a forgotten stringify fails here not on device', async () => {
    await expect(
      // @ts-expect-error — deliberately passing the wrong type; TS would normally stop this, but the
      // real bridge is untyped `any` at runtime, which is exactly why the double checks.
      Obscura.entryPut('story', 's_1', { notAString: true }, 1_000, 'device_a'),
    ).rejects.toThrow(/JSON string/);
  });
});

describe('the entry store', () => {
  it('keeps models separate', async () => {
    await Obscura.entryPut('directMessage', 'a', '{}', 1, 'd');
    await Obscura.entryPut('story', 'b', '{}', 1, 'd');

    expect(await Obscura.entryAll('directMessage')).toHaveLength(1);
    expect(await Obscura.entryAll('story')).toHaveLength(1);
    expect(await Obscura.entryAll('profile')).toEqual([]);
  });

  /**
   * `entryPut` is a **blind** upsert by contract (`KIT_API.md` §8.1) — the app decides who wins, so
   * an older write replaces a newer one. A double that merged here would hide an app that forgot to.
   */
  it('is a blind upsert — an older write overwrites a newer one', async () => {
    await Obscura.entryPut('pix', 'p', JSON.stringify({ v: 'new' }), 9_000, 'd');
    await Obscura.entryPut('pix', 'p', JSON.stringify({ v: 'old' }), 1_000, 'd');

    const [stored] = await Obscura.entryAll('pix');
    expect(JSON.parse(stored.data)).toEqual({ v: 'old' });
    expect(stored.sentAt).toBe(1_000);
  });

  it('deletes', async () => {
    await Obscura.entryPut('story', 's', '{}', 1, 'd');

    await Obscura.entryDelete('story', 's');

    expect(await Obscura.entryAll('story')).toEqual([]);
  });
});

describe('the inbox', () => {
  it('peeks without consuming, so a crash mid-drain reprocesses rather than loses', async () => {
    bridge.__deliverInbox({ entryId: 'dm_1', payload: '{}' });

    const first = await Obscura.inboxPeek();
    const second = await Obscura.inboxPeek();

    expect(first).toHaveLength(1);
    expect(second).toEqual(first);
    expect(await Obscura.inboxDepth()).toBe(1);
  });

  it('consumes only what it is given', async () => {
    const a = bridge.__deliverInbox({ entryId: 'a', payload: '{}' });
    bridge.__deliverInbox({ entryId: 'b', payload: '{}' });

    await Obscura.inboxConsume([a.id]);

    expect(await Obscura.inboxDepth()).toBe(1);
  });

  /** Data loss chosen out loud: the reason must reach the kit, which logs it as a security event. */
  it('carries a reason into discard', async () => {
    const row = bridge.__deliverInbox({ kind: 'UNKNOWN', payload: 'x' });

    await Obscura.inboxDiscard([row.id], 'unknown-kind');

    expect(bridge.__discarded).toEqual([{ ids: [row.id], reason: 'unknown-kind' }]);
    expect(await Obscura.inboxDepth()).toBe(0);
  });
});

describe('failures', () => {
  /**
   * Without an injectable failure every `.catch(...)` in the app is dead code under test, because
   * every bridge call resolves.
   */
  it('rejects with a code the app can branch on', async () => {
    bridge.__failNext('sendEntry', 'DIRECT_ROUTING_UNRESOLVED', 'no recipient');

    await expect(Obscura.sendEntry([], 'directMessage', 'x', 'CREATE', 1, '{}'))
      .rejects.toMatchObject({ code: 'DIRECT_ROUTING_UNRESOLVED' });
  });

  it('fails only the next call, so a suite is not poisoned by one injection', async () => {
    bridge.__failNext('entryPut', 'ENTRY_PUT_ERROR');

    await expect(Obscura.entryPut('story', 'a', '{}', 1, 'd')).rejects.toThrow();
    await expect(Obscura.entryPut('story', 'b', '{}', 1, 'd')).resolves.toBeUndefined();
  });
});

describe('conversationId', () => {
  /**
   * Not bridge-mediated, but load-bearing for everything that is: the id must be identical computed
   * from either side, because it is both the audience key and the REPLACE grouping for `pix`.
   */
  it('is the same from both sides', () => {
    expect(conversationId('bbb', 'aaa')).toBe(conversationId('aaa', 'bbb'));
    expect(conversationId('aaa', 'bbb')).toBe('aaa_bbb');
  });
});
