import { NativeModules, NativeEventEmitter, TurboModuleRegistry, type EmitterSubscription } from 'react-native';

interface NativeObscuraBridge {
  registerUser(username: string, password: string): Promise<void>;
  loginSmart(username: string, password: string): Promise<LoginScenario>;
  loginAndProvision(username: string, password: string): Promise<void>;
  connect(): Promise<void>;
  logout(): Promise<void>;
  getConnectionState(): Promise<ConnectionState>;
  getAuthState(): Promise<AuthState>;
  getUserId(): Promise<string | null>;
  getUsername(): Promise<string | null>;
  getDeviceId(): Promise<string | null>;
  acceptFriend(userId: string): Promise<void>;
  getFriendCode(): Promise<string>;
  addFriendByCode(code: string): Promise<void>;
  getFriends(): Promise<Friend[]>;
  generateLinkCode(): Promise<string>;
  validateAndApproveLink(code: string): Promise<void>;
  inboxPeek(limit: number): Promise<InboxRow[]>;
  inboxConsume(ids: number[]): Promise<void>;
  inboxDiscard(ids: number[], reason: string): Promise<void>;
  inboxDepth(): Promise<number>;
  entryPut(
    model: string, id: string, dataJson: string, sentAt: number, authorDeviceId: string,
    localMetadataJson: string | null,
  ): Promise<void>;
  entryAll(model: string): Promise<StoredEntry[]>;
  sendEntry(
    recipientUserIds: string[], modelKey: string, entryId: string,
    sentAt: number, payloadJson: string,
  ): Promise<void>;
  sendTyping(recipientUserIds: string[], conversationId: string): Promise<void>;
  stopTyping(recipientUserIds: string[], conversationId: string): Promise<void>;
  observeTyping(conversationId: string): Promise<void>;
  stopObservingTyping(conversationId: string): Promise<void>;
  uploadAttachment(filePath: string): Promise<AttachmentRef>;
  downloadAttachment(id: string, contentKey: string, nonce: string): Promise<string>;
  resizeImage(srcPath: string, maxDim: number, quality: number): Promise<ResizedImage>;
  writeTestImage(width: number, height: number): Promise<ResizedImage>;
  requestPushPermission(): Promise<boolean>;
  registerPushToken(token: string): Promise<void>;
  getDebugLog(): Promise<string[]>;
  prewarmAudioSession(): Promise<void>;
  deleteFile(path: string): Promise<void>;
  setClipboard(text: string): Promise<void>;
  getLaunchIntent(): Promise<LaunchIntent | null>;
}

// Try TurboModuleRegistry first (RN 0.84+), fall back to NativeModules (old arch)
const ObscuraBridge =
  (TurboModuleRegistry.get('ObscuraBridge') as NativeObscuraBridge | null) ||
  (NativeModules.ObscuraBridge as NativeObscuraBridge | undefined) ||
  null;

const Bridge: NativeObscuraBridge = ObscuraBridge ?? new Proxy({} as NativeObscuraBridge, {
  get: (_target, property) => () => Promise.reject(
    new Error(`ObscuraBridge.${String(property)} is unavailable`),
  ),
});
// ─── Types ───────────────────────────────────────────────

export interface Friend {
  userId: string;
  username: string;
  status: 'pending_sent' | 'pending_received' | 'accepted';
}

/**
 * An entry as the app holds it in memory.
 *
 * `entryAll` returns `StoredEntry` with opaque JSON; `loadEntries` parses it
 * into this screen-facing shape.
 */
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

/**
 * One row from the kit's durable inbox (`obscura-native/docs/KIT_API.md` §3.1).
 *
 * The kit stores bytes it cannot read. `payload` is the app's own JSON for kinds the app
 * understands; for an unknown `kind` it is arbitrary bytes rendered as a lossy string, which is safe
 * only because §4.1 requires such a row to be **discarded without being read**.
 */
export interface InboxRow {
  /** Monotonic per install. Drain order. Not a message id. */
  id: number;
  /** The payload arm, e.g. `APP_ENTRY`. `UNKNOWN` for an arm the kit does not know. */
  kind: string;
  /** Server-stamped transport identity (NATIVE_CONTRACT §0.10). */
  senderUserId: string;
  /** The device whose Signal session decrypted this — cryptographic attribution, and the merge tie-break. */
  senderDeviceId: string | null;
  /** `AppEntry`-derived, so null for every other kind. */
  modelKey: string | null;
  entryId: string | null;
  sentAt: number | null;
  payload: string;
}

/** One stored entry (`KIT_API.md` §8.1). `data` is the app's JSON, stored verbatim. */
export interface StoredEntry {
  id: string;
  data: string;
  sentAt: number;
  authorDeviceId: string;
  localMetadata: string | null;
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
 * else falls back to a per-method code (e.g. "ENTRY_PUT_ERROR").
 *
 * `DIRECT_ROUTING_UNRESOLVED` is app-owned (`DOMAIN_CONTRACT.md`), raised
 * by `src/domain/audience.ts`, and therefore excluded from native errors.
 */
export type ObscuraErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'NOT_PROVISIONED'
  | 'NOT_FRIENDS'
  | 'NO_DEVICES'
  | 'NO_MESSENGER'
  | 'TIMEOUT'
  | 'DEVICE_LINK_FAILED'
  | 'SEND_FAILED';

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
  logout: (): Promise<void> => Bridge.logout(),

