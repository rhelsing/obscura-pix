/**
 * An in-memory stand-in for the native `ObscuraBridge`.
 *
 * Jest has no native module or event emitter, so tests install this fake before
 * importing `ObscuraModule`. It persists entries and inbox rows and emits events,
 * allowing tests to exercise the real TypeScript bridge facade.
 *
 * It deliberately does not model kit internals:
 *
 *   - no crypto, no Signal sessions, no network, no persistence across instances;
 *   - `userId` / `deviceId` are whatever you set, with no authentication of any kind;
 *   - it models the **bridge contract**, not the kit's internals.
 *
 * `inboxPeek` / `inboxConsume` / `inboxDiscard` / `inboxDepth`, `entryPut` / `entryAll`, and
 * `sendEntry` mirror the kit surface (`KIT_API.md` §3, §5, §8.1).
 *
 * The properties that matter are modelled faithfully because the app's correctness depends on them:
 * `inboxPeek` is side-effect free, ids are monotonic and never reused, `entryPut` is a BLIND upsert
 * (the app decides who wins), and `sendEntry` produces no local row — the sender writes its own copy.
 */

import type { Friend, InboxRow, StoredEntry } from '../ObscuraModule';

export interface FakeBridgeOptions {
  userId?: string;
  username?: string;
  deviceId?: string;
}

export class FakeObscuraBridge {
  // ─── Session ───────────────────────────────────────────
  userId: string;
  username: string;
  deviceId: string;
  authState: 'loggedOut' | 'authenticated' | 'pendingApproval' = 'loggedOut';
  connectionState: 'disconnected' | 'connecting' | 'reconnecting' | 'connected' = 'disconnected';

  // ─── Stores ────────────────────────────────────────────
  private friends: Friend[] = [];
  private listeners = new Set<(event: any) => void>();
  private debugLog: string[] = [];
  private pushToken: string | null = null;

  /**
   * Monotonic clock. Real `Date.now()` has millisecond resolution, so two writes in the same tick
   * collide — and an equal-timestamp collision is resolved by `authorDeviceId`, which in a
   * single-device test is *the same value*, making the outcome arrival-order dependent. That is a
   * flake generator. A counter makes local writes strictly ordered; tests that care about ties set
   * timestamps explicitly through `__deliverEntry`.
   */
  private clock = 1_700_000_000_000;
  private nextTimestamp(): number {
    return ++this.clock;
  }

  /**
   * Every bridge call, in order, as `"methodName"`. Use it to assert what actually crossed the
   * bridge — the one thing a fake can prove that the real kit cannot, since the boundary is the
   * contract under test.
   */
  readonly __calls: string[] = [];

  constructor(opts: FakeBridgeOptions = {}) {
    this.userId = opts.userId ?? 'user_self';
    this.username = opts.username ?? 'self';
    this.deviceId = opts.deviceId ?? 'device_self';
  }

  private record(method: string): void {
    this.__calls.push(method);
  }

  // ─── The thin kit surface ──────────────────────────────────────────────

  private inbox: InboxRow[] = [];
  /** Never reused, exactly like the kits' `AUTOINCREMENT`: a drained inbox must not reissue ids. */
  private nextInboxId = 1;
  private storedEntries = new Map<string, Map<string, StoredEntry>>();

  /** What `sendEntry` put on the wire, in order. The app's outgoing audience decisions, observable. */
  readonly __sent: Array<{
    recipientUserIds: string[]; modelKey: string; entryId: string;
    sentAt: number; payloadJson: string;
  }> = [];

  /** Rows the app discarded, with the reason. Data loss must be visible in a test, not silent. */
  readonly __discarded: Array<{ ids: number[]; reason: string }> = [];

  private entryTable(model: string): Map<string, StoredEntry> {
    let t = this.storedEntries.get(model);
    if (!t) {
      t = new Map();
      this.storedEntries.set(model, t);
    }
    return t;
  }

  async inboxPeek(limit: number): Promise<InboxRow[]> {
    this.record('inboxPeek');
    this.checkFailure('inboxPeek');
    // Side-effect free (§3.3 rule 3): peeking twice without consuming returns the same rows. Copies
    // are returned so a test mutating a row cannot corrupt the store and mask a bug.
    return this.inbox.slice(0, limit).map((r) => ({ ...r }));
  }

  async inboxConsume(ids: number[]): Promise<void> {
    this.record('inboxConsume');
    this.checkFailure('inboxConsume');
    const drop = new Set(ids);
    this.inbox = this.inbox.filter((r) => !drop.has(r.id));
  }

