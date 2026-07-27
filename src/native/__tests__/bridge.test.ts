/**
 * The bridge boundary, exercised through the real `ObscuraModule.ts` against the in-memory kit
 * double.
 *
 * **Every one of these assertions was unreachable before the double existed.** Under the old noop
 * `Proxy`, `Obscura.createEntry(...)` resolved `null` and `onObscuraEvent(...)` returned a no-op
 * unsubscribe having subscribed to nothing — so a test of any of this would have passed while
 * asserting nothing. The first test below is the proof of that, and it is deliberately first.
 */

import { Obscura, onObscuraEvent, conversationId, type ObscuraEvent } from '../ObscuraModule';
import { getFakeBridge } from '../__fixtures__/reactNativeMock';
import { obscuraSchema } from '../../models/schema';

const bridge = getFakeBridge();

describe('the double is actually installed', () => {
  /**
   * The regression this whole fixture exists to prevent: if `ObscuraModule` ever falls back to its
   * noop `Proxy` again — a changed module name, a broken `jest.mock`, a renamed export — every
   * other test in this file keeps passing while asserting nothing at all. This one fails instead.
   */
  it('resolves real values, not the noop Proxy that resolves null', async () => {
    await Obscura.defineModels(obscuraSchema);
    const entry = await Obscura.createEntry('directMessage', { content: 'hi' });

    expect(entry).not.toBeNull();
    expect(entry.id).toEqual(expect.any(String));
    expect(bridge.__calls).toContain('createEntry');
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

    // Deliver one BEFORE unsubscribing. Without it this test passes vacuously in a world where no
    // event is ever delivered — which is precisely the world this fixture exists to leave behind.
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
   * `defineModels`, `createEntry`, `upsertEntry` and `queryEntries` stringify their payload in the
   * wrapper and the native side parses it. The double rejects a non-string for exactly those four,
   * so dropping a `JSON.stringify` is a test failure rather than a runtime surprise on device —
   * where it surfaces as a native type-conversion error with no TypeScript to catch it.
   */
  it('passes model data across as a JSON string and gets a structured entry back', async () => {
    await Obscura.defineModels(obscuraSchema);
    const entry = await Obscura.createEntry('directMessage', {
      conversationId: 'a_b',
      content: 'hello',
      senderUsername: 'alice',
    });

    expect(entry.data).toEqual({ conversationId: 'a_b', content: 'hello', senderUsername: 'alice' });
    expect(entry.authorDeviceId).toBe('device_self');
  });

  it('round-trips nested and unicode payloads without mangling them', async () => {
    await Obscura.defineModels(obscuraSchema);
    const captionMeta = JSON.stringify({ style: 'bold', x: 0.5, colour: '#fff' });
    const entry = await Obscura.createEntry('story', { content: 'sunset 🌅', captionMeta });

    const [stored] = await Obscura.allEntries('story');
    expect(stored.data.content).toBe('sunset 🌅');
    expect(stored.data.captionMeta).toBe(captionMeta);
    expect(stored.id).toBe(entry.id);
  });
});

describe('entries', () => {
  beforeEach(async () => {
    await Obscura.defineModels(obscuraSchema);
  });

  it('returns what was written, per model, without bleeding between models', async () => {
    await Obscura.createEntry('directMessage', { content: 'dm' });
    await Obscura.createEntry('story', { content: 'story' });

    expect(await Obscura.allEntries('directMessage')).toHaveLength(1);
    expect(await Obscura.allEntries('story')).toHaveLength(1);
    expect(await Obscura.allEntries('profile')).toEqual([]);
  });

  it('upsert replaces the payload wholesale rather than patching fields', async () => {
    const created = await Obscura.createEntry('profile', { displayName: 'alice', bio: 'hi' });
    await Obscura.upsertEntry('profile', created.id, { displayName: 'alice2' });

    const [stored] = await Obscura.allEntries('profile');
    expect(stored.data).toEqual({ displayName: 'alice2' });
    expect(stored.data.bio).toBeUndefined();
  });

  it('hides deleted entries from allEntries, as the kit filters tombstones', async () => {
    const created = await Obscura.createEntry('story', { content: 'gone' });
    await Obscura.deleteEntry('story', created.id);

    expect(await Obscura.allEntries('story')).toEqual([]);
  });
});

describe('the receive path', () => {
  beforeEach(async () => {
    await Obscura.defineModels(obscuraSchema);
  });

  /**
   * The pattern `store.ts` is built on — an event says *something changed for this model*, and the
   * app refetches. The event carries no payload, so the refetch is the only way the data arrives,
   * and the merge must therefore have happened before the event fired.
   */
  it('merges before it notifies, so a refetch on the event sees the new entry', async () => {
    const seen: string[] = [];
    const off = onObscuraEvent((e) => {
      if (e.type === 'messageReceived') seen.push(e.model);
    });

    bridge.__deliverEntry('directMessage', {
      id: 'dm_1',
      data: { content: 'from a peer' },
      authorDeviceId: 'device_peer',
    });

    expect(seen).toEqual(['directMessage']);
    const entries = await Obscura.allEntries('directMessage');
    expect(entries).toHaveLength(1);
    expect(entries[0].data.content).toBe('from a peer');
    off();
  });

  /**
   * Redelivery is guaranteed, not exceptional: the ack is best-effort and its failure is swallowed,
   * so the server re-sends on the next connection (`KIT_API.md` §3.3.1). Convergence under replay
   * is what makes that safe — and it is the property the inbox's `envelopeId` dedupe will have to
   * preserve once the ORM's `INSERT OR REPLACE` is gone.
   */
  it('converges when the same entry is delivered twice', async () => {
    bridge.__deliverEntryTwice('directMessage', {
      id: 'dm_dup',
      data: { content: 'once' },
      timestamp: 5_000,
      authorDeviceId: 'device_peer',
    });

    const entries = await Obscura.allEntries('directMessage');
    expect(entries).toHaveLength(1);
    expect(entries[0].data.content).toBe('once');
  });

  /** `gset` models are immutable: a later write to the same id must not overwrite the first. */
  it('keeps the first write for an APPEND model', async () => {
    bridge.__deliverEntry('directMessage', { id: 'dm_1', data: { content: 'first' }, timestamp: 1_000 });
    bridge.__deliverEntry('directMessage', { id: 'dm_1', data: { content: 'second' }, timestamp: 9_000 });

    const [stored] = await Obscura.allEntries('directMessage');
    expect(stored.data.content).toBe('first');
  });

  /** `lww` models take the higher timestamp. `pix.viewedAt` is the real instance of this. */
  it('takes the later write for a REPLACE model', async () => {
    bridge.__deliverEntry('pix', { id: 'pix_1', data: { viewedAt: 0 }, timestamp: 1_000 });
    bridge.__deliverEntry('pix', { id: 'pix_1', data: { viewedAt: 42 }, timestamp: 9_000 });

    const [stored] = await Obscura.allEntries('pix');
    expect(stored.data.viewedAt).toBe(42);
  });

  /**
   * The tie-break that only matters across two users. `pix.viewedAt` is written by the *recipient*,
   * so an equal-timestamp collision is real rather than theoretical — and without a deterministic
   * tie-break the two devices converge to different states, silently, forever (`SPEC.md` §2.2).
   */
  it('breaks an equal-timestamp tie on authorDeviceId, in either arrival order', async () => {
    bridge.__deliverEntry('pix', { id: 'p', data: { v: 'aaa' }, timestamp: 7, authorDeviceId: 'device_aaa' });
    bridge.__deliverEntry('pix', { id: 'p', data: { v: 'zzz' }, timestamp: 7, authorDeviceId: 'device_zzz' });
    const [forward] = await Obscura.allEntries('pix');

    bridge.__reset();
    await Obscura.defineModels(obscuraSchema);
    bridge.__deliverEntry('pix', { id: 'p', data: { v: 'zzz' }, timestamp: 7, authorDeviceId: 'device_zzz' });
    bridge.__deliverEntry('pix', { id: 'p', data: { v: 'aaa' }, timestamp: 7, authorDeviceId: 'device_aaa' });
    const [reverse] = await Obscura.allEntries('pix');

    expect(forward.data.v).toBe('zzz');
    expect(reverse.data.v).toBe('zzz');
  });
});

describe('failures', () => {
  /**
   * Without an injectable failure every `.catch(...)` in the app is dead code under test, because
   * every bridge call resolves. `logout` is the case that matters most: `store.ts` clears local
   * state whether or not the native call succeeded, and that is deliberate — a user who taps logout
   * must not stay logged in because the network was down.
   */
  it('rejects with a code the app can branch on', async () => {
    bridge.__failNext('createEntry', 'DIRECT_ROUTING_UNRESOLVED', 'no recipient');

    await expect(Obscura.createEntry('directMessage', { content: 'x' }))
      .rejects.toMatchObject({ code: 'DIRECT_ROUTING_UNRESOLVED' });
  });

  it('fails only the next call, so a suite is not poisoned by one injection', async () => {
    await Obscura.defineModels(obscuraSchema);
    bridge.__failNext('createEntry', 'SEND_FAILED');

    await expect(Obscura.createEntry('story', { content: 'x' })).rejects.toThrow();
    await expect(Obscura.createEntry('story', { content: 'y' })).resolves.toBeTruthy();
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
