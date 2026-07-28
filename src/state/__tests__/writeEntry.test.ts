import { writeEntry, newEntryId } from '../writeEntry';
import { DirectRoutingUnresolved } from '../../domain/audience';
import { Obscura } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

/**
 * The write path (`obscura-proto/KIT_API.md` §5, §8.1).
 *
 * `Obscura.createEntry` used to do four things inside the kit: generate an id, store, resolve an
 * audience, fan out. Three of those are application decisions the kit is forbidden to make
 * (SPEC §0.4), so they moved here — and these tests are what makes that move checkable.
 */

const bridge = getFakeBridge();

// UUIDs, as the server actually issues them. Not decoration: a conversation id is
// `userIdA_userIdB` split on `_`, so an id CONTAINING an underscore would mis-split — and these
// tests were written with `user_self`-style ids at first and failed for exactly that reason.
// See the note on `resolveAudience`.
const SELF = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const FRIENDS = [
  { userId: BOB, username: 'bob', status: 'accepted' },
  { userId: '44444444-4444-4444-8444-444444444444', username: 'carol', status: 'accepted' },
];

function args(model: string, data: Record<string, unknown>, id?: string) {
  return { model, id, data, selfUserId: SELF, myDeviceId: DEVICE, friends: FRIENDS };
}

describe('storing and sending', () => {
  it('stores locally and sends to the resolved audience', async () => {
    const convId = [SELF, BOB].sort().join('_');

    const id = await writeEntry(args('directMessage', { conversationId: convId, content: 'hi' }));

    const stored = await Obscura.entryAll('directMessage');
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(id);
    expect(JSON.parse(stored[0].data)).toEqual({ conversationId: convId, content: 'hi' });

    expect(bridge.__sent).toHaveLength(1);
    expect(bridge.__sent[0].recipientUserIds).toEqual([BOB]);
    expect(bridge.__sent[0].modelKey).toBe('directMessage');
  });

  /**
   * **§5 property 2 in practice.** `send` produces no inbox row for the sender, so this is the only
   * place an outgoing entry is stored. If the local write were dropped, the sender would simply not
   * have their own message — and no drain would ever supply it.
   */
  it('is the only thing that stores the sender copy — nothing loops back', async () => {
    await writeEntry(args('story', { content: 'mine' }));

    expect(await Obscura.entryAll('story')).toHaveLength(1);
    expect(await Obscura.inboxDepth()).toBe(0);
  });

  it('records the authoring device, which is the merge tie-break', async () => {
    await writeEntry(args('profile', { displayName: 'me' }, 'profile_1'));

    expect((await Obscura.entryAll('profile'))[0].authorDeviceId).toBe(DEVICE);
  });

  it('sends the payload as the same JSON it stored', async () => {
    const data = { content: 'sunset 🌅', meta: { x: 0.5, tags: ['a', 'b'] } };

    await writeEntry(args('story', data));

    const stored = await Obscura.entryAll('story');
    expect(bridge.__sent[0].payloadJson).toBe(stored[0].data);
    expect(JSON.parse(bridge.__sent[0].payloadJson)).toEqual(data);
  });

  it('creates with CREATE and updates with UPDATE', async () => {
    await writeEntry(args('profile', { displayName: 'a' }));
    await writeEntry(args('profile', { displayName: 'b' }, 'profile_fixed'));

    expect(bridge.__sent.map((s) => s.op)).toEqual(['CREATE', 'UPDATE']);
  });
});