  async inboxDiscard(ids: number[], reason: string): Promise<void> {
    this.record('inboxDiscard');
    this.checkFailure('inboxDiscard');
    if (ids.length === 0) return; // an empty discard is not a data-loss event
    this.__discarded.push({ ids, reason });
    // Deletes the rows itself rather than delegating to `inboxConsume`. Delegating pushed an extra
    // `'inboxConsume'` onto `__calls`, so an ordering assertion of the shape
    // `__calls.indexOf('inboxConsume')` read a DISCARD as a consume as soon as a batch contained
    // both — and the assertion it silently weakened is the one guarding write-before-consume.
    const drop = new Set(ids);
    this.inbox = this.inbox.filter((r) => !drop.has(r.id));
  }

  async inboxDepth(): Promise<number> {
    this.record('inboxDepth');
    this.checkFailure('inboxDepth');
    return this.inbox.length;
  }

  async entryPut(model: string, id: string, dataJson: string, sentAt: number, authorDeviceId: string): Promise<void> {
    this.record('entryPut');
    this.checkFailure('entryPut');
    if (typeof dataJson !== 'string') {
      throw new Error('entryPut expects a JSON string across the bridge, got ' + typeof dataJson);
    }
    // BLIND, exactly like the kits: an older write overwrites a newer one, because by the time a
    // write gets here the app has already decided who wins. A double that merged would hide an app
    // that forgot to.
    this.entryTable(model).set(id, { id, data: dataJson, sentAt, authorDeviceId });
  }

  async entryAll(model: string): Promise<StoredEntry[]> {
    this.record('entryAll');
    this.checkFailure('entryAll');
    return [...this.entryTable(model).values()].map((e) => ({ ...e }));
  }

  async sendEntry(
    recipientUserIds: string[], modelKey: string, entryId: string,
    sentAt: number, payloadJson: string,
  ): Promise<void> {
    this.record('sendEntry');
    this.checkFailure('sendEntry');
    // No local row and no inbox row — §5 property 2. The sender writes its own copy, so a test that
    // forgets to will see an empty store rather than a silently-correct one.
    this.__sent.push({ recipientUserIds, modelKey, entryId, sentAt, payloadJson });
  }

  // ─── Test controls (`__` prefix — NOT part of the native surface) ───

  /** Emit a raw event exactly as the native side would. */
  __emit(event: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(event);
  }

  /**
   * Simulate a message arriving: the kit persists an inbox row, then notifies. Merge-before-notify
   * is the kit's order and the reason "event → drain" is safe.
   *
   * Defaults describe a well-formed APP_ENTRY, so a test only states what it is varying.
   *
   * **Deduped on `envelopeId`**, because both kits are `UNIQUE(envelope_id)` + `INSERT OR IGNORE`
   * (KIT_API §3.3 rule 8). Without it a test could build a two-rows-one-envelope state the real kits
   * cannot produce — and redelivery is guaranteed by persist-then-ack, so that is precisely the
   * state the dedupe key exists to prevent. A redelivery is still observable: pass the same
   * `envelopeId` and the second call returns the existing row rather than adding one.
   */
  __deliverInbox(row: Partial<InboxRow> & { payload: string }): InboxRow {
    const id = this.nextInboxId;
    const full: InboxRow = {
      id,
      envelopeId: `env_${id}`,
      kind: 'APP_ENTRY',
      receivedAt: this.nextTimestamp(),
      senderUserId: 'user_peer',
      senderDeviceId: 'device_peer',
      senderDisplayName: 'peer',
      modelKey: 'directMessage',
      entryId: `entry_${id}`,
      sentAt: this.nextTimestamp(),
      ...row,
    };
    const existing = this.inbox.find((r) => r.envelopeId === full.envelopeId);
    if (existing) return { ...existing };
    this.nextInboxId += 1;
    this.inbox.push(full);
    this.__emit({ type: 'messageReceived', model: full.modelKey ?? '' });
    return full;
  }

  /**
   * Put the double in the state every drain test needs: an authenticated session.
   *
   * `getUserId()` resolves `null` while logged out, and the drain refuses to authorize anything
   * without an identity — so a test that skips this drains nothing, which is the correct behaviour
   * and a confusing way to discover it.
   */
  __authenticate(opts: FakeBridgeOptions = {}): void {
    if (opts.userId !== undefined) this.userId = opts.userId;
    if (opts.username !== undefined) this.username = opts.username;
    if (opts.deviceId !== undefined) this.deviceId = opts.deviceId;
    this.__setAuthState('authenticated');
  }

