import {
  resolveAudience,
  DirectRoutingUnresolved,
  type AudienceConfig,
  type AudienceFriend,
} from '../audience';

/**
 * Audience confidentiality guards required by DOMAIN_CONTRACT.
 *
 * The fixture expectations include self; `resolveAudience` excludes it because
 * the kit self-syncs to the author's other devices.
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
    // Each side sees the other as a friend; the resolver intersects
    // participants with the ACCEPTED graph, so the fixture has to model both directions honestly.
    const bobsFriends = [{ userId: 'uMe', username: 'me', status: 'accepted' }];

    const fromMe = resolveAudience(CONVERSATION, { conversationId: convId }, 'uMe', FRIENDS);
    const fromThem = resolveAudience(CONVERSATION, { conversationId: convId }, 'uB', bobsFriends);

    expect(fromMe).toEqual(['uB']);
    expect(fromThem).toEqual(['uMe']);
  });

  /**
   * **The guard `routing.json` never had, because no shipped model uses a `recipient` audience.**
   * Every live 1:1 model declares `conversation`, so the fail-safe the vendored vectors pin was on a
   * branch the app never takes — while the branch it does take read recipients straight out of a
   * peer-supplied payload field.
   */
  it('LEAK GUARD: a conversation participant who is not an accepted friend is dropped', () => {
    const convId = ['uMe', 'uStranger'].sort().join('_');

    expect(resolveAudience(CONVERSATION, { conversationId: convId }, 'uMe', FRIENDS)).toEqual([]);
  });

  it('LEAK GUARD: a pending friend is not a conversation participant', () => {
    const pending = [...FRIENDS, { userId: 'uD', username: 'dave', status: 'pending_received' }];
    const convId = ['uMe', 'uD'].sort().join('_');

    expect(resolveAudience(CONVERSATION, { conversationId: convId }, 'uMe', pending)).toEqual([]);
  });

  /**
   * **The leak this file was one guard short of.** The intersection with the accepted graph cannot
   * widen past my friends — but two of my friends talking to each other is still not my
   * conversation, and mailing them an entry out of it is a confidentiality breach in the same class
   * as a broadcast. Reachable through the viewed-receipt, the one path that echoes peer bytes out.
   */
  it('LEAK GUARD: a conversation this user is not part of must fail loud, never resolve', () => {
    const convId = ['uA', 'uB'].sort().join('_');

    expect(() => resolveAudience(CONVERSATION, { conversationId: convId }, SELF, FRIENDS))
      .toThrow(DirectRoutingUnresolved);
  });

  /**
   * DOMAIN_CONTRACT: splitting on `_` MUST yield exactly two NON-EMPTY parts. Filtering empties out
   * before counting accepts every one of these as two-party.
   */
  it.each(['uMe__uB', '_uMe_uB', 'uMe_uB_', '__uMe___uB__', '_uMe', 'uMe_'])(
    'rejects %p as a non-canonical two-party id',
    (convId) => {
      expect(() => resolveAudience(CONVERSATION, { conversationId: convId }, SELF, FRIENDS))
        .toThrow(DirectRoutingUnresolved);
    },
  );

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
