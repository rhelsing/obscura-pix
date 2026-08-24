import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  Obscura, onObscuraEvent,
  type Friend, type ConnectionState, type ModelEntry, type ObscuraEvent,
} from '../native/ObscuraModule';
import { drainInboxFully } from './drainInbox';
import { writeEntry, flushOutbox } from './writeEntry';
import { logError } from '../utils/log';

/**
 * Process-wide store for session state and application entry caches.
 *
 * Selectors:
 *   - useSession()           — session shape used by every screen
 *   - useModelEntries(model) — auto-refreshing entries for a single model
 *
 * Side effects (event subscription, inbox drain, push permission) live in
 * useObscuraBootstrap which is mounted once at the App root.
 */

interface ObscuraStore {
  // Session
  /**
   * Has the initial cold-start auth check completed? Until this is true,
   * `authed` should not be trusted — RootNavigator shows a splash screen
   * to avoid flashing the AuthScreen for users who are already logged in.
   */
  bootstrapped: boolean;
  authed: boolean;
  myUserId: string;
  myUsername: string;
  myDeviceId: string;
  friends: Friend[];
  pending: Friend[];
  connState: ConnectionState;

  // Per-model entries cache. A `undefined` slot means "never loaded";
  // first useModelEntries(model) triggers the fetch + creates the slot,
  // after which bootstrap keeps it fresh on events.
  entries: Record<string, ModelEntry[] | undefined>;

  // Actions — public
  setAuthed: (v: boolean) => void;
  logout: () => Promise<void>;
  reset: () => void;

  // Actions — internal (called from bootstrap; the underscore prefix is a
  // convention meaning "don't call from screens").
  _setBootstrapped: (v: boolean) => void;
  _setUserId: (id: string) => void;
  _setUsername: (name: string) => void;
  _setDeviceId: (id: string) => void;
  _setFriendsAndPending: (friends: Friend[], pending: Friend[]) => void;
  _setConnState: (s: ConnectionState) => void;
  _setEntries: (model: string, entries: ModelEntry[]) => void;
}

export const useStore = create<ObscuraStore>((set) => ({
  bootstrapped: false,
  authed: false,
  myUserId: '',
  myUsername: '',
  myDeviceId: '',
  friends: [],
  pending: [],
  connState: 'disconnected',
  entries: {},

  setAuthed: (v) => set({ authed: v }),

  logout: async () => {
    try { await Obscura.logout(); } catch (e) { logError('logout', e); }
    set({
      authed: false,
      myUserId: '',
      myUsername: '',
      myDeviceId: '',
      friends: [],
      pending: [],
      connState: 'disconnected',
      entries: {},
    });
  },

  reset: () => set({
    authed: false,
    myUserId: '',
    myUsername: '',
    myDeviceId: '',
    friends: [],
    pending: [],
    connState: 'disconnected',
    entries: {},
  }),

  _setBootstrapped: (v) => set({ bootstrapped: v }),
  _setUserId: (id) => set({ myUserId: id }),
  _setUsername: (name) => set({ myUsername: name }),
  _setDeviceId: (id) => set({ myDeviceId: id }),
  _setFriendsAndPending: (friends, pending) => set({ friends, pending }),
  _setConnState: (s) => set({ connState: s }),
  _setEntries: (model, entries) => set((state) => ({
    entries: { ...state.entries, [model]: entries },
  })),
}));

// ─── Selectors ───────────────────────────────────────────

/**
 * Session shape. Returns a stable object via shallow equality so re-renders
 * only fire when one of the selected fields changes.
 */
export function useSession() {
  return useStore(useShallow((s) => ({
    authed: s.authed,
    myUserId: s.myUserId,
    myUsername: s.myUsername,
    myDeviceId: s.myDeviceId,
    friends: s.friends,
    pending: s.pending,
    connState: s.connState,
    setAuthed: s.setAuthed,
    logout: s.logout,
  })));
}

