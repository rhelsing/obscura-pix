import React, { useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura, type Friend, type ModelEntry } from '../native/ObscuraModule';
import { useSession, useModelEntries } from '../state/store';
import { StoriesRow } from './StoriesScreen';
import { SwipeNavigator } from '../components/SwipeNavigator';
import type { RootStackParamList, StoryGroup } from '../navigation/types';
import { colors } from '../styles';

function timeAgo(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

type PixState = 'received_new' | 'received_viewed' | 'sent_pending' | 'sent_opened' | 'none';

interface FriendActivity {
  friend: Friend;
  lastMessage?: ModelEntry;
  unopenedPix: ModelEntry[];
  pixState: PixState;
  pixCount: number;
  latestTimestamp: number;
}

export function ChatListScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { friends, pending, myUsername } = useSession();
  const messages = useModelEntries('directMessage');
  const pixEntries = useModelEntries('pix');

  const onViewPix = (entry: ModelEntry) => {
    const group: StoryGroup = {
      username: entry.data.senderUsername || '?',
      stories: [entry],
      isMe: false,
    };
    nav.navigate('StoryViewer', { groups: [group], startIndex: 0, markViewed: true });
  };

  // Build activity list — each friend with their latest chat + pix state.
  // Memoized so the four filter passes per friend don't run on every render.
  const activities: FriendActivity[] = useMemo(() => friends.map(f => {
    const friendMessages = messages.filter(m =>
      m.data.senderUsername === f.username || m.data.conversationId?.includes(f.userId)
    );
    const lastMessage = friendMessages.sort((a, b) => b.timestamp - a.timestamp)[0];

    const receivedNew = pixEntries.filter(p =>
      p.data.senderUsername === f.username && p.data.recipientUsername === myUsername
      && !p.data.viewedAt
    );
    const receivedViewed = pixEntries.filter(p =>
      p.data.senderUsername === f.username && p.data.recipientUsername === myUsername
      && !!p.data.viewedAt
    );
    const sentPending = pixEntries.filter(p =>
      p.data.senderUsername === myUsername && p.data.recipientUsername === f.username
      && !p.data.viewedAt
    );
    const sentOpened = pixEntries.filter(p =>
      p.data.senderUsername === myUsername && p.data.recipientUsername === f.username
      && !!p.data.viewedAt
    );

    const allPix = [...receivedNew, ...receivedViewed, ...sentPending, ...sentOpened]
      .sort((a, b) => b.timestamp - a.timestamp);
    const latest = allPix[0];
    let pixState: PixState = 'none';
    if (latest) {
      if (receivedNew.includes(latest)) pixState = 'received_new';
      else if (receivedViewed.includes(latest)) pixState = 'received_viewed';
      else if (sentPending.includes(latest)) pixState = 'sent_pending';
      else if (sentOpened.includes(latest)) pixState = 'sent_opened';
    }

    const latestTimestamp = Math.max(
      lastMessage?.timestamp || 0,
      ...allPix.map(p => p.timestamp), 0
    );
    return { friend: f, lastMessage, unopenedPix: receivedNew, pixState, pixCount: receivedNew.length, latestTimestamp };
  }).sort((a, b) => b.latestTimestamp - a.latestTimestamp), [friends, messages, pixEntries, myUsername]);

  return (
    <SwipeNavigator
      // Chats is the left-hand tab; swipe left reveals the Camera on the right.
      onSwipeLeft={() => nav.navigate('MainTabs', { screen: 'Camera' })}
    >
      {/* Stories row */}
      <StoriesRow />

      {/* Pending requests */}
      {pending.length > 0 && pending.map(f => (
        <View key={f.userId} style={cl.row}>
          <View style={[cl.avatar, cl.avatarPending]}>
            <Text style={cl.avatarText}>{f.username[0]?.toUpperCase()}</Text>
          </View>
          <View style={cl.info}>
            <Text style={cl.username}>{f.username}</Text>
            <Text style={cl.preview}>
              {f.status === 'pending_received' ? 'wants to be friends' : 'request sent'}
            </Text>
          </View>
          {f.status === 'pending_received' && (
            <TouchableOpacity style={cl.acceptBtn} onPress={() => Obscura.acceptFriend(f.userId, f.username)}>
              <Text style={cl.acceptBtnText}>accept</Text>
            </TouchableOpacity>
          )}
        </View>
      ))}

      {/* Unified friend list */}
      <FlatList
        data={activities}
        keyExtractor={item => item.friend.userId}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => {
          const hasPix = item.unopenedPix.length > 0;
          const preview = item.lastMessage?.data.content
            ? `${item.lastMessage.data.senderUsername === myUsername ? 'You: ' : ''}${item.lastMessage.data.content}`
            : 'tap to chat';

          return (
            <View style={cl.row}>
              {/* Left: pix icon — tap opens pix viewer */}
              <TouchableOpacity
                style={cl.iconZone}
                onPress={() => hasPix ? onViewPix(item.unopenedPix[0]) : nav.navigate('Chat', { friend: item.friend })}
              >
                {item.pixState === 'received_new' ? (
                  <View style={cl.iconCircleFilled}>
                    {item.pixCount > 1 && <Text style={cl.iconCount}>{item.pixCount}</Text>}
                  </View>
                ) : item.pixState === 'received_viewed' ? (
                  <View style={cl.iconCircleOutline} />
                ) : item.pixState === 'sent_pending' ? (
                  <View style={cl.iconArrowFilled} />
                ) : item.pixState === 'sent_opened' ? (
                  <View style={cl.iconArrowOutline} />
                ) : (
                  <View style={cl.iconDefault}>
                    <Text style={cl.iconDefaultText}>{item.friend.username[0]?.toUpperCase()}</Text>
                  </View>
                )}
              </TouchableOpacity>

              {/* Right: name + preview — tap opens chat */}
              <TouchableOpacity style={cl.chatZone} onPress={() => nav.navigate('Chat', { friend: item.friend })}>
                <View style={cl.info}>
                  <Text style={cl.username}>{item.friend.username}</Text>
                  <Text style={cl.preview} numberOfLines={1}>{preview}</Text>
                </View>
                {item.latestTimestamp > 0 && (
                  <Text style={cl.time}>{timeAgo(item.latestTimestamp)}</Text>
                )}
              </TouchableOpacity>
            </View>
          );
        }}
        ListEmptyComponent={
          friends.length === 0
            ? <Text style={cl.empty}>no friends yet — share your code</Text>
            : null
        }
      />
    </SwipeNavigator>
  );
}

