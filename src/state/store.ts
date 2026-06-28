import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import {
  Obscura, onObscuraEvent,
  type Friend, type ConnectionState, type ModelEntry,
} from '../native/ObscuraModule';
import { obscuraSchema } from '../models/schema';

/**
 * Process-wide store for session state and ORM entry caches.
 *
 * Selectors:
 *   - useSession()           — session shape used by every screen
 *   - useModelEntries(model) — auto-refreshing entries for a single model
 *
 * Side effects (event subscription, defineModels, push permission) live in
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
  _setFriendsAndPending: (friends: Friend[], pending: Friend[]) => void;
  _setConnState: (s: ConnectionState) => void;
  _setEntries: (model: string, entries: ModelEntry[]) => void;
}

export const useStore = create<ObscuraStore>((set) => ({
  bootstrapped: false,
  authed: false,
  myUserId: '',
  myUsername: '',
  friends: [],
  pending: [],
  connState: 'disconnected',
  entries: {},

  setAuthed: (v) => set({ authed: v }),

  logout: async () => {
    try { await Obscura.logout(); } catch {}
    set({
      authed: false,
      myUserId: '',
      myUsername: '',
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
    friends: [],
    pending: [],
    connState: 'disconnected',
    entries: {},
  }),

  _setBootstrapped: (v) => set({ bootstrapped: v }),
  _setUserId: (id) => set({ myUserId: id }),
  _setUsername: (name) => set({ myUsername: name }),
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
    friends: s.friends,
    pending: s.pending,
    connState: s.connState,
    setAuthed: s.setAuthed,
    logout: s.logout,
  })));
}

/**
 * All entries for `model`, auto-loading on first call and auto-refreshing
 * on `messageReceived` / `entriesChanged` events (handled centrally in the
 * bootstrap subscription).
 */
export function useModelEntries(model: string): ModelEntry[] {
  const entries = useStore((s) => s.entries[model]);
  useEffect(() => {
    if (entries !== undefined) return;
    Obscura.allEntries(model).then((es) => {
      useStore.getState()._setEntries(model, es ?? []);
    }).catch(() => {});
  }, [model, entries]);
  return entries ?? [];
}

// ─── Bootstrap ───────────────────────────────────────────

/**
 * Mount this once at the app root. Wires every native event to a store
 * update, gates the initial defineModels / state pulls behind `authed`,
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
      .catch(() => {})
      .finally(() => {
        useStore.getState()._setBootstrapped(true);
      });
  }, []);

  // Single global event subscription. Re-fetches any loaded entry slice
  // on relevant ORM events; updates session slices on session events.
  useEffect(() => {
    return onObscuraEvent((event) => {
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
          return;
        case 'authStateChanged':
          if (event.state === 'loggedOut') s.reset();
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
        case 'messageReceived':
        case 'entriesChanged': {
          // Refresh only slices we've actually loaded — avoids fetching
          // models no screen has displayed yet.
          if (s.entries[event.model] === undefined) return;
          Obscura.allEntries(event.model).then((es) => {
            useStore.getState()._setEntries(event.model, es ?? []);
          }).catch(() => {});
          return;
        }
      }
    });
  }, []);

  // When authed flips true: define schema (the bridge requires a kit
  // client, so this can't happen earlier) and pull initial session state.
  const authed = useStore((s) => s.authed);
  useEffect(() => {
    if (!authed) return;
    Obscura.defineModels(obscuraSchema).catch((e: unknown) => {
      console.warn('[session] defineModels failed:', e);
    });
    Obscura.getUserId().then((id) => useStore.getState()._setUserId(id || ''));
    Obscura.getUsername().then((name) => useStore.getState()._setUsername(name || ''));
    Obscura.getFriends().then((all) => {
      const list = all || [];
      useStore.getState()._setFriendsAndPending(
        list.filter((f) => f.status === 'accepted'),
        list.filter((f) => f.status !== 'accepted'),
      );
    }).catch(() => {});
    Obscura.getConnectionState().then((cs) => {
      useStore.getState()._setConnState(cs || 'disconnected');
    }).catch(() => {});
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