/**
 * All entries for `model`, auto-loading on first call and auto-refreshing
 * on `messageReceived` (handled centrally in the
 * bootstrap subscription).
 *
 * There is no tombstone filter because the current application and kit APIs have
 * no delete operation.
 */
export function useModelEntries(model: string): ModelEntry[] {
  const entries = useStore((s) => s.entries[model]);
  useEffect(() => {
    if (entries !== undefined) return;
    loadEntries(model);
  }, [model, entries]);
  return entries ?? [];
}

/**
 * Read a model's entries from the kit's entry store and parse them.
 *
 * `data` crosses the bridge as an opaque JSON string — the kit never parses it, which is what keeps
 * nested objects and arrays intact — so the app parses it here, once, on the way in.
 */
export async function loadEntries(model: string): Promise<void> {
  try {
    const stored = await Obscura.entryAll(model);
    const parsed: ModelEntry[] = [];
    for (const e of stored) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        // A row we cannot read is skipped rather than crashing the screen. It is a bug worth fixing,
        // not a reason to show the user nothing.
        logError('entries.parse:' + model, new Error(`entry ${e.id} is not JSON`));
        continue;
      }
      parsed.push({ id: e.id, data, timestamp: e.sentAt, authorDeviceId: e.authorDeviceId });
    }
    useStore.getState()._setEntries(model, parsed);
  } catch (e) {
    logError('entries.load:' + model, e);
  }
}

/**
 * Drain the inbox and refresh whatever it changed.
 *
 * **Every trigger goes through here**, because a drain that only happens on one of them is how
 * messages get stranded — see the triggers wired in `ObscuraBootstrap`.
 */
export async function drainAndRefresh(alsoRefresh?: string): Promise<void> {
  try {
    const result = await drainInboxFully();
    const loaded = useStore.getState().entries;
    const models = new Set(alsoRefresh ? [...result.touched, alsoRefresh] : result.touched);
    for (const model of models) {
      // Only slices a screen has actually displayed — a model nobody has opened does not need to
      // be in memory.
      if (loaded[model] !== undefined) {
        await loadEntries(model).catch((e) => logError('entries.refresh:' + model, e));
      }
    }

    // §3.3 rule 7 / §3.5: a number nobody reads is not observability. If the inbox is not empty
    // after a full drain, the app has stopped keeping up — and the chain that ends in the SERVER
    // silently evicting the user's oldest messages starts exactly here.
    const depth = await Obscura.inboxDepth();
    if (depth > 0) {
      logError('inbox.notDrained', new Error(`${depth} row(s) still in the inbox after a full drain`));
    }
  } catch (e) {
    logError('inbox.drain', e);
  }
}

/**
 * Store an entry and send it to its audience, then refresh the model so the screen shows it.
 *
 * This is the single application write path. It exists at store level rather
 * than as a bare `writeEntry` call because the audience needs the
 * session — who I am, which device, who my friends are — and threading three fields through every
 * screen would invite one of them being passed wrong.
 *
 * The refresh is explicit because `entryPut` is a plain write and emits no event.
 *
 * Throws `DirectRoutingUnresolved` when the audience cannot be resolved — nothing is stored or sent.
 * Callers should surface that: it means the entry reached nobody.
 */
