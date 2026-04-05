import { NativeModules, NativeEventEmitter, Platform, TurboModuleRegistry } from 'react-native';

// Try TurboModuleRegistry first (RN 0.84+), fall back to NativeModules (old arch)
const ObscuraBridge =
  TurboModuleRegistry.get('ObscuraBridge') ||
  NativeModules.ObscuraBridge ||
  null;

// Stub for when native module isn't available
const noop = (..._args: any[]): Promise<any> => Promise.resolve(null);
const Bridge = ObscuraBridge || new Proxy({}, { get: (_t, prop) => noop });

// Lazy-init emitter — only create when the native module exists
let _emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (!_emitter && ObscuraBridge) {
    _emitter = new NativeEventEmitter(ObscuraBridge);
  }
  return _emitter;
}

// ─── Types ───────────────────────────────────────────────

export interface Friend {
  userId: string;
  username: string;
  status: 'pending_sent' | 'pending_received' | 'accepted';
}

export interface ModelEntry {
  id: string;
  data: Record<string, any>;
  timestamp: number;
  authorDeviceId: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
export type AuthState = 'loggedOut' | 'authenticated' | 'pendingApproval';

export type LoginScenario =
  | 'existingDevice'
  | 'newDevice'
  | 'onlyDevice'
  | 'deviceMismatch'
  | 'invalidCredentials'
  | 'userNotFound';

// ─── Core API ────────────────────────────────────────────

export const Obscura = {
  // Auth
  register: (username: string, password: string): Promise<void> =>
    Bridge.registerUser(username, password),

  loginSmart: (username: string, password: string): Promise<LoginScenario> =>
    Bridge.loginSmart(username, password),

  loginAndProvision: (username: string, password: string): Promise<void> =>
    Bridge.loginAndProvision(username, password),

  connect: (): Promise<void> => Bridge.connect(),
  disconnect: (): Promise<void> => Bridge.disconnect(),
  logout: (): Promise<void> => Bridge.logout(),

  // State
  getConnectionState: (): Promise<ConnectionState> => Bridge.getConnectionState(),
  getAuthState: (): Promise<AuthState> => Bridge.getAuthState(),
  getUserId: (): Promise<string | null> => Bridge.getUserId(),
  getUsername: (): Promise<string | null> => Bridge.getUsername(),
  getDeviceId: (): Promise<string | null> => Bridge.getDeviceId(),

  // Friends
  befriend: (userId: string, username: string): Promise<void> =>
    Bridge.befriend(userId, username),

  acceptFriend: (userId: string, username: string): Promise<void> =>
    Bridge.acceptFriend(userId, username),

  getFriendCode: (): Promise<string> => Bridge.getFriendCode(),
  addFriendByCode: (code: string): Promise<void> => Bridge.addFriendByCode(code),
  getFriends: (): Promise<Friend[]> => Bridge.getFriends(),
  getPendingRequests: (): Promise<Friend[]> => Bridge.getPendingRequests(),

  // Device linking
  generateLinkCode: (): Promise<string> => Bridge.generateLinkCode(),
  validateAndApproveLink: (code: string): Promise<void> =>
    Bridge.validateAndApproveLink(code),

  // ORM — schema defined once at startup
  defineModels: (): Promise<void> => Bridge.defineModels(),

  // ORM — CRUD
  createEntry: (model: string, data: Record<string, any>): Promise<ModelEntry> =>
    Bridge.createEntry(model, JSON.stringify(data)),

  upsertEntry: (model: string, id: string, data: Record<string, any>): Promise<ModelEntry> =>
    Bridge.upsertEntry(model, id, JSON.stringify(data)),

  queryEntries: (model: string, conditions: Record<string, any>): Promise<ModelEntry[]> =>
    Bridge.queryEntries(model, JSON.stringify(conditions)),

  allEntries: (model: string): Promise<ModelEntry[]> =>
    Bridge.allEntries(model),

  deleteEntry: (model: string, id: string): Promise<void> =>
    Bridge.deleteEntry(model, id),

  // Signals (typing, read receipts)
  sendTyping: (conversationId: string): Promise<void> =>
    Bridge.sendTyping(conversationId),

  stopTyping: (conversationId: string): Promise<void> =>
    Bridge.stopTyping(conversationId),

  // Attachments (encrypted photos)
  uploadAttachment: (base64Data: string): Promise<{ id: string; contentKey: string; nonce: string }> =>
    Bridge.uploadAttachment(base64Data),

  downloadAttachment: (id: string, contentKey: string, nonce: string): Promise<string> =>
    Bridge.downloadAttachment(id, contentKey, nonce),

  sendPhoto: (friendUserId: string, base64Data: string): Promise<void> =>
    Bridge.sendPhoto(friendUserId, base64Data),

  // Debug
  getDebugLog: (): Promise<string[]> => Bridge.getDebugLog(),

};

// ─── Event Subscriptions ─────────────────────────────────

export type ObscuraEvent =
  | { type: 'friendsUpdated'; friends: Friend[] }
  | { type: 'pendingUpdated'; friends: Friend[] }
  | { type: 'messageReceived'; model: string; entry: ModelEntry }
  | { type: 'typingStarted'; conversationId: string; authorDeviceId: string }
  | { type: 'typingStopped'; conversationId: string }
  | { type: 'connectionChanged'; state: ConnectionState }
  | { type: 'debugLog'; message: string };

export function onObscuraEvent(handler: (event: ObscuraEvent) => void) {
  const em = getEmitter();
  if (!em) return () => {};
  const sub = em.addListener('ObscuraEvent', handler);
  return () => sub.remove();
}

// ─── Helpers ─────────────────────────────────────────────

/** Canonical conversationId — same from both sides. Matches iOS + Android. */
export function conversationId(myUserId: string, friendUserId: string): string {
  return [myUserId, friendUserId].sort().join('_');
}
