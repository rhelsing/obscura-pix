import React, { useState, useEffect, useCallback } from 'react';
import {
  SafeAreaView, View, Text, TouchableOpacity, StatusBar, Alert,
} from 'react-native';
import { Obscura, type Friend } from './src/native/ObscuraModule';
import { obscuraSchema } from './src/models/schema';
import { ObscuraEvents } from './src/events';
import { s, colors } from './src/styles';
import RNFS from 'react-native-fs';

import { AuthScreen } from './src/screens/AuthScreen';
import { CameraScreen } from './src/screens/CameraScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { ChatListScreen } from './src/screens/ChatListScreen';
import { ProfileScreen } from './src/screens/ProfileScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { PhotoPreviewScreen } from './src/screens/PhotoPreviewScreen';
import { RecipientPicker } from './src/screens/RecipientPicker';
import { StoryViewer } from './src/screens/StoriesScreen';
import { PixViewer } from './src/screens/PixViewer';
import type { PhotoFile } from 'react-native-vision-camera';

// ─── Reactive Event Hook ─────────────────────────────────

type Tab = 'chat' | 'camera';

function useObscuraEvents(authed: boolean, onAuthLost?: () => void) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pending, setPending] = useState<Friend[]>([]);
  const [connState, setConnState] = useState('disconnected');

  useEffect(() => {
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'friendsUpdated') {
        const all = event.friends || [];
        setFriends(all.filter((f: Friend) => f.status === 'accepted'));
        setPending(all.filter((f: Friend) => f.status !== 'accepted'));
      }
      if (event.type === 'connectionChanged') setConnState(event.state || 'disconnected');
      if (event.type === 'authFailed' || (event.type === 'authStateChanged' && event.state === 'loggedOut')) {
        onAuthLost?.();
      }
    });
    if (!authed) return () => sub.remove();
    Obscura.getFriends().then((all: Friend[]) => {
      setFriends((all || []).filter((f: Friend) => f.status === 'accepted'));
      setPending((all || []).filter((f: Friend) => f.status !== 'accepted'));
    }).catch(() => {});
    Obscura.getConnectionState().then((cs: string) => setConnState(cs || 'disconnected')).catch(() => {});
    return () => sub.remove();
  }, [authed]);

  return { friends, pending, connState };
}

// ─── Main App ────────────────────────────────────────────

