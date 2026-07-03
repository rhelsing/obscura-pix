/**
 * Shared ORM schema — single source of truth for all platforms.
 * Both iOS and Android bridges cache this JSON on first defineModels() call
 * and use the cached copy for instant cold-start session restore.
 */
export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string', senderUsername: 'string' },
    sync: 'gset',
    direct: true, // 1:1 — target the conversation participants; never broadcast.
  },
  story: {
    fields: {
      content: 'string',
      authorUsername: 'string',
      // Attachment fields — present iff the story has a photo (text-only stories
      // omit all three). Same shape as pix so a single viewer can render both.
      mediaRef: 'string?',
      contentKey: 'string?',
      nonce: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
    },
    sync: 'gset',
    ttl: '24h',
  },
  profile: {
    fields: { displayName: 'string', bio: 'string?', avatarUrl: 'string?' },
    sync: 'lww',
  },
  settings: {
    fields: { theme: 'string', notificationsEnabled: 'boolean' },
    sync: 'lww',
    private: true,
  },
  pix: {
    fields: {
      // Canonical sorted "userIdA_userIdB" — targets both parties so the
      // viewed-receipt (Bob → Alice) resolves in either direction.
      conversationId: 'string',
      recipientUsername: 'string', // "to" label / push text only now
      senderUsername: 'string',
      mediaRef: 'string',
      contentKey: 'string',
      nonce: 'string',
      caption: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
      displayDuration: 'number',
      viewedAt: 'number?',
    },
    sync: 'lww',
    direct: true, // 1:1 — target the conversation participants; never broadcast.
  },
};