  /** Set the friend graph and emit `friendsUpdated`, as the kit does when it changes. */
  __setFriends(friends: Friend[]): void {
    this.friends = friends;
    this.__emit({ type: 'friendsUpdated', friends });
  }

  /** Flip auth state and emit, as login/logout does. */
  __setAuthState(state: 'loggedOut' | 'authenticated' | 'pendingApproval'): void {
    this.authState = state;
    this.__emit({ type: 'authStateChanged', state });
  }

  /** Flip connection state and emit. */
  __setConnectionState(state: 'disconnected' | 'connecting' | 'reconnecting' | 'connected'): void {
    this.connectionState = state;
    this.__emit({ type: 'connectionChanged', state });
  }

  /** Raw entry table for a model, for assertions the public API cannot express. */
  /**
   * Clear all state, **in place**.
   *
   * In place is not a detail: `ObscuraModule.ts` captures its `Bridge` reference at import time and
   * caches the `NativeEventEmitter` built from it, so swapping in a new instance between tests
   * would leave the module pointing at the old one. Everything below mutates rather than reassigns
   * for that reason. Called automatically from `beforeEach` by the jest setup.
   */
  __reset(): void {
    this.inbox.length = 0;
    this.nextInboxId = 1;
    this.storedEntries.clear();
    this.__sent.length = 0;
    this.__discarded.length = 0;
    this.friends = [];
    this.listeners.clear();
    this.debugLog.length = 0;
    this.failures.clear();
    this.__calls.length = 0;
    this.pushToken = null;
    this.userId = 'user_self';
    this.username = 'self';
    this.deviceId = 'device_self';
    this.authState = 'loggedOut';
    this.connectionState = 'disconnected';
    this.clock = 1_700_000_000_000;
  }

  /** How many handlers are subscribed. Catches leaked subscriptions in unmount tests. */
  __listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Make the next call to `method` reject, as a native failure would.
   *
   * The app's error paths are otherwise untestable: every call resolves, so `.catch(...)` branches
   * are dead code under test. `code` mirrors `ObscuraErrorCode`.
   */
  private failures = new Map<string, { code: string; message: string }>();
  __failNext(method: string, code: string, message = 'fake failure'): void {
    this.failures.set(method, { code, message });
  }

  private checkFailure(method: string): void {
    const f = this.failures.get(method);
    if (!f) return;
    this.failures.delete(method);
    const err: Error & { code?: string } = new Error(f.message);
    err.code = f.code;
    throw err;
  }

  // ─── Event subscription (what `NativeEventEmitter` drives) ───

  addListener(_eventName: string, handler?: (event: any) => void): { remove: () => void } {
    if (handler) this.listeners.add(handler);
    return {
      remove: () => {
        if (handler) this.listeners.delete(handler);
      },
    };
  }

  removeListeners(_count: number): void {
    // RN calls this on teardown; the per-subscription `remove()` above does the real work.
  }

  // ─── Auth ──────────────────────────────────────────────

  async registerUser(username: string, _password: string): Promise<void> {
    this.record('registerUser');
    this.checkFailure('registerUser');
    this.username = username;
    this.__setAuthState('authenticated');
  }

  async loginSmart(username: string, _password: string): Promise<string> {
    this.record('loginSmart');
    this.checkFailure('loginSmart');
    this.username = username;
    this.__setAuthState('authenticated');
    return 'existingDevice';
  }

  async loginAndProvision(username: string, _password: string): Promise<void> {
    this.record('loginAndProvision');
    this.checkFailure('loginAndProvision');
    this.username = username;
    this.__setAuthState('authenticated');
  }

  async connect(): Promise<void> {
    this.record('connect');
    this.checkFailure('connect');
    this.__setConnectionState('connected');
  }

  async logout(): Promise<void> {
    this.record('logout');
    this.checkFailure('logout');
    this.inbox.length = 0;
    this.nextInboxId = 1;
    this.storedEntries.clear();
    this.__sent.length = 0;
    this.__discarded.length = 0;
    this.friends = [];
    this.__setConnectionState('disconnected');
    this.__setAuthState('loggedOut');
  }

  // ─── State ─────────────────────────────────────────────