export async function saveEntry(
  model: string,
  data: Record<string, unknown>,
  id?: string,
): Promise<string> {
  const s = useStore.getState();

  // The session loads asynchronously after `authed` flips, and a write in that window is quietly
  // wrong rather than failing: an empty `authorDeviceId` sorts LOWEST, so it loses every REPLACE
  // tie-break on every device (DOMAIN_CONTRACT), and an empty `selfUserId` disables the self-filter in
  // `resolveAudience`. Both are invisible — the entry stores and sends, it just never wins and may
  // name the author as a recipient. Refuse instead.
  if (s.myUserId === '' || s.myDeviceId === '') {
    throw new Error('saveEntry called before the session identity loaded — refusing to write');
  }

  try {
    return await writeEntry({
      model,
      id,
      data,
      selfUserId: s.myUserId,
      myDeviceId: s.myDeviceId,
      // `s.friends` is already the accepted set; `resolveAudience` re-checks status anyway, because a
      // resolver that trusts its caller to have filtered is one refactor away from a leak.
      friends: s.friends,
    });
  } finally {
    // `finally`, not "after the await". `writeEntry` deliberately KEEPS the local row and rethrows
    // when a send reaches nobody, so the refresh must also run on that path.
    //
    // An unresolvable audience throws before anything is stored, so refreshing then is a no-op read
    // rather than a wrong one.
    await loadEntries(model);
  }
}

/**
 * Retry entries whose send reached nobody.
 *
 * The counterpart to `drainAndRefresh`, on the same triggers. It does not refresh the UI: the mark
 * it clears is delivery bookkeeping that nothing renders.
 */
export async function flushOutboxFromStore(): Promise<void> {
  const s = useStore.getState();
  if (s.myUserId === '') return; // pre-identity; the next trigger will catch it
  try {
    await flushOutbox({ selfUserId: s.myUserId, friends: s.friends });
  } catch (e) {
    logError('outbox.flush', e);
  }
}

// ─── Bootstrap ───────────────────────────────────────────

/**
 * Drain the inbox and flush the outbox — the pair of things a "the network moved" signal means.
 *
 * They are always triggered together so the receive and retry paths respond to
 * the same connectivity and lifecycle signals.
 */
function syncBothWays(label: string, alsoRefresh?: string): void {
  drainAndRefresh(alsoRefresh).catch((e) => logError('entries.drain:' + label, e));
  flushOutboxFromStore().catch((e) => logError('outbox.flush:' + label, e));
}

/**
 * Apply one native event to the store.
 *
 * Extracted from the `ObscuraBootstrap` hook so it can be driven directly by a test: every drain
 * trigger in the app is a branch of this switch, and inside a hook none of them were reachable
 * without a React renderer this repo does not depend on. The hook below is now only the
 * subscription.
 */
export function applyObscuraEvent(event: ObscuraEvent): void {
  const s = useStore.getState();
  switch (event.type) {
    case 'friendsUpdated': {
      const all = event.friends || [];
      s._setFriendsAndPending(
        all.filter((f) => f.status === 'accepted'),
        all.filter((f) => f.status !== 'accepted'),
      );
      return;
    }
    case 'connectionChanged':
      s._setConnState(event.state || 'disconnected');
      // Reconnecting is when the server redelivers anything it did not see acked, so it is one
      // of the moments the inbox is most likely to have grown.
      if (event.state === 'connected') syncBothWays('connected');
      return;
    case 'authStateChanged':
      if (event.state === 'loggedOut') { s.reset(); return; }
      // Device-link approval transitions through `pendingApproval` to
      // `authenticated`; update the store so session loading and draining run.
      if (event.state === 'authenticated') s.setAuthed(true);
      return;

    case 'appStateChanged':
      // Native background processing may persist messages while the JS runtime
      // is suspended, so foregrounding must drain again.
      if (event.state === 'active') syncBothWays('foreground');
      return;
    case 'authFailed':
      s.reset();
      return;
    case 'pushTokenReceived': {
      if (!event.token) return;
      const preview = event.token.slice(0, 8) + '...';
      console.log('[push] token received:', preview);
      Obscura.registerPushToken(event.token).catch((e: unknown) => {
        console.warn('[push] token registration failed:', e);
      });
      return;
    }
    case 'messageReceived': {
      // DRAIN FIRST, then refresh. The event is only a wake-up — under the thin kit the data is
      // in the inbox, not in the event, and nothing reaches the entry store until the app moves
      // it there. Refreshing without draining would show a store that has not changed.
      drainAndRefresh(event.model).catch((e) => logError('entries.drain:' + event.model, e));
      return;
    }
  }
}