export default function App() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>('camera');
  const [screen, setScreen] = useState<string>('main');
  const [selectedFriend, setSelectedFriend] = useState<Friend | null>(null);
  const [myUserId, setMyUserId] = useState('');
  const [myUsername, setMyUsername] = useState('');

  // Camera flow state
  const [capturedPhoto, setCapturedPhoto] = useState<PhotoFile | null>(null);
  const [sendOpts, setSendOpts] = useState<{ caption: string; displayDuration: number } | null>(null);

  // Pix viewing state
  const [viewingPix, setViewingPix] = useState<import('./src/native/ObscuraModule').ModelEntry | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleAuthLost = useCallback(() => {
    setAuthed(false);
    setMyUserId('');
    setMyUsername('');
    setSelectedFriend(null);
    setScreen('main');
    setTab('camera');
  }, []);

  const { friends, pending, connState } = useObscuraEvents(authed, handleAuthLost);

  useEffect(() => {
    Obscura.getAuthState().then(async (state) => {
      if (state === 'authenticated') {
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

  const onLogout = () => { Obscura.logout(); handleAuthLost(); };
  const openChat = (f: Friend) => { setSelectedFriend(f); setScreen('chat'); };

  // ─── Camera flow handlers
  const onPhotoCaptured = (photo: PhotoFile) => {
    setCapturedPhoto(photo);
    setScreen('preview');
  };

  const onPreviewSend = (opts: { caption: string; displayDuration: number }) => {
    setSendOpts(opts);
    setScreen('pick');
  };

  const onSendToRecipients = async (recipients: Friend[], includeStory: boolean) => {
    if (!capturedPhoto || !sendOpts) return;
    setScreen('main');
    try {
      // Resize photo to 1080px max, then read as base64
      let photoPath = capturedPhoto.path;
      try {
        const { ImageResizer } = require('@bam.tech/react-native-image-resizer');
        if (ImageResizer) {
          const resized = await ImageResizer.createResizedImage(
            `file://${photoPath}`, 1080, 1080, 'JPEG', 80, 0
          );
          photoPath = resized.path;
        }
      } catch (_) { /* resize unavailable — use original */ }
      const base64 = await RNFS.readFile(photoPath, 'base64');
      // Upload encrypted attachment
      const attachment = await Obscura.uploadAttachment(base64);

      // Create Pix entry for each recipient
      for (const friend of recipients) {
        await Obscura.createEntry('pix', {
          recipientUsername: friend.username,
          senderUsername: myUsername,
          mediaRef: attachment.id,
          contentKey: attachment.contentKey,
          nonce: attachment.nonce,
          caption: sendOpts.caption,
          displayDuration: sendOpts.displayDuration,
        });
      }

      // Post to story if selected
      if (includeStory) {
        const storyMediaRef = JSON.stringify({
          attachmentId: attachment.id,
          contentKey: attachment.contentKey,
          nonce: attachment.nonce,
        });
        await Obscura.createEntry('story', {
          content: sendOpts.caption || '',
          authorUsername: myUsername,
          mediaUrl: storyMediaRef,
        });
      }

      Alert.alert('Sent!', `Sent to ${recipients.length} friend${recipients.length !== 1 ? 's' : ''}${includeStory ? ' + story' : ''}`);
    } catch (e: any) {
      Alert.alert('Send failed', e.message);
    } finally {
      // Clean up temp photo file
      if (capturedPhoto?.path) RNFS.unlink(capturedPhoto.path).catch(() => {});
    }
    setCapturedPhoto(null);
    setSendOpts(null);
  };

  // ─── Not authed
  if (!authed) return <AuthScreen onAuth={() => setAuthed(true)} />;

  // ─── Photo preview (after capture)
  if (screen === 'preview' && capturedPhoto) {
    return (
      <PhotoPreviewScreen
        photoPath={capturedPhoto.path}
        onSend={onPreviewSend}
        onRetake={() => { setCapturedPhoto(null); setScreen('main'); }}
      />
    );
  }

  // ─── Recipient picker (after preview)
  if (screen === 'pick') {
    return (
      <RecipientPicker
        friends={friends}
        onSend={onSendToRecipients}
        onCancel={() => setScreen('preview')}
      />
    );
  }

  // ─── Pix viewer (full-screen, reuses story viewer)
  if (viewingPix) {
    const pixGroup = { username: viewingPix.data.senderUsername || '?', stories: [viewingPix], isMe: false };
    return (
      <StoryViewer
        groups={[pixGroup]}
        startIndex={0}
        onClose={() => {
          // Mark as viewed via upsert — LWW merges viewedAt, syncs to sender
          Obscura.upsertEntry('pix', viewingPix.id, {
            ...viewingPix.data,
            viewedAt: Date.now(),
          }).catch(() => {});
          setViewingPix(null);
          setRefreshKey(k => k + 1);
        }}
        onViewed={(entry) => {
          Obscura.upsertEntry('pix', entry.id, {
            ...entry.data,
            viewedAt: Date.now(),
          }).catch(() => {});
        }}
      />
    );
  }

  // ─── Chat screen
  if (screen === 'chat' && selectedFriend) {
    return <ChatScreen friend={selectedFriend} myUserId={myUserId}
      myUsername={myUsername} onBack={() => setScreen('main')}
      onViewPix={(entry) => setViewingPix(entry)} />;
  }

  // ─── Full-screen overlays
  if (screen === 'profile') {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.chatHeader}>
          <TouchableOpacity onPress={() => setScreen('main')}><Text style={s.backBtn}>{'<'}</Text></TouchableOpacity>
          <Text style={s.chatTitle}>profile</Text>
        </View>
        <ProfileScreen myUsername={myUsername} myUserId={myUserId} />
      </SafeAreaView>
    );
  }

  if (screen === 'settings') {
    return (
      <SafeAreaView style={s.container}>
        <View style={s.chatHeader}>
          <TouchableOpacity onPress={() => setScreen('main')}><Text style={s.backBtn}>{'<'}</Text></TouchableOpacity>
          <Text style={s.chatTitle}>settings</Text>
        </View>
        <SettingsScreen myUsername={myUsername} myUserId={myUserId} onLogout={onLogout} />
      </SafeAreaView>
    );
  }

  // ─── Main tabbed view (camera-centric)
  return (
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" />
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => setScreen('profile')}>
          <View style={[s.avatar, { width: 32, height: 32 }]}>
            <Text style={[s.avatarText, { fontSize: 14 }]}>{myUsername[0]?.toUpperCase() || '?'}</Text>
          </View>
        </TouchableOpacity>
        <Text style={s.topTitle}>obscura</Text>
        <TouchableOpacity onPress={() => setScreen('settings')}>
          <Text style={[s.connDot, { color: connState === 'connected' ? colors.connected : colors.disconnected }]}>{'...'}</Text>
        </TouchableOpacity>
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'chat' && (
          <ChatListScreen
            friends={friends}
            pending={pending}
            myUsername={myUsername}
            onSelectFriend={openChat}
            onViewPix={(entry) => setViewingPix(entry)}
            refreshTrigger={refreshKey}
          />
        )}
        {tab === 'camera' && <CameraScreen onPhotoCaptured={onPhotoCaptured} />}
      </View>

      <View style={s.tabBar}>
        <TouchableOpacity style={s.tab} onPress={() => setTab('chat')}>
          <Text style={[s.tabText, tab === 'chat' && s.tabActive]}>chat</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.tab} onPress={() => setTab('camera')}>
          <View style={s.cameraTab}>
            <Text style={s.cameraTabIcon}>O</Text>
          </View>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
