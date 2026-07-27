/**
 * An in-memory stand-in for the native `ObscuraBridge`.
 *
 * ## Why this exists
 *
 * `ObscuraModule.ts` binds its `Bridge` at import time from `TurboModuleRegistry` / `NativeModules`,
 * and under jest neither exists — so it falls back to `new Proxy({}, { get: () => noop })`, where
 * **every one of the 41 bridge methods resolves `null`**. `getEmitter()` likewise returns `null`
 * when the native module is absent, so `onObscuraEvent` hands back a no-op unsubscribe and no event
 * ever fires. Both directions are dead. That is why pix's suite covers a pure function and nothing
 * else: nothing else was reachable.
 *
 * That matters now because of what `obscura-proto/PLAN.md` Phase 3 does. Migration step 3 is "pix
 * switches to the new API" — the app stops calling the ORM and starts driving an inbox with its own
 * merge — and that switch is *entirely* bridge-mediated. Against a noop bridge, a test of it passes
 * whether or not it works. Worse, the reset **deletes the 722 kit tests that currently guarantee
 * this behaviour**, so the oracle disappears at the moment it is most needed. This double is what
 * makes the destination testable before the source is gone.
 *
 * ## What it is, and what it must never become
 *
 * A **fake**, not a mock: it has real semantics (entries persist, merges resolve, events fire) so
 * tests can assert on behaviour rather than on which methods were called. But it is deliberately
 * *not* a kit:
 *
 *   - no crypto, no Signal sessions, no network, no persistence across instances;
 *   - `userId` / `deviceId` are whatever you set, with no authentication of any kind;
 *   - it models the **bridge contract**, not the kit's internals.
 *
 * The failure mode to guard against is the one `KIT_API.md` §9 names for the query API: it grows a
 * filter, then an index, then real merge policy, and becomes a third implementation that has to be
 * kept in step with two real ones. If a test needs the fake to grow a behaviour, check first that
 * the behaviour is part of the *bridge contract* and not part of the kit.
 *
 * ## Scope note: no inbox methods yet, on purpose
 *
 * `peek` / `consume` / `discard` / `inboxDepth` are absent because **the kits have not designed them
 * yet** — `KIT_API.md` §10 has Kotlin designing first and Swift porting the proven shape. Adding
 * them here would be designing the API inside its own test double, which is exactly backwards. When
 * the Kotlin shape lands, they slot in beside `allEntries` and the `__deliver*` controls below are
 * the model for how to drive them.
 */

import type { Friend, ModelEntry } from '../ObscuraModule';

/** A stored entry plus the merge metadata the kit keeps in columns beside the payload. */
interface StoredEntry extends ModelEntry {
  deleted?: boolean;
}

/** How a model reconciles two writes to the same id. Mirrors `src/domain/merge.ts`. */
type MergeRule = 'APPEND' | 'REPLACE';

/**
 * The `sync` strategy in `schema.ts` decides the rule: `gset` is an immutable set (first write
 * wins), `lww` is last-writer-wins. Unknown or absent defaults to REPLACE, which is the
 * conservative choice — treating a mutable model as immutable would silently drop updates.
 */
function ruleFor(sync: unknown): MergeRule {
  return sync === 'gset' ? 'APPEND' : 'REPLACE';
}

/**
 * The kit's conflict resolution, duplicated here in ~6 lines rather than imported from
 * `src/domain/merge.ts`.
 *
 * That is deliberate. `merge.ts` is the app's *replacement* for this logic; this fake stands in for
 * the *kit* that still owns it today. Importing one into the other would make a test of "does the
 * app agree with the kit" tautological — both sides would be the same function. Six duplicated
 * lines is the price of the two staying independently checkable, and `merge.vectors.test.ts` pins
 * the real contract for both against `obscura-proto/conformance/merge.json`.
 */