export async function refreshFriendGraph(): Promise<void> {
  const all = await Obscura.getFriends();
  const list = all || [];
  useStore.getState()._setFriendsAndPending(
    list.filter((f) => f.status === 'accepted'),
    list.filter((f) => f.status !== 'accepted'),
  );
}

/**
 * Pull the session identity and graph, then run the cold-start sync.
 *
 * Extracted from the `[authed]` effect for the same reason as `applyObscuraEvent`: the cold-start
 * drain is the trigger whose absence stranded messages, and it was unreachable from a test.
 */
export async function loadSession(): Promise<void> {
  // `obscuraSchema` stays in the app: `drainInbox` reads its merge and
  // authorization rules, and `writeEntry` reads its audience (DOMAIN_CONTRACT).
  const store = useStore.getState();
  await Promise.all([
    Obscura.getUserId()
      .then((id) => store._setUserId(id || ''))
      .catch((e) => logError('bootstrap.userId', e)),
    Obscura.getUsername()
      .then((name) => store._setUsername(name || ''))
      .catch((e) => logError('bootstrap.username', e)),
    Obscura.getDeviceId()
      .then((id) => store._setDeviceId(id || ''))
      .catch((e) => logError('bootstrap.deviceId', e)),
    refreshFriendGraph().catch((e) => logError('bootstrap.friends', e)),
    Obscura.getConnectionState()
      .then((cs) => store._setConnState(cs || 'disconnected'))
      .catch((e) => logError('bootstrap.conn', e)),
  ]);

  // Android push can decrypt, persist, and ACK with no JS runtime, so no
  // `messageReceived` event is emitted for those rows. Cold-start sync discovers
  // them independently of the best-effort event path.
  //
  // The emit is best-effort by design (NATIVE_CONTRACT §0.9 rule 4 permits dropping the notification, since
  // the row is the delivery path) — which is exactly why the row must have a trigger that does not
  // depend on the notification.
  //
  // Awaited on the identity pulls above, not fired alongside them: the drain needs `getUserId()` to
  // authorize what it stores, and the outbox flush reads the identity out of the store.
  syncBothWays('coldStart');
}

/**
 * Mount this once at the app root. Wires every native event to a store
 * update, gates the initial state pulls behind `authed`,
 * and requests push permission once per session after first connect.
 *
 * The hook returns null so it can be rendered as a component:
 *   <ObscuraBootstrap />
 */
export function ObscuraBootstrap(): null {
  // Cold-start auth check — runs once. The `bootstrapped` flag flips true
  // in `finally` regardless of result, which the navigator uses to stop
  // showing the splash screen.
  useEffect(() => {
    Obscura.getAuthState()
      .then((state) => {
        if (state === 'authenticated') useStore.getState().setAuthed(true);
      })
      .catch((e) => logError('bootstrap.authState', e))
      .finally(() => {
        useStore.getState()._setBootstrapped(true);
      });
  }, []);

  // Single global event subscription.
  useEffect(() => onObscuraEvent(applyObscuraEvent), []);

  // When authed flips true, pull initial session state and run the cold-start sync.
  const authed = useStore((s) => s.authed);
  useEffect(() => {
    if (!authed) return;
    loadSession().catch((e) => logError('bootstrap.session', e));
  }, [authed]);

  // Push permission — request once per session after first connect.
  const connState = useStore((s) => s.connState);
  const pushRequestedRef = useRef(false);
  useEffect(() => {
    if (!authed) { pushRequestedRef.current = false; return; }
    if (connState !== 'connected') return;
    if (pushRequestedRef.current) return;
    pushRequestedRef.current = true;
    Obscura.requestPushPermission().catch((e: unknown) => {
      console.warn('[push] permission request failed:', e);
    });
  }, [authed, connState]);

  return null;
}