describe('the effect ORDER', () => {
  /**
   * The local write is the one that must not be lost: the user's content is theirs whether or not
   * the network cooperated. Asserted on the call sequence, because the end state of a successful
   * run looks the same either way.
   */
  it('writes locally BEFORE sending', async () => {
    await writeEntry(args('story', { content: 'x' }));

    expect(bridge.__calls.indexOf('entryPut')).toBeLessThan(bridge.__calls.indexOf('sendEntry'));
  });

  /**
   * A send failure must not cost the user their content — **and must not be silent either**.
   *
   * The kit throws from `send` only when a send reached NOBODY (a partial failure is best-effort by
   * design), so this is the case where the user is looking at an entry in their own timeline that
   * got nowhere. It keeps the local row, because their content is theirs whether or not the network
   * cooperated, and it re-throws so a screen can say so.
   *
   * This test asserted `.resolves` until 2026-07-28, pinning the swallow as correct — justified by
   * "the kit queues and retries", which is not true in the sense required: the retry queue is
   * in-memory, flushed only on the next send, and lost on process death.
   */
  it('keeps the local entry when the send fails, but still reports the failure', async () => {
    bridge.__failNext('sendEntry', 'SEND_FAILED', 'offline');

    await expect(writeEntry(args('story', { content: 'x' }))).rejects.toThrow('offline');

    expect(await Obscura.entryAll('story')).toHaveLength(1);
  });
});

describe('audience failures', () => {
  /**
   * **Nothing is stored and nothing is sent.** A local row the user can see but that reached nobody
   * is worse than a refusal — they would believe it was delivered.
   */
  it('stores nothing when the audience cannot be resolved', async () => {
    // A three-party conversation id: the LEAK GUARD case.
    const bad = args('directMessage', { conversationId: 'a_b_c', content: 'x' });

    await expect(writeEntry(bad)).rejects.toThrow(DirectRoutingUnresolved);

    expect(await Obscura.entryAll('directMessage')).toEqual([]);
    expect(bridge.__sent).toEqual([]);
    expect(bridge.__calls).not.toContain('entryPut');
  });

  it('refuses rather than broadcasting when a 1:1 audience is missing', async () => {
    await expect(writeEntry(args('directMessage', { content: 'no conversation id' })))
      .rejects.toThrow(DirectRoutingUnresolved);

    expect(bridge.__sent).toEqual([]);
  });

  /**
   * `pix` resolves by CONVERSATION, not by recipient — `schema.ts` declares
   * `audience: { kind: 'conversation', field: 'conversationId' }`, and `recipientUsername` is a
   * display label the resolver never reads.
   *
   * **A conversation participant who is not an accepted friend gets nothing.** The conversation id
   * is a payload field, so without that intersection this call would mail the entry — `mediaRef`,
   * `contentKey`, `nonce` — to whatever userId a peer wrote into it. `StoriesScreen` writes a
   * viewed-receipt back with `{ ...story.data }`, so the peer-supplied id reaches here directly.
   *
   * This test asserted `[STRANGER]` until 2026-07-28 and was pinning the leak as correct.
   */
  it('resolves pix by conversation, and drops a participant who is not a friend', async () => {
    await writeEntry(args('pix', {
      conversationId: [SELF, STRANGER].sort().join('_'),
      recipientUsername: 'someone-else-entirely',
    }));

    // Stored — it is the user's own entry — but sent to nobody but their own devices.
    expect(await Obscura.entryAll('pix')).toHaveLength(1);
    expect(bridge.__sent[0].recipientUserIds).toEqual([]);
  });

  it('sends to a conversation participant who IS a friend', async () => {
    await writeEntry(args('pix', { conversationId: [SELF, BOB].sort().join('_') }));

    expect(bridge.__sent[0].recipientUserIds).toEqual([BOB]);
  });

  /** A model name that is not in `schema.ts` must not fall through to "everyone". */
  it('refuses a model the schema does not declare, rather than broadcasting it', async () => {
    // One character off `directMessage`.
    await expect(writeEntry(args('directMessages', { conversationId: `${SELF}_${BOB}`, content: 'private' })))
      .rejects.toThrow(DirectRoutingUnresolved);

    expect(bridge.__sent).toEqual([]);
    expect(bridge.__calls).not.toContain('entryPut');
  });
});

describe('entry ids', () => {
  /**
   * Randomness is not decoration: APPEND dedupes by id, so two devices creating an entry in the same
   * millisecond must not collide — one would silently discard the other's message.
   */
  it('are unique even within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newEntryId('story')));

    expect(ids.size).toBe(500);
  });

  it('are namespaced by model, so a human reading the store can tell them apart', () => {
    expect(newEntryId('story')).toMatch(/^story_\d+_[a-z0-9]+$/);
  });
});
