import React, { useMemo } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { Obscura, conversationId, type Friend, type ModelEntry } from '../native/ObscuraModule';
import { useSession, useModelEntries } from '../state/store';
import { AUTHOR_USER_ID } from '../models/schema';
import { authorOf } from '../utils/identity';
import { StoriesRow } from './StoriesScreen';
import { Avatar } from '../components/Avatar';
import type { RootStackParamList } from '../navigation/types';
import { openPixViewer } from '../navigation/openPixViewer';
import { timeAgo } from '../utils/format';
import { colors } from '../styles';

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
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { friends, pending, myUserId } = useSession();
  const messages = useModelEntries('directMessage');
  const pixEntries = useModelEntries('pix');

  const onViewPix = (sender: Friend, entries: ModelEntry[]) => openPixViewer(nav, sender, entries);

  // Build activity list — each friend with their latest chat + pix state.
  // Memoized so the four filter passes per friend don't run on every render.
  //
  // Membership is the CONVERSATION id and direction is the AUTHENTICATED author — never
  // `senderUsername` / `recipientUsername`, which are names the sender chose. The conversation id is
  // checked on the way in (`drain.ts`) to name this user and the actual sender, so a stranger cannot
  // put an entry into a conversation with a friend, and `_authorUserId` is stamped from the envelope
  // rather than the payload. `includes(f.userId)` was also a substring test on an id, which a
  // prefix-sharing id would have satisfied.
  const activities: FriendActivity[] = useMemo(() => friends.map(f => {
    const convId = conversationId(myUserId, f.userId);
    const isMine = (e: ModelEntry) => authorOf(e.data, AUTHOR_USER_ID) === myUserId;
    const inConversation = (e: ModelEntry) => e.data.conversationId === convId;

    const friendMessages = messages.filter(inConversation);
    const lastMessage = friendMessages.sort((a, b) => b.timestamp - a.timestamp)[0];

    const conversationPix = pixEntries.filter(inConversation);
    const receivedNew = conversationPix.filter(p => !isMine(p) && !p.data.viewedAt);
    const receivedViewed = conversationPix.filter(p => !isMine(p) && !!p.data.viewedAt);
    const sentPending = conversationPix.filter(p => isMine(p) && !p.data.viewedAt);
    const sentOpened = conversationPix.filter(p => isMine(p) && !!p.data.viewedAt);

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
  }).sort((a, b) => b.latestTimestamp - a.latestTimestamp), [friends, messages, pixEntries, myUserId]);

  return (
    // Full-screen page under the floating transparent header (pad content clear
    // of it). Horizontal swipe is owned by the tab pager, not this screen.
    <View style={[cl.page, { paddingTop: headerHeight + 8 }]}>
      {/* Stories row */}
      <StoriesRow />

      {/* Pending requests */}
      {pending.length > 0 && pending.map(f => (
        <View key={f.userId} style={cl.row}>
          <Avatar name={f.username} size={44} background={colors.surfaceMuted} color={colors.text} />
          <View style={cl.info}>
            <Text style={cl.username}>{f.username}</Text>
            <Text style={cl.preview}>
              {f.status === 'pending_received' ? 'Wants to be friends' : 'Request sent'}
            </Text>
          </View>
          {f.status === 'pending_received' && (
            <TouchableOpacity style={cl.acceptBtn} onPress={() => Obscura.acceptFriend(f.userId, f.username)}>
              <Text style={cl.acceptBtnText}>Accept</Text>
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
          const mine = item.lastMessage !== undefined
            && authorOf(item.lastMessage.data, AUTHOR_USER_ID) === myUserId;
          const preview = item.lastMessage?.data.content
            ? `${mine ? 'You: ' : ''}${item.lastMessage.data.content}`
            : 'Tap to chat';

          return (
            <View style={cl.row}>
              {/* Left: pix icon — tap opens pix viewer */}
              <TouchableOpacity
                style={cl.iconZone}
                onPress={() => hasPix ? onViewPix(item.friend, item.unopenedPix) : nav.navigate('Chat', { friend: item.friend })}
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
                  <Avatar name={item.friend.username} size={44} />
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
            ? <Text style={cl.empty}>No friends yet — share your code</Text>
            : null
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 56 }}
      />
    </View>
  );
}

const cl = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  addRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  addInput: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: '#fff', fontSize: 14 },
  addBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 16, justifyContent: 'center' },
  addBtnText: { color: '#000', fontWeight: '700', fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  iconZone: { width: 64, alignItems: 'center', justifyContent: 'center', paddingLeft: 16 },
  chatZone: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 4 },
  // Pix state icons
  iconCircleFilled: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  iconCircleOutline: { width: 44, height: 44, borderRadius: 22, borderWidth: 3, borderColor: colors.accent },
  iconArrowFilled: { width: 0, height: 0, borderLeftWidth: 24, borderTopWidth: 16, borderBottomWidth: 16, borderLeftColor: colors.accent, borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  iconArrowOutline: { width: 0, height: 0, borderLeftWidth: 24, borderTopWidth: 16, borderBottomWidth: 16, borderLeftColor: colors.accent, borderTopColor: 'transparent', borderBottomColor: 'transparent', opacity: 0.4 },
  iconCount: { color: colors.onAccent, fontWeight: '700', fontSize: 16 },
  info: { flex: 1 },
  username: { color: '#fff', fontSize: 16, fontWeight: '600' },
  preview: { color: colors.textSecondary, fontSize: 13, marginTop: 2 },
  time: { color: colors.textDim, fontSize: 12 },
  acceptBtn: { backgroundColor: colors.accent, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
  acceptBtnText: { color: '#000', fontWeight: '700', fontSize: 13 },
  empty: { color: colors.textMuted, textAlign: 'center', marginTop: 32, fontSize: 14 },
  copyBtn: { flex: 1, backgroundColor: colors.surface, borderRadius: 12, padding: 12, alignItems: 'center' },
  copyBtnText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
});
