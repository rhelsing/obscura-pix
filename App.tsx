import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, StatusBar, Alert, KeyboardAvoidingView, Platform,
  Image, NativeModules, NativeEventEmitter, ScrollView, Animated,
} from 'react-native';
import {
  Obscura, conversationId, type Friend, type ModelEntry,
} from './src/native/ObscuraModule';
import { obscuraSchema } from './src/models/schema';

const ObscuraEvents = new NativeEventEmitter(NativeModules.ObscuraBridge);

// ─── Reactive Event Hook ─────────────────────────────────

function useObscuraEvents(authed: boolean, onAuthLost?: () => void) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pending, setPending] = useState<Friend[]>([]);
  const [connState, setConnState] = useState('disconnected');

  useEffect(() => {
    // Always listen for auth state — even when not authed, to catch session expiry
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      console.log('[ObscuraEvent]', event.type, JSON.stringify(event).slice(0, 200));
      if (event.type === 'friendsUpdated') {
        const all = event.friends || [];
        setFriends(all.filter((f: Friend) => f.status === 'accepted'));
        setPending(all.filter((f: Friend) => f.status !== 'accepted'));
      }
      if (event.type === 'connectionChanged') setConnState(event.state || 'disconnected');
      // Auth failure — token refresh exhausted or server revoked session
      if (event.type === 'authFailed' || (event.type === 'authStateChanged' && event.state === 'loggedOut')) {
        console.log('[ObscuraEvent] Auth lost — showing login');
        onAuthLost?.();
      }
    });
    if (!authed) return () => sub.remove();
    // Fetch initial state (events may have fired before JS subscribed)
    Obscura.getFriends().then((all: Friend[]) => {
      setFriends((all || []).filter((f: Friend) => f.status === 'accepted'));
      setPending((all || []).filter((f: Friend) => f.status !== 'accepted'));
    }).catch(() => {});
    Obscura.getConnectionState().then((s: string) => setConnState(s || 'disconnected')).catch(() => {});
    return () => sub.remove();
  }, [authed]);

  return { friends, pending, connState };
}

// ─── Auth Screen ─────────────────────────────────────────

function AuthScreen({ onAuth }: { onAuth: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');

  const register = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Registering...');
    try {
      await Obscura.register(username, password);
      await Obscura.defineModels(obscuraSchema);
      await Obscura.connect();
      onAuth();
    } catch (e: any) { setStatus(e.message || 'Registration failed'); }
  };

  const login = async () => {
    if (!username || password.length < 12) { setStatus('Password must be 12+ chars'); return; }
    setStatus('Logging in...');
    try {
      const scenario = await Obscura.loginSmart(username, password);
      switch (scenario) {
        case 'existingDevice': case 'onlyDevice':
          await Obscura.defineModels(obscuraSchema);
          await Obscura.connect();
          onAuth();
          break;
        case 'newDevice':
          await Obscura.loginAndProvision(username, password);
          await Obscura.defineModels(obscuraSchema);
          await Obscura.connect();
          onAuth();
          break;
        case 'invalidCredentials': setStatus('Wrong password'); break;
        case 'userNotFound': setStatus('User not found'); break;
        default: setStatus(`Login: ${scenario}`);
      }
    } catch (e: any) { setStatus(e.message || 'Login failed'); }
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.authBox}>
        <Image source={require('./src/assets/logo.png')} style={s.logoImg} resizeMode="contain" />
        <Text style={s.subtitle}>encrypted everything</Text>
        {status ? <Text style={s.status}>{status}</Text> : null}
        <TextInput style={s.input} placeholder="username" placeholderTextColor="#666"
          value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} />
        <TextInput style={s.input} placeholder="password (12+ chars)" placeholderTextColor="#666"
          value={password} onChangeText={setPassword} secureTextEntry />
        <View style={s.authButtons}>
          <TouchableOpacity style={s.primaryBtn} onPress={register}>
            <Text style={s.primaryBtnText}>sign up</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.secondaryBtn} onPress={login}>
            <Text style={s.secondaryBtnText}>log in</Text>
          </TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Chat Screen ─────────────────────────────────────────

