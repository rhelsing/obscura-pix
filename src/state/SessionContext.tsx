import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Obscura, onObscuraEvent, type Friend, type ConnectionState } from '../native/ObscuraModule';
import { obscuraSchema } from '../models/schema';

/**
 * Process-wide session state shadow of the kit.
 *
 * Today this is a React Context; PR 4 will swap the implementation for a
 * Zustand store without changing the `useSession()` consumer surface. Keep
 * the hook signature stable.
 */
export interface SessionState {
  authed: boolean;
  myUserId: string;
  myUsername: string;
  friends: Friend[];
  pending: Friend[];
  connState: ConnectionState;
  /** Called after a successful AuthScreen login to flip `authed`. */
  setAuthed: (v: boolean) => void;
  /** Hard reset — kit logout + clear all in-memory state. */
  logout: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [myUserId, setMyUserId] = useState('');
  const [myUsername, setMyUsername] = useState('');
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pending, setPending] = useState<Friend[]>([]);
  const [connState, setConnState] = useState<ConnectionState>('disconnected');
  // Push-permission request is gated to once per session — OS caches the decision,
  // but we also avoid re-prompting on every reconnect.
  const pushRequestedRef = useRef(false);

  const reset = useCallback(() => {
    setAuthed(false);
    setMyUserId('');
    setMyUsername('');
    setFriends([]);
    setPending([]);
    setConnState('disconnected');
    pushRequestedRef.current = false;
  }, []);

  const logout = useCallback(() => {
    Obscura.logout().catch(() => {});
    reset();
  }, [reset]);

  // Cold-start: if the kit already has a session, hop straight to authed
  // without showing the AuthScreen.
  useEffect(() => {
    Obscura.getAuthState().then((state) => {
      if (state === 'authenticated') setAuthed(true);
    }).catch(() => {});
  }, []);

  // While authed: define ORM models (the bridge's defineModels requires a
  // kit client, which only exists post-register/login — that's why this lives
  // here instead of at module load). The native side caches the schema across
  // cold starts and tryRestore re-applies it, so this call is idempotent in
  // practice but mandatory the first time per install.
  useEffect(() => {
    if (!authed) return;
    Obscura.defineModels(obscuraSchema).catch((e: unknown) => {
      console.warn('[session] defineModels failed:', e);
    });
    Obscura.getUserId().then(id => setMyUserId(id || ''));
    Obscura.getUsername().then(name => setMyUsername(name || ''));
    Obscura.getFriends().then((all) => {
      setFriends((all || []).filter((f) => f.status === 'accepted'));
      setPending((all || []).filter((f) => f.status !== 'accepted'));
    }).catch(() => {});
    Obscura.getConnectionState().then((cs) => setConnState(cs || 'disconnected')).catch(() => {});

    return onObscuraEvent((event) => {
      if (event.type === 'friendsUpdated') {
        const all = event.friends || [];
        setFriends(all.filter((f) => f.status === 'accepted'));
        setPending(all.filter((f) => f.status !== 'accepted'));
      } else if (event.type === 'connectionChanged') {
        setConnState(event.state || 'disconnected');
      } else if (event.type === 'authFailed' || (event.type === 'authStateChanged' && event.state === 'loggedOut')) {
        reset();
      }
    });
  }, [authed, reset]);

  // Push notifications — request permission once per session after connect lands.
  useEffect(() => {
    if (!authed || connState !== 'connected') return;
    if (pushRequestedRef.current) return;
    pushRequestedRef.current = true;
    Obscura.requestPushPermission().catch((e: unknown) => {
      console.warn('[push] permission request failed:', e);
    });
  }, [authed, connState]);

  // Register any FCM/APNS token the native side hands us.
  useEffect(() => {
    return onObscuraEvent((event) => {
      if (event.type !== 'pushTokenReceived' || !event.token) return;
      const preview = event.token.slice(0, 8) + '...';
      console.log('[push] token received:', preview);
      Obscura.registerPushToken(event.token).catch((e: unknown) => {
        console.warn('[push] token registration failed:', e);
      });
    });
  }, []);

  const value: SessionState = {
    authed,
    myUserId,
    myUsername,
    friends,
    pending,
    connState,
    setAuthed,
    logout,
  };

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
