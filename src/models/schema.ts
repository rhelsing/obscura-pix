/**
 * Shared ORM schema — single source of truth for all platforms.
 * Both iOS and Android bridges cache this JSON on first defineModels() call
 * and use the cached copy for instant cold-start session restore.
 */
export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string', senderUsername: 'string' },
    sync: 'gset',
  },
  story: {
    fields: { content: 'string', authorUsername: 'string', mediaUrl: 'string?' },
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
      recipientUsername: 'string',
      senderUsername: 'string',
      mediaRef: 'string',
      contentKey: 'string',
      nonce: 'string',
      caption: 'string?',
      displayDuration: 'number',
      viewedAt: 'number?',
    },
    sync: 'lww',
  },
};
