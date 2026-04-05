// ORM model types — field names match iOS (SyncModel) and Android (ModelConfig) exactly.
// These are the same shapes that flow through MODEL_SYNC across all platforms.

export interface DirectMessage {
  conversationId: string;
  content: string;
  senderUsername: string;
}

export interface Story {
  content: string;
  authorUsername: string;
  mediaUrl?: string;  // attachment reference (encrypted)
}

export interface Profile {
  displayName: string;
  bio?: string;
  avatarUrl?: string;
}

export interface AppSettings {
  theme: string;
  notificationsEnabled: boolean;
}

export interface Pix {
  recipientUsername: string;
  senderUsername: string;
  mediaRef: string;       // encrypted attachment ID
  contentKey: string;     // AES key for decryption
  nonce: string;          // AES nonce
  caption?: string;
  displayDuration: number; // seconds before auto-delete
  viewedAt?: number;       // timestamp when opened (null = unviewed)
}