function ChatScreen({ friend, myUserId, myUsername, onBack }: {
  friend: Friend; myUserId: string; myUsername: string; onBack: () => void;
}) {
  const [messages, setMessages] = useState<ModelEntry[]>([]);
  const [text, setText] = useState('');
  const [typers, setTypers] = useState<string[]>([]);
  const convId = conversationId(myUserId, friend.userId);

  const loadMessages = useCallback(() => {
    Obscura.queryEntries('directMessage', { 'data.conversationId': convId })
      .then(msgs => setMessages([...msgs].sort((a, b) => a.timestamp - b.timestamp)));
  }, [convId]);

  // Load messages + subscribe to incoming
  useEffect(() => {
    loadMessages();
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'messageReceived') {
        loadMessages();
        setTypers([]); // Clear typing bubble immediately when a message arrives
      }
      if (event.type === 'typingChanged' && event.conversationId === convId) {
        setTypers(event.typers || []);
      }
      // typingChanged is the only typing event — both iOS and Android use observeTyping()
    });
    // Start observing typing for this conversation
    Obscura.observeTyping(convId);
    return () => {
      sub.remove();
      Obscura.stopObservingTyping(convId);
    };
  }, [convId, loadMessages]);

  const send = async () => {
    if (!text.trim()) return;
    const msg = text;
    setText('');
    try {
      await Obscura.stopTyping(convId);
      await Obscura.createEntry('directMessage', {
        conversationId: convId, content: msg, senderUsername: myUsername,
      });
      loadMessages();
    } catch (e: any) { Alert.alert('Send failed', e.message); }
  };

  const onChangeText = (t: string) => {
    setText(t);
    if (t.length > 0) Obscura.sendTyping(convId);
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.chatHeader}>
        <TouchableOpacity onPress={onBack}><Text style={s.backBtn}>{'‹'}</Text></TouchableOpacity>
        <Text style={s.chatTitle}>{friend.username}</Text>
      </View>

      <FlatList
        data={messages}
        keyExtractor={(item, i) => item.id || `${i}`}
        style={s.messageList}
        renderItem={({ item }) => {
          const isMine = item.data.senderUsername === myUsername;
          return (
            <View style={[s.msgRow, isMine ? s.msgRowRight : s.msgRowLeft]}>
              <View style={[s.msgBubble, isMine ? s.myBubble : s.theirBubble]}>
                <Text style={isMine ? s.myBubbleText : s.theirBubbleText}>{item.data.content}</Text>
              </View>
            </View>
          );
        }}
        ListFooterComponent={typers.length > 0 ? (
          <View style={[s.msgRow, s.msgRowLeft]}>
            <TypingBubble />
          </View>
        ) : null}
      />

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.composer}>
          <TextInput style={s.composerInput} placeholder="message" placeholderTextColor="#999"
            value={text} onChangeText={onChangeText} />
          <TouchableOpacity style={s.sendBtn} onPress={send} disabled={!text.trim()}>
            <Text style={s.sendBtnText}>↑</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ─── Friends Screen ──────────────────────────────────────