  // State
  getConnectionState: (): Promise<ConnectionState> => Bridge.getConnectionState(),
  getAuthState: (): Promise<AuthState> => Bridge.getAuthState(),
  getUserId: (): Promise<string | null> => Bridge.getUserId(),
  getUsername: (): Promise<string | null> => Bridge.getUsername(),
  getDeviceId: (): Promise<string | null> => Bridge.getDeviceId(),

  // Friends
  acceptFriend: (userId: string): Promise<void> =>
    Bridge.acceptFriend(userId),

  getFriendCode: (): Promise<string> => Bridge.getFriendCode(),
  addFriendByCode: (code: string): Promise<void> => Bridge.addFriendByCode(code),
  getFriends: (): Promise<Friend[]> => Bridge.getFriends(),

  // Device linking
  generateLinkCode: (): Promise<string> => Bridge.generateLinkCode(),
  validateAndApproveLink: (code: string): Promise<void> =>
    Bridge.validateAndApproveLink(code),

  // ─── Kit data surface (obscura-native/docs/KIT_API.md §3, §5, §8.1) ────
  //
  // `inbox` is how messages arrive, `entries` is where the app keeps what it made of them, and
  // `sendEntry` is how they leave. Nothing here parses a payload on either side of the bridge.

  /** Rows waiting, oldest first. Side-effect free — peeking twice returns the same rows. */
  inboxPeek: (limit = 50): Promise<InboxRow[]> => Bridge.inboxPeek(limit),

  /** Drop rows the app has durably processed. Idempotent; a subset is fine. */
  inboxConsume: (ids: number[]): Promise<void> => Bridge.inboxConsume(ids),

  /**
   * Drop rows the app can NEVER process. This is data loss chosen deliberately — the server's copy
   * is already gone — so `reason` is required and the kit logs it as a security event (§3.3 rule 5).
   */
  inboxDiscard: (ids: number[], reason: string): Promise<void> =>
    Bridge.inboxDiscard(ids, reason),

  /** How many rows are waiting. Unbounded growth means the app stopped draining (§3.3 rule 7). */
  inboxDepth: (): Promise<number> => Bridge.inboxDepth(),

  /** Blind upsert — the APP decides who wins, so merge before calling this (§8.1). */
  entryPut: (
    model: string,
    id: string,
    dataJson: string,
    sentAt: number,
    authorDeviceId: string,
    localMetadataJson: string | null = null,
  ): Promise<void> =>
    Bridge.entryPut(model, id, dataJson, sentAt, authorDeviceId, localMetadataJson),

  entryAll: (model: string): Promise<StoredEntry[]> => Bridge.entryAll(model),

  /** The caller names recipients (DOMAIN_CONTRACT). The kit resolves no entry audience. */
  sendEntry: (
    recipientUserIds: string[], modelKey: string, entryId: string,
    sentAt: number, payloadJson: string,
  ): Promise<void> =>
    Bridge.sendEntry(recipientUserIds, modelKey, entryId, sentAt, payloadJson),

  // Signals (typing)
  sendTyping: (recipientUserIds: string[], conversationId: string): Promise<void> =>
    Bridge.sendTyping(recipientUserIds, conversationId),

  stopTyping: (recipientUserIds: string[], conversationId: string): Promise<void> =>
    Bridge.stopTyping(recipientUserIds, conversationId),

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

  // Push notifications. Android emits `pushTokenReceived` after a granted
  // permission request and on Firebase token rotation. iOS token forwarding is
  // not wired. Consumers register every token event with the server.
  requestPushPermission: (): Promise<boolean> => Bridge.requestPushPermission(),
  registerPushToken: (token: string): Promise<void> => Bridge.registerPushToken(token),

  // Misc
  getDebugLog: (): Promise<string[]> => Bridge.getDebugLog(),
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
  'friendsChanged',
  'messageReceived',
  'typingChanged',
  'pushTokenReceived',
] as const;

export type ObscuraEventType = (typeof OBSCURA_EVENT_TYPES)[number];

export type ObscuraEvent =
  | { type: 'connectionChanged'; state: ConnectionState }
  | { type: 'authStateChanged'; state: AuthState }
  | { type: 'authFailed'; reason: string }
  | { type: 'appStateChanged'; state: AppLifecycleState }
  | { type: 'launchedFrom'; screen: string }
  | { type: 'friendsChanged' }
  | { type: 'messageReceived'; model: string }
  | { type: 'typingChanged'; conversationId: string; typers: string[] }
  | { type: 'pushTokenReceived'; token: string };

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
