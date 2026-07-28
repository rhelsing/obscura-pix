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
 * ## The thin kit surface
 *
 * `inboxPeek` / `inboxConsume` / `inboxDiscard` / `inboxDepth`, `entryPut` / `entryAll` /
 * `entryDelete`, and `sendEntry` mirror the shape both kits shipped (`KIT_API.md` §3, §5, §8.1) —
 * added only AFTER the kits designed it, never before, so the double never becomes the place an API
 * is invented.
 *
 * The properties that matter are modelled faithfully because the app's correctness depends on them:
 * `inboxPeek` is side-effect free, ids are monotonic and never reused, `entryPut` is a BLIND upsert
 * (the app decides who wins), and `sendEntry` produces no local row — the sender writes its own copy.
 */

import type { Friend, InboxRow, ModelEntry, StoredEntry } from '../ObscuraModule';

/**
 * An ORM-era row: a `ModelEntry` plus the tombstone flag the old engine kept.
 *
 * Named `OrmRow`, not `StoredEntry`, because `StoredEntry` is the thin kit's public type for the
 * NEW entry store and the two are different shapes — that one carries `data` as an opaque JSON
 * string, this one as a parsed map. They coexist only until §10 step 4.
 */
interface OrmRow extends ModelEntry {
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
function winner(rule: MergeRule, existing: OrmRow, incoming: OrmRow): OrmRow {
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
  private entries = new Map<string, Map<string, OrmRow>>();
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

  private table(model: string): Map<string, OrmRow> {
    let t = this.entries.get(model);
    if (!t) {
      t = new Map();
      this.entries.set(model, t);
    }
    return t;
  }

  // ─── The thin kit surface ──────────────────────────────────────────────

  private inbox: InboxRow[] = [];
  /** Never reused, exactly like the kits' `AUTOINCREMENT`: a drained inbox must not reissue ids. */
  private nextInboxId = 1;
  private storedEntries = new Map<string, Map<string, StoredEntry>>();

  /** What `sendEntry` put on the wire, in order. The app's outgoing audience decisions, observable. */
  readonly __sent: Array<{
    recipientUserIds: string[]; modelKey: string; entryId: string;
    op: string; sentAt: number; payloadJson: string;
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
    await this.inboxConsume(ids);
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

  async entryDelete(model: string, id: string): Promise<void> {
    this.record('entryDelete');
    this.checkFailure('entryDelete');
    this.entryTable(model).delete(id);
  }

  async sendEntry(
    recipientUserIds: string[], modelKey: string, entryId: string,
    op: string, sentAt: number, payloadJson: string,
  ): Promise<void> {
    this.record('sendEntry');
    this.checkFailure('sendEntry');
    // No local row and no inbox row — §5 property 2. The sender writes its own copy, so a test that
    // forgets to will see an empty store rather than a silently-correct one.
    this.__sent.push({ recipientUserIds, modelKey, entryId, op, sentAt, payloadJson });
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
    const incoming: OrmRow = {
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

  /**
   * Simulate a message arriving: the kit persists an inbox row, then notifies. Merge-before-notify
   * is the kit's order and the reason "event → drain" is safe.
   *
   * Defaults describe a well-formed MODEL_SYNC, so a test only states what it is varying.
   */
  __deliverInbox(row: Partial<InboxRow> & { payload: string }): InboxRow {
    const full: InboxRow = {
      id: this.nextInboxId++,
      envelopeId: `env_${this.nextInboxId}`,
      kind: 'MODEL_SYNC',
      receivedAt: this.nextTimestamp(),
      senderUserId: 'user_peer',
      senderDeviceId: 'device_peer',
      senderDisplayName: 'peer',
      modelKey: 'directMessage',
      entryId: `entry_${this.nextInboxId}`,
      op: 'CREATE',
      sentAt: this.nextTimestamp(),
      ...row,
    };
    this.inbox.push(full);
    this.__emit({ type: 'messageReceived', model: full.modelKey ?? '' });
    return full;
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
  __rawEntries(model: string): OrmRow[] {
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

  async disconnect(): Promise<void> {
    this.record('disconnect');
    this.__setConnectionState('disconnected');
  }

  async logout(): Promise<void> {
    this.record('logout');
    this.checkFailure('logout');
    this.entries.clear();
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
    const entry: OrmRow = {
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
    const incoming: OrmRow = {
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