function FriendsScreen({ friends, pending, onSelectFriend }: {
  friends: Friend[]; pending: Friend[]; onSelectFriend: (f: Friend) => void;
}) {
  const [codeInput, setCodeInput] = useState('');

  const addFriend = async () => {
    try { await Obscura.addFriendByCode(codeInput); setCodeInput(''); }
    catch (e: any) { Alert.alert('Error', e.message); }
  };

  const copyMyCode = async () => {
    try {
      const code = await Obscura.getFriendCode();
      if (code) {
        try { const { Clipboard } = require('react-native'); Clipboard.setString(code); } catch {}
        Alert.alert('Copied!', 'Friend code copied to clipboard');
      }
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  return (
    <View style={s.screen}>
      <TouchableOpacity style={s.codeBtn} onPress={copyMyCode}>
        <Text style={s.codeBtnText}>copy my friend code</Text>
      </TouchableOpacity>

      <View style={s.row}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]}
          placeholder="paste friend code" placeholderTextColor="#666"
          value={codeInput} onChangeText={setCodeInput} />
        <TouchableOpacity style={s.smallBtn} onPress={addFriend}>
          <Text style={s.smallBtnText}>add</Text>
        </TouchableOpacity>
      </View>

      {pending.length > 0 && (<>
        <Text style={s.sectionTitle}>requests</Text>
        {pending.map(f => (
          <View key={f.userId} style={s.friendRow}>
            <Text style={s.friendName}>{f.username}</Text>
            {f.status === 'pending_received' ? (
              <TouchableOpacity style={s.smallBtn} onPress={() => Obscura.acceptFriend(f.userId, f.username)}>
                <Text style={s.smallBtnText}>accept</Text>
              </TouchableOpacity>
            ) : (
              <Text style={{ color: '#999', fontSize: 12 }}>pending</Text>
            )}
          </View>
        ))}
      </>)}

      <Text style={s.sectionTitle}>friends</Text>
      {friends.length === 0 ? (
        <Text style={s.empty}>no friends yet — share your code</Text>
      ) : friends.map(f => (
        <TouchableOpacity key={f.userId} style={s.friendRow} onPress={() => onSelectFriend(f)}>
          <View style={s.avatar}><Text style={s.avatarText}>{f.username[0]?.toUpperCase()}</Text></View>
          <Text style={s.friendName}>{f.username}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ─── Stories Screen ──────────────────────────────────────

function StoriesScreen({ myUsername }: { myUsername: string }) {
  const [stories, setStories] = useState<ModelEntry[]>([]);
  const [text, setText] = useState('');

  const load = useCallback(() => {
    Obscura.allEntries('story').then(s => setStories([...s].sort((a, b) => b.timestamp - a.timestamp)));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [load]);

  const post = async () => {
    if (!text.trim()) return;
    try {
      await Obscura.createEntry('story', { content: text, authorUsername: myUsername });
      setText('');
      load();
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  return (
    <View style={s.screen}>
      <View style={s.row}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]}
          placeholder="what's happening?" placeholderTextColor="#666"
          value={text} onChangeText={setText} />
        <TouchableOpacity style={s.smallBtn} onPress={post}>
          <Text style={s.smallBtnText}>post</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.hint}>disappears after 24 hours</Text>
      <FlatList data={stories} keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={s.storyCard}>
            <Text style={s.storyAuthor}>{item.data.authorUsername}</Text>
            <Text style={s.storyContent}>{item.data.content}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={s.empty}>no stories yet</Text>}
      />
    </View>
  );
}

// ─── Profile Screen ──────────────────────────────────────

function ProfileScreen({ myUsername, myUserId }: { myUsername: string; myUserId: string }) {
  const [displayName, setDisplayName] = useState(myUsername);
  const [bio, setBio] = useState('');
  const [profiles, setProfiles] = useState<ModelEntry[]>([]);

  useEffect(() => {
    Obscura.allEntries('profile').then(setProfiles);
    const interval = setInterval(() => Obscura.allEntries('profile').then(setProfiles), 3000);
    return () => clearInterval(interval);
  }, []);

  const save = async () => {
    try {
      await Obscura.upsertEntry('profile', `profile_${myUserId}`, { displayName, bio });
      Alert.alert('Saved', 'Profile updated');
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  const friendProfiles = profiles.filter(p => p.authorDeviceId !== myUserId);

  return (
    <ScrollView style={s.screen}>
      <Text style={s.sectionTitle}>edit profile</Text>
      <TextInput style={s.input} placeholder="display name" placeholderTextColor="#666"
        value={displayName} onChangeText={setDisplayName} />
      <TextInput style={s.input} placeholder="bio" placeholderTextColor="#666"
        value={bio} onChangeText={setBio} />
      <TouchableOpacity style={s.smallBtn} onPress={save}>
        <Text style={s.smallBtnText}>save</Text>
      </TouchableOpacity>

      {friendProfiles.length > 0 && (<>
        <Text style={s.sectionTitle}>friend profiles</Text>
        {friendProfiles.map(p => (
          <View key={p.id} style={s.storyCard}>
            <Text style={s.storyAuthor}>{p.data.displayName}</Text>
            {p.data.bio ? <Text style={s.storyContent}>{p.data.bio}</Text> : null}
          </View>
        ))}
      </>)}
    </ScrollView>
  );
}

// ─── Settings Screen ─────────────────────────────────────

function SettingsScreen({ myUsername, myUserId, onLogout }: {
  myUsername: string; myUserId: string; onLogout: () => void;
}) {
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (showLog) {
      Obscura.getDebugLog().then(setDebugLog);
      const interval = setInterval(() => Obscura.getDebugLog().then(setDebugLog), 2000);
      return () => clearInterval(interval);
    }
  }, [showLog]);

  return (
    <ScrollView style={s.screen}>
      <Text style={s.sectionTitle}>account</Text>
      <Text style={s.settingsLabel}>{myUsername}</Text>
      <Text style={s.hint}>{myUserId.slice(0, 16)}...</Text>

      <TouchableOpacity style={[s.codeBtn, { marginTop: 16 }]} onPress={() => setShowLog(!showLog)}>
        <Text style={s.codeBtnText}>{showLog ? 'hide debug log' : 'show debug log'}</Text>
      </TouchableOpacity>

      {showLog && debugLog.length > 0 && (
        <View style={{ marginTop: 8 }}>
          {debugLog.slice().reverse().map((line, i) => (
            <Text key={i} style={s.logLine}>{line}</Text>
          ))}
        </View>
      )}

      <TouchableOpacity
        style={[s.primaryBtn, { backgroundColor: '#333', marginTop: 24 }]}
        onPress={onLogout}
      >
        <Text style={s.primaryBtnText}>log out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─── Main App ────────────────────────────────────────────

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<'friends' | 'stories' | 'profile' | 'settings'>('friends');
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [myUserId, setMyUserId] = useState('');
  const [myUsername, setMyUsername] = useState('');
  const handleAuthLost = useCallback(() => {
    setAuthed(false);
    setMyUserId('');
    setMyUsername('');
    setSelectedFriend(null);
    setTab('friends');
  }, []);
  const { friends, pending, connState } = useObscuraEvents(authed, handleAuthLost);

  // Check for existing session on launch
  useEffect(() => {
    Obscura.getAuthState().then(async (state) => {
      if (state === 'authenticated') {
        // Ensure models are defined (may have been cached by native, but JS should always send latest)
        await Obscura.defineModels(obscuraSchema).catch(() => {});
        Obscura.getUserId().then(id => setMyUserId(id || ''));
        Obscura.getUsername().then(name => setMyUsername(name || ''));
        setAuthed(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!authed) return;
    Obscura.getUserId().then(id => setMyUserId(id || ''));
    Obscura.getUsername().then(name => setMyUsername(name || ''));
  }, [authed]);

  const onLogout = () => { Obscura.logout(); setAuthed(false); };

  if (!authed) return <AuthScreen onAuth={() => setAuthed(true)} />;

  if (selectedFriend) {
    return <ChatScreen friend={selectedFriend} myUserId={myUserId}
      myUsername={myUsername} onBack={() => setSelectedFriend(null)} />;
  }

  return (
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" />
      <View style={s.topBar}>
        <Text style={s.topTitle}>obscura</Text>
        <Text style={[s.connDot, { color: connState === 'connected' ? '#4f4' : '#f44' }]}>●</Text>
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'friends' && <FriendsScreen friends={friends} pending={pending} onSelectFriend={setSelectedFriend} />}
        {tab === 'stories' && <StoriesScreen myUsername={myUsername} />}
        {tab === 'profile' && <ProfileScreen myUsername={myUsername} myUserId={myUserId} />}
        {tab === 'settings' && <SettingsScreen myUsername={myUsername} myUserId={myUserId} onLogout={onLogout} />}
      </View>

      <View style={s.tabBar}>
        {(['friends', 'stories', 'profile', 'settings'] as const).map(t => (
          <TouchableOpacity key={t} style={s.tab} onPress={() => setTab(t)}>
            <Text style={[s.tabText, tab === t && s.tabActive]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

// ─── Typing Bubble (animated three dots) ─────────────────

function TypingBubble() {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animate = (dot: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: 1, duration: 400, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.3, duration: 400, useNativeDriver: true }),
        ])
      );
    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 200);
    const a3 = animate(dot3, 400);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, [dot1, dot2, dot3]);

  return (
    <View style={s.typingBubble}>
      {[dot1, dot2, dot3].map((opacity, i) => (
        <Animated.View key={i} style={[s.typingDot, { opacity }]} />
      ))}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  authBox: { flex: 1, justifyContent: 'center', padding: 32 },
  logoImg: { width: 260, height: 60, alignSelf: 'center', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 32 },
  status: { color: '#f55', textAlign: 'center', marginBottom: 12, fontSize: 13 },
  input: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14, color: '#fff', fontSize: 16, marginBottom: 12 },
  authButtons: { flexDirection: 'row', gap: 12, marginTop: 8 },
  primaryBtn: { flex: 1, backgroundColor: '#FFFC00', borderRadius: 12, padding: 14, alignItems: 'center' },
  primaryBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  secondaryBtn: { flex: 1, borderWidth: 1, borderColor: '#333', borderRadius: 12, padding: 14, alignItems: 'center' },
  secondaryBtnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  screen: { flex: 1, padding: 16 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 },
  topTitle: { fontSize: 20, fontWeight: '700', color: '#fff' },
  connDot: { fontSize: 16 },
  tabBar: { flexDirection: 'row', borderTopWidth: 0.5, borderTopColor: '#222', paddingVertical: 12 },
  tab: { flex: 1, alignItems: 'center' },
  tabText: { color: '#666', fontSize: 13, fontWeight: '600' },
  tabActive: { color: '#FFFC00' },
  sectionTitle: { color: '#666', fontSize: 12, fontWeight: '700', marginTop: 20, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  smallBtn: { backgroundColor: '#FFFC00', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
  smallBtnText: { color: '#000', fontWeight: '700', fontSize: 14 },
  codeBtn: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14, alignItems: 'center', marginBottom: 12 },
  codeBtnText: { color: '#FFFC00', fontWeight: '600' },
  friendRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 },
  friendName: { color: '#fff', fontSize: 16, flex: 1 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFFC00', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#000', fontWeight: '700', fontSize: 18 },
  empty: { color: '#444', textAlign: 'center', marginTop: 32, fontSize: 14 },
  hint: { color: '#444', fontSize: 12, marginTop: 4, marginBottom: 12 },
  settingsLabel: { color: '#fff', fontSize: 18, fontWeight: '600' },
  chatHeader: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 },
  backBtn: { color: '#FFFC00', fontSize: 32, fontWeight: '300' },
  chatTitle: { color: '#fff', fontSize: 20, fontWeight: '700' },
  messageList: { flex: 1, paddingHorizontal: 12 },
  msgRow: { marginVertical: 2 },
  msgRowRight: { alignItems: 'flex-end' },
  msgRowLeft: { alignItems: 'flex-start' },
  msgBubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, maxWidth: '75%' },
  myBubble: { backgroundColor: '#FFFC00' },
  theirBubble: { backgroundColor: '#1a1a1a' },
  myBubbleText: { color: '#000', fontSize: 16 },
  theirBubbleText: { color: '#fff', fontSize: 16 },
  typingBubble: {
    flexDirection: 'row', backgroundColor: '#1a1a1a', borderRadius: 18,
    paddingHorizontal: 14, paddingVertical: 10, gap: 4, marginVertical: 2,
  },
  typingDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: '#666',
  },
  composer: { flexDirection: 'row', padding: 12, gap: 8, borderTopWidth: 0.5, borderTopColor: '#222' },
  composerInput: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, color: '#fff', fontSize: 16 },
  sendBtn: { backgroundColor: '#FFFC00', borderRadius: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  sendBtnText: { color: '#000', fontWeight: '700', fontSize: 18 },
  storyCard: { backgroundColor: '#1a1a1a', borderRadius: 12, padding: 14, marginBottom: 8 },
  storyAuthor: { color: '#FFFC00', fontSize: 13, fontWeight: '700', marginBottom: 4 },
  storyContent: { color: '#fff', fontSize: 16 },
  logLine: { color: '#555', fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 2 },
});