  async getConnectionState(): Promise<string> {
    this.record('getConnectionState');
    return this.connectionState;
  }
  async getAuthState(): Promise<string> {
    this.record('getAuthState');
    return this.authState;
  }
  async getUserId(): Promise<string | null> {
    this.record('getUserId');
    return this.authState === 'authenticated' ? this.userId : null;
  }
  async getUsername(): Promise<string | null> {
    this.record('getUsername');
    return this.authState === 'authenticated' ? this.username : null;
  }
  async getDeviceId(): Promise<string | null> {
    this.record('getDeviceId');
    return this.authState === 'authenticated' ? this.deviceId : null;
  }

  // ─── Friends ───────────────────────────────────────────

  async acceptFriend(userId: string, username: string): Promise<void> {
    this.record('acceptFriend');
    this.checkFailure('acceptFriend');
    const rest = this.friends.filter((f) => f.userId !== userId);
    this.__setFriends([...rest, { userId, username, status: 'accepted' }]);
  }

  async getFriendCode(): Promise<string> {
    this.record('getFriendCode');
    return `${this.userId}:${this.username}`;
  }

  async addFriendByCode(code: string): Promise<void> {
    this.record('addFriendByCode');
    this.checkFailure('addFriendByCode');
    const [userId, username] = code.split(':');
    this.__setFriends([
      ...this.friends,
      { userId, username: username ?? userId, status: 'pending_sent' },
    ]);
  }

  async getFriends(): Promise<Friend[]> {
    this.record('getFriends');
    return [...this.friends];
  }

  // ─── Device linking ────────────────────────────────────

  async generateLinkCode(): Promise<string> {
    this.record('generateLinkCode');
    return 'LINK-0000';
  }
  async validateAndApproveLink(_code: string): Promise<void> {
    this.record('validateAndApproveLink');
    this.checkFailure('validateAndApproveLink');
  }

  // ─── Signals ───────────────────────────────────────────

  async sendTyping(_modelKey: string, _conversationId: string): Promise<void> {
    this.record('sendTyping');
  }
  async stopTyping(_modelKey: string, _conversationId: string): Promise<void> {
    this.record('stopTyping');
  }
  async observeTyping(_modelKey: string, _conversationId: string): Promise<void> {
    this.record('observeTyping');
  }
  async stopObservingTyping(_modelKey: string, _conversationId: string): Promise<void> {
    this.record('stopObservingTyping');
  }

  // ─── Attachments and media ─────────────────────────────
  //
  // Path-based, as the real bridge is: JS never holds the bytes. These return plausible values and
  // touch no filesystem — a test asserting on file contents is testing the fake, not the app.

  async uploadAttachment(filePath: string): Promise<{ id: string; contentKey: string; nonce: string }> {
    this.record('uploadAttachment');
    this.checkFailure('uploadAttachment');
    return { id: `att_${this.nextTimestamp()}`, contentKey: 'key_' + filePath.length, nonce: 'nonce' };
  }

  async downloadAttachment(id: string, _contentKey: string, _nonce: string): Promise<string> {
    this.record('downloadAttachment');
    this.checkFailure('downloadAttachment');
    return `/fake/cache/${id}`;
  }

  async resizeImage(srcPath: string, maxDim: number, _quality: number): Promise<{ path: string; width: number; height: number }> {
    this.record('resizeImage');
    return { path: srcPath, width: maxDim, height: maxDim };
  }

  async writeTestImage(width: number, height: number): Promise<{ path: string; width: number; height: number }> {
    this.record('writeTestImage');
    return { path: '/fake/test.jpg', width, height };
  }

  // ─── Push ──────────────────────────────────────────────

  async requestPushPermission(): Promise<boolean> {
    this.record('requestPushPermission');
    this.checkFailure('requestPushPermission');
    return true;
  }

  async registerPushToken(token: string): Promise<void> {
    this.record('registerPushToken');
    this.checkFailure('registerPushToken');
    this.pushToken = token;
  }

  /** The token the app last registered, or null. */
  __registeredPushToken(): string | null {
    return this.pushToken;
  }

  // ─── Misc ──────────────────────────────────────────────

  async getDebugLog(): Promise<string[]> {
    this.record('getDebugLog');
    return [...this.debugLog];
  }
  async prewarmAudioSession(): Promise<void> {
    this.record('prewarmAudioSession');
  }
  async deleteFile(_path: string): Promise<void> {
    this.record('deleteFile');
  }
  async setClipboard(_text: string): Promise<void> {
    this.record('setClipboard');
  }
  async getLaunchIntent(): Promise<{ screen: string } | null> {
    this.record('getLaunchIntent');
    return null;
  }
}
