import { NativeModules, NativeEventEmitter, TurboModuleRegistry, type EmitterSubscription } from 'react-native';

// Try TurboModuleRegistry first (RN 0.84+), fall back to NativeModules (old arch)
const ObscuraBridge =
  TurboModuleRegistry.get('ObscuraBridge') ||
  NativeModules.ObscuraBridge ||
  null;

// Stub for when native module isn't available (e.g. under jest).
const noop = (..._args: any[]): Promise<any> => Promise.resolve(null);
const Bridge = ObscuraBridge || new Proxy({}, { get: (_t, _prop) => noop });

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

export interface ResizedImage {
  path: string;
  width: number;
  height: number;
}

export interface AttachmentRef {
  id: string;
  contentKey: string;
  nonce: string;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected';
export type AuthState = 'loggedOut' | 'authenticated' | 'pendingApproval';
export type AppLifecycleState = 'active' | 'background';

export interface LaunchIntent {
  /** Screen the app should route to (set when launched via notification tap). */
  screen: string;
}

export type LoginScenario =
  | 'existingDevice'
  | 'newDevice'
  | 'deviceMismatch'
  | 'invalidCredentials'
  | 'userNotFound';

/**
 * Stable error codes a rejected promise may carry in its `code`, mirroring
 * `ObscuraError.kt` in the kit. Kit-level failures use one of these; anything
 * else falls back to a per-method code (e.g. "CREATE_ERROR").
 */
export type ObscuraErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'NOT_PROVISIONED'
  | 'NOT_FRIENDS'
  | 'NO_DEVICES'
  | 'SEND_FAILED'
  | 'DIRECT_ROUTING_UNRESOLVED';

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

  // ORM — schema defined once at startup, cached by native for cold-start restore
  defineModels: (schema: Record<string, any>): Promise<void> =>
    Bridge.defineModels(JSON.stringify(schema)),

  // ORM — CRUD. Each mutating call also emits an `entriesChanged` event for
  // the affected model so other screens can re-query reactively.
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

  // Signals (typing)
  sendTyping: (conversationId: string): Promise<void> =>
    Bridge.sendTyping(conversationId),

  stopTyping: (conversationId: string): Promise<void> =>
    Bridge.stopTyping(conversationId),

  observeTyping: (conversationId: string): Promise<void> =>
    Bridge.observeTyping(conversationId),

  stopObservingTyping: (conversationId: string): Promise<void> =>
    Bridge.stopObservingTyping(conversationId),

  // Attachments — path-based. JS never holds the bytes.
  // upload reads from `filePath`, encrypts, uploads. The source file is left
  // alone (callers are responsible for cleaning up their own temp files).
  uploadAttachment: (filePath: string): Promise<AttachmentRef> =>
    Bridge.uploadAttachment(filePath),
  // download decrypts to a deterministic cache file and returns its absolute path.
  // Repeated downloads of the same id short-circuit (cache hit).
  downloadAttachment: (id: string, contentKey: string, nonce: string): Promise<string> =>
    Bridge.downloadAttachment(id, contentKey, nonce),

  // Image processing — keeps bytes native.
  resizeImage: (srcPath: string, maxDim: number, quality: number): Promise<ResizedImage> =>
    Bridge.resizeImage(srcPath, maxDim, quality),
  /** Solid-color JPEG for emulators with no camera. */
  writeTestImage: (width: number, height: number): Promise<ResizedImage> =>
    Bridge.writeTestImage(width, height),

  // Push notifications. `requestPushPermission` triggers platform-native
  // permission UI + token fetch. The token arrives asynchronously via the
  // `pushTokenReceived` event; consumers should listen for it and call
  // `registerPushToken(token)` to upsert it on the server.
  requestPushPermission: (): Promise<boolean> => Bridge.requestPushPermission(),
  registerPushToken: (token: string): Promise<void> => Bridge.registerPushToken(token),