const cl = StyleSheet.create({
  addRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  addInput: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 14 },
  addBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  addBtnText: { color: '#000', fontWeight: '700', fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  iconZone: { width: 64, alignItems: 'center', justifyContent: 'center', paddingLeft: 16 },
  chatZone: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  avatarPending: { backgroundColor: '#333' },
  avatarText: { color: '#000', fontWeight: '700', fontSize: 20 },
  // Pix state icons
  iconCircleFilled: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  iconCircleOutline: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, borderColor: colors.accent },
  iconArrowFilled: { width: 0, height: 0, borderLeftWidth: 24, borderTopWidth: 16, borderBottomWidth: 16, borderLeftColor: colors.accent, borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  iconArrowOutline: { width: 0, height: 0, borderLeftWidth: 24, borderTopWidth: 16, borderBottomWidth: 16, borderLeftColor: colors.accent, borderTopColor: 'transparent', borderBottomColor: 'transparent', opacity: 0.4 },
  iconDefault: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  iconDefaultText: { color: '#000', fontWeight: '700', fontSize: 18 },
  iconCount: { color: '#000', fontWeight: '700', fontSize: 16 },
  info: { flex: 1 },
  username: { color: '#fff', fontSize: 16, fontWeight: '600' },
  preview: { color: '#999', fontSize: 13, marginTop: 2 },
  time: { color: '#666', fontSize: 12 },
  acceptBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  acceptBtnText: { color: '#000', fontWeight: '700', fontSize: 13 },
  empty: { color: '#444', textAlign: 'center', marginTop: 32, fontSize: 14 },
  copyBtn: { flex: 1, backgroundColor: '#1a1a1a', borderRadius: 12, padding: 12, alignItems: 'center' },
  copyBtnText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
});
