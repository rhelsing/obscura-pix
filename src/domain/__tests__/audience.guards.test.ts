import {
  resolveAudience,
  DirectRoutingUnresolved,
  type AudienceConfig,
  type AudienceFriend,
} from '../audience';

/**
 * The five leak guards, vendored from `obscura-proto/conformance/routing.json`.
 *
 * `RESET.md`'s "The `routing.json` leak guards" hands these over: the kits stop resolving audiences,
 * so these vectors stop being a cross-implementation contract and become this repo's fixture. They
 * are transcribed **verbatim** — same schema, same entry data, same expectation — so a reviewer can
 * diff them against the file they came from.
 *
 * The original justification for deleting them was "a kit no longer resolves an audience, so it
 * cannot misroute". That is a non-sequitur: **the risk moves here, it does not evaporate.** And it
 * is not hypothetical — the typing-indicator leak fixed on 2026-07-25 was exactly this shape (a 1:1
 * payload, an audience nobody resolved, broadcast to every friend), on a code path `routing.json`
 * never covered.
 *
 * `routing.json`'s expectations include self in `recipients`; `resolveAudience` deliberately excludes
 * it, because the kit self-syncs to the author's other devices as part of `send`. So the comparisons
 * below add self back rather than changing what the function returns.
 */

// routing.json `topology`, verbatim.
const SELF = 'uMe';
const FRIENDS: AudienceFriend[] = [
  { userId: 'uA', username: 'alice', status: 'accepted' },
  { userId: 'uB', username: 'bob', status: 'accepted' },
  { userId: 'uC', username: 'carol', status: 'accepted' },
];

const CONVERSATION: AudienceConfig = { kind: 'conversation', field: 'conversationId' };
const RECIPIENT: AudienceConfig = { kind: 'recipient', field: 'recipientUsername' };

/** What the kit will actually deliver to: the resolved audience plus the author's own devices. */
function withSelf(resolved: string[]): string[] {
  return [...new Set([SELF, ...resolved])].sort();
}

describe('routing.json leak guards', () => {
  /**
   * **The named failure mode**, and the reason this file exists: a 1:1 payload reaching everyone.
   * `uMe_uB_uC` is not a canonical two-party id, and the only safe response to an audience you
   * cannot resolve is to refuse — never to widen.
   */
  it('LEAK GUARD: conversation with a malformed 3-party id must fail loud, never broadcast', () => {
    const entry = { conversationId: 'uMe_uB_uC', content: 'x', senderUsername: 'me' };

    expect(() => resolveAudience(CONVERSATION, entry, SELF, FRIENDS))
      .toThrow(DirectRoutingUnresolved);
    // Not merely "throws" — it must not have quietly resolved to the friend list on the way out.
    try {
      resolveAudience(CONVERSATION, entry, SELF, FRIENDS);
    } catch (e) {
      expect((e as DirectRoutingUnresolved).code).toBe('DIRECT_ROUTING_UNRESOLVED');
    }
  });

  it('conversation audience with a missing id field must fail loud', () => {
    const entry = { content: 'x', senderUsername: 'me' };

    expect(() => resolveAudience(CONVERSATION, entry, SELF, FRIENDS))
      .toThrow(DirectRoutingUnresolved);
  });

  it('recipient audience with a missing recipient field must fail loud', () => {
    const entry = { senderUsername: 'me', mediaRef: 'ref-3' };

    expect(() => resolveAudience(RECIPIENT, entry, SELF, FRIENDS))
      .toThrow(DirectRoutingUnresolved);
  });

  /** Blank is not "everyone" — it is an unanswered question. */
  it('recipient audience with a blank recipient field must fail loud', () => {
    const entry = { recipientUsername: '', senderUsername: 'me', mediaRef: 'ref-4' };

    expect(() => resolveAudience(RECIPIENT, entry, SELF, FRIENDS))
      .toThrow(DirectRoutingUnresolved);
  });

  /**
   * Fail **safe**, not merely loud. The user named a narrow audience the app cannot reach; the
   * narrowest honest answer is nobody else, which the kit turns into a self-sync.
   *
   * routing.json expects `["uMe"]` — self only.
   */
  it('recipient audience naming a non-friend fails safe to self only (never broadcasts)', () => {
    const entry = { recipientUsername: 'stranger', senderUsername: 'me', mediaRef: 'ref-2' };

    const resolved = resolveAudience(RECIPIENT, entry, SELF, FRIENDS);

    expect(withSelf(resolved)).toEqual(['uMe']);
    expect(resolved).not.toContain('uA');
    expect(resolved).not.toContain('uB');
    expect(resolved).not.toContain('uC');
  });
});

describe('resolution the app actually uses', () => {
  it('resolves a canonical two-party conversation to the other participant', () => {
    const entry = { conversationId: ['uMe', 'uB'].sort().join('_') };

    expect(resolveAudience(CONVERSATION, entry, SELF, FRIENDS)).toEqual(['uB']);
  });

  /**
   * The id is sorted and symmetric, so it must resolve identically computed from either side. If it
   * did not, one participant would address the conversation and the other would not.
   */
  it('resolves the same conversation from either participant', () => {
    const convId = ['uMe', 'uB'].sort().join('_');

    const fromMe = resolveAudience(CONVERSATION, { conversationId: convId }, 'uMe', FRIENDS);
    const fromThem = resolveAudience(CONVERSATION, { conversationId: convId }, 'uB', FRIENDS);

    expect(fromMe).toEqual(['uB']);
    expect(fromThem).toEqual(['uMe']);
  });

  it('resolves a named friend to exactly that friend', () => {
    const entry = { recipientUsername: 'bob' };

    expect(resolveAudience(RECIPIENT, entry, SELF, FRIENDS)).toEqual(['uB']);
  });

  it('resolves self scope to nobody else — the kit self-syncs', () => {
    expect(resolveAudience({ kind: 'self' }, {}, SELF, FRIENDS)).toEqual([]);
  });

  it('resolves an undeclared audience to every accepted friend', () => {
    expect(resolveAudience(undefined, {}, SELF, FRIENDS).sort()).toEqual(['uA', 'uB', 'uC']);
  });

  /** Pending friends are not friends. A request you have not accepted must not receive your content. */
  it('never includes a non-accepted friend in a broadcast', () => {
    const withPending: AudienceFriend[] = [
      ...FRIENDS,
      { userId: 'uD', username: 'dave', status: 'pending_received' },
    ];

    expect(resolveAudience(undefined, {}, SELF, withPending)).not.toContain('uD');
    expect(resolveAudience(RECIPIENT, { recipientUsername: 'dave' }, SELF, withPending)).toEqual([]);
  });

  it('never names this user as their own recipient', () => {
    const selfNamed: AudienceFriend[] = [...FRIENDS, { userId: SELF, username: 'me', status: 'accepted' }];

    expect(resolveAudience(RECIPIENT, { recipientUsername: 'me' }, SELF, selfNamed)).toEqual([]);
    expect(resolveAudience(undefined, {}, SELF, selfNamed)).not.toContain(SELF);
  });
});