  // Misc
  getDebugLog: (): Promise<string[]> => Bridge.getDebugLog(),
  /** FLAG_SECURE on Android, no-op on iOS for now. */
  setSecureScreen: (enabled: boolean): Promise<void> => Bridge.setSecureScreen(enabled),
  /**
   * Warm up the audio HAL so video recording starts instantly. Cold
   * AVAudioSession activation on iOS costs ~1.4s; call this when the camera
   * appears. No-op on Android (fast audio init). Idempotent.
   */
  prewarmAudioSession: (): Promise<void> => Bridge.prewarmAudioSession(),
  /** Best-effort unlink. Used to clean up temp capture files. */
  deleteFile: (path: string): Promise<void> => Bridge.deleteFile(path),
  /** Write `text` to the system clipboard. Replaces RN core's deprecated Clipboard module. */
  setClipboard: (text: string): Promise<void> => Bridge.setClipboard(text),
  /**
   * Cold-start deep-link target — the screen the app was launched into via a
   * notification tap. Returns null if the app wasn't launched from a deep
   * link. The intent extra is consumed by the call, so re-calls return null.
   * For warm-start deep-links (app already running, notification tapped),
   * listen for the `launchedFrom` event instead.
   */
  getLaunchIntent: (): Promise<LaunchIntent | null> => Bridge.getLaunchIntent(),
};

// ─── Events ──────────────────────────────────────────────
//
// The native side emits a single stream named `ObscuraEvent` whose payloads
// share the discriminator `{ type }`. [OBSCURA_EVENT_TYPES] is the canonical
// list of event names; it MUST mirror the `BridgeEvent` enum in the native
// bridges (ObscuraBridgeModule.kt / iOS). The `_AssertEventTypesMatch` check
// below makes any drift between this list and the payload union a compile error.

export const OBSCURA_EVENT_TYPES = [
  'connectionChanged',
  'authStateChanged',
  'authFailed',
  'appStateChanged',
  'launchedFrom',
  'friendsUpdated',
  'messageReceived',
  'entriesChanged',
  'typingChanged',
  'pushTokenReceived',
  'debugLog',
] as const;

export type ObscuraEventType = (typeof OBSCURA_EVENT_TYPES)[number];

export type ObscuraEvent =
  | { type: 'connectionChanged'; state: ConnectionState }
  | { type: 'authStateChanged'; state: AuthState }
  | { type: 'authFailed'; reason: string }
  | { type: 'appStateChanged'; state: AppLifecycleState }
  | { type: 'launchedFrom'; screen: string }
  | { type: 'friendsUpdated'; friends: Friend[] }
  | { type: 'messageReceived'; model: string }
  | { type: 'entriesChanged'; model: string }
  | { type: 'typingChanged'; conversationId: string; typers: string[] }
  | { type: 'pushTokenReceived'; token: string }
  | { type: 'debugLog'; message: string };

// Compile-time guarantee that the name list and the payload union agree in both
// directions (every listed name has a payload, and every payload is listed).
type _AssertEventTypesMatch =
  [ObscuraEventType] extends [ObscuraEvent['type']]
    ? [ObscuraEvent['type']] extends [ObscuraEventType]
      ? true
      : ['missing from OBSCURA_EVENT_TYPES', Exclude<ObscuraEvent['type'], ObscuraEventType>]
    : ['missing from ObscuraEvent union', Exclude<ObscuraEventType, ObscuraEvent['type']>];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _eventTypesMatch: _AssertEventTypesMatch = true;

// Lazy-init emitter — only create when the native module exists.
let _emitter: NativeEventEmitter | null = null;
function getEmitter(): NativeEventEmitter | null {
  if (!_emitter && ObscuraBridge) {
    _emitter = new NativeEventEmitter(ObscuraBridge as any);
  }
  return _emitter;
}

/**
 * Subscribe to typed Obscura events.
 *
 * Returns an unsubscribe function. If the native module isn't available
 * (jest, etc.) the subscription is a no-op and the unsubscribe is safe to call.
 */
export function onObscuraEvent(handler: (event: ObscuraEvent) => void): () => void {
  const em = getEmitter();
  if (!em) return () => {};
  const sub: EmitterSubscription = em.addListener('ObscuraEvent', handler);
  return () => sub.remove();
}

// ─── Helpers ─────────────────────────────────────────────

/** Canonical conversationId — same from both sides. Matches iOS + Android. */
export function conversationId(myUserId: string, friendUserId: string): string {
  return [myUserId, friendUserId].sort().join('_');
}