function winner(rule: MergeRule, existing: StoredEntry, incoming: StoredEntry): StoredEntry {
  if (rule === 'APPEND') return existing;
  if (incoming.timestamp > existing.timestamp) return incoming;
  if (incoming.timestamp < existing.timestamp) return existing;
  return incoming.authorDeviceId > existing.authorDeviceId ? incoming : existing;
}

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
  private schema: Record<string, any> = {};
  private entries = new Map<string, Map<string, StoredEntry>>();
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

  private table(model: string): Map<string, StoredEntry> {
    let t = this.entries.get(model);
    if (!t) {
      t = new Map();
      this.entries.set(model, t);
    }
    return t;
  }

  // ─── Test controls (`__` prefix — NOT part of the native surface) ───

  /** Emit a raw event exactly as the native side would. */
  __emit(event: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l(event);
  }

  /**
   * Simulate an entry arriving from a peer: merge it by the model's rule, then emit
   * `messageReceived` the way the native bridge does after a MODEL_SYNC lands.
   *
   * This is the control that makes the receive path testable at all. Note it merges *before* it
   * emits — the same order the kit uses, and the reason pix's "event → refetch everything" pattern
   * is safe today.
   */
  __deliverEntry(
    model: string,
    entry: { id: string; data: Record<string, any>; timestamp?: number; authorDeviceId?: string },
  ): void {
    const incoming: StoredEntry = {
      id: entry.id,
      data: entry.data,
      timestamp: entry.timestamp ?? this.nextTimestamp(),
      authorDeviceId: entry.authorDeviceId ?? 'device_peer',
    };
    const table = this.table(model);
    const existing = table.get(incoming.id);
    table.set(incoming.id, existing ? winner(ruleFor(this.schema[model]?.sync), existing, incoming) : incoming);
    this.__emit({ type: 'messageReceived', model });
  }

  /** Deliver the same entry twice, as a redelivered envelope would. Convergence must hold. */
  __deliverEntryTwice(model: string, entry: Parameters<FakeObscuraBridge['__deliverEntry']>[1]): void {
    this.__deliverEntry(model, entry);
    this.__deliverEntry(model, entry);
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
  __rawEntries(model: string): StoredEntry[] {
    return [...this.table(model).values()];
  }

  /**
   * Clear all state, **in place**.
   *
   * In place is not a detail: `ObscuraModule.ts` captures its `Bridge` reference at import time and
   * caches the `NativeEventEmitter` built from it, so swapping in a new instance between tests
   * would leave the module pointing at the old one. Everything below mutates rather than reassigns
   * for that reason. Called automatically from `beforeEach` by the jest setup.
   */
  __reset(): void {
    this.schema = {};
    this.entries.clear();
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

  async disconnect(): Promise<void> {
    this.record('disconnect');
    this.__setConnectionState('disconnected');
  }

  async logout(): Promise<void> {
    this.record('logout');
    this.checkFailure('logout');
    this.entries.clear();
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

  async befriend(userId: string, username: string): Promise<void> {
    this.record('befriend');
    this.checkFailure('befriend');
    this.__setFriends([...this.friends, { userId, username, status: 'pending_sent' }]);
  }

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
    await this.befriend(userId, username ?? userId);
  }

  async getFriends(): Promise<Friend[]> {
    this.record('getFriends');
    return [...this.friends];
  }

  async getPendingRequests(): Promise<Friend[]> {
    this.record('getPendingRequests');
    return this.friends.filter((f) => f.status !== 'accepted');
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

  // ─── ORM ───────────────────────────────────────────────
  //
  // NOTE the JSON boundary: `defineModels`, `createEntry`, `upsertEntry` and `queryEntries` receive
  // a STRING from the wrapper, which stringifies. Parsing it here rather than accepting an object
  // is what makes a wrapper that forgets to stringify fail a test instead of working by accident.

  async defineModels(schemaJson: string): Promise<void> {
    this.record('defineModels');
    this.checkFailure('defineModels');
    if (typeof schemaJson !== 'string') {
      throw new Error('defineModels expects a JSON string across the bridge, got ' + typeof schemaJson);
    }
    this.schema = JSON.parse(schemaJson);
  }

  async createEntry(model: string, dataJson: string): Promise<ModelEntry> {
    this.record('createEntry');
    this.checkFailure('createEntry');
    if (typeof dataJson !== 'string') {
      throw new Error('createEntry expects a JSON string across the bridge, got ' + typeof dataJson);
    }
    const timestamp = this.nextTimestamp();
    const entry: StoredEntry = {
      id: `${model}_${timestamp}`,
      data: JSON.parse(dataJson),
      timestamp,
      authorDeviceId: this.deviceId,
    };
    this.table(model).set(entry.id, entry);
    this.__emit({ type: 'entriesChanged', model });
    return { ...entry };
  }

  async upsertEntry(model: string, id: string, dataJson: string): Promise<ModelEntry> {
    this.record('upsertEntry');
    this.checkFailure('upsertEntry');
    if (typeof dataJson !== 'string') {
      throw new Error('upsertEntry expects a JSON string across the bridge, got ' + typeof dataJson);
    }
    const table = this.table(model);
    const existing = table.get(id);
    const incoming: StoredEntry = {
      id,
      // Upsert replaces the payload wholesale — it is not a field-level patch. Matching that here
      // keeps a caller that assumes patch semantics from passing under test and failing on device.
      data: JSON.parse(dataJson),
      timestamp: this.nextTimestamp(),
      authorDeviceId: this.deviceId,
    };
    table.set(id, existing ? winner(ruleFor(this.schema[model]?.sync), existing, incoming) : incoming);
    this.__emit({ type: 'entriesChanged', model });
    return { ...table.get(id)! };
  }

  async allEntries(model: string): Promise<ModelEntry[]> {
    this.record('allEntries');
    this.checkFailure('allEntries');
    // Tombstones are filtered by the kit (`store.ts` documents this), so they never reach the app.
    return this.__rawEntries(model)
      .filter((e) => !e.deleted)
      .map((e) => ({ ...e }));
  }

  async queryEntries(model: string, conditionsJson: string): Promise<ModelEntry[]> {
    this.record('queryEntries');
    this.checkFailure('queryEntries');
    const conditions: Record<string, unknown> = JSON.parse(conditionsJson);
    const all = await this.allEntries(model);
    return all.filter((e) => Object.entries(conditions).every(([k, v]) => e.data[k] === v));
  }

  async deleteEntry(model: string, id: string): Promise<void> {
    this.record('deleteEntry');
    this.checkFailure('deleteEntry');
    const existing = this.table(model).get(id);
    if (existing) existing.deleted = true;
    this.__emit({ type: 'entriesChanged', model });
  }

  // ─── Signals ───────────────────────────────────────────

  async sendTyping(_conversationId: string): Promise<void> {
    this.record('sendTyping');
  }
  async stopTyping(_conversationId: string): Promise<void> {
    this.record('stopTyping');
  }
  async observeTyping(_conversationId: string): Promise<void> {
    this.record('observeTyping');
  }
  async stopObservingTyping(_conversationId: string): Promise<void> {
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
  async setSecureScreen(_enabled: boolean): Promise<void> {
    this.record('setSecureScreen');
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
