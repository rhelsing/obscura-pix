import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList, Alert, StyleSheet, Modal,
} from 'react-native';
import { Obscura, type Friend, type ModelEntry } from '../native/ObscuraModule';
import { ObscuraEvents } from '../events';
import { StoriesScreen } from './StoriesScreen';
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

export function ChatListScreen({ friends, pending, myUsername, onSelectFriend, onViewPix, refreshTrigger }: {
  friends: Friend[];
  pending: Friend[];
  myUsername: string;
  onSelectFriend: (f: Friend) => void;
  onViewPix: (entry: ModelEntry) => void;
  refreshTrigger?: number;
}) {
  const [codeInput, setCodeInput] = useState('');
  const [messages, setMessages] = useState<ModelEntry[]>([]);
  const [pixEntries, setPixEntries] = useState<ModelEntry[]>([]);

  const load = useCallback(() => {
    Obscura.allEntries('directMessage').then(setMessages).catch(() => {});
    Obscura.allEntries('pix').then(entries => {
      for (const e of entries) console.log(`[ChatList] pix id=${e.id} viewedAt=${e.data.viewedAt} deleted=${e.data._deleted}`);
      setPixEntries(entries);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'messageReceived') load();
    });
    return () => sub.remove();
  }, [load]);

  // Reload when triggered externally (e.g. after pix deletion)
  useEffect(() => { load(); }, [refreshTrigger]);

  const addFriend = async () => {
    try { await Obscura.addFriendByCode(codeInput); setCodeInput(''); }
    catch (e: any) { Alert.alert('Error', e.message); }
  };

  // Build activity list — each friend with their latest chat + pix state
  const activities: FriendActivity[] = friends.map(f => {
    const friendMessages = messages.filter(m =>
      m.data.senderUsername === f.username || m.data.conversationId?.includes(f.userId)
    );
    const lastMessage = friendMessages.sort((a, b) => b.timestamp - a.timestamp)[0];

    // Pix I received from this friend
    const receivedNew = pixEntries.filter(p =>
      p.data.senderUsername === f.username && p.data.recipientUsername === myUsername
      && !p.data._deleted && !p.data.viewedAt
    );
    const receivedViewed = pixEntries.filter(p =>
      p.data.senderUsername === f.username && p.data.recipientUsername === myUsername
      && !p.data._deleted && !!p.data.viewedAt
    );
    // Pix I sent to this friend
    const sentPending = pixEntries.filter(p =>
      p.data.senderUsername === myUsername && p.data.recipientUsername === f.username
      && !p.data._deleted && !p.data.viewedAt
    );
    const sentOpened = pixEntries.filter(p =>
      p.data.senderUsername === myUsername && p.data.recipientUsername === f.username
      && !p.data._deleted && !!p.data.viewedAt
    );

    // Most recent pix action determines icon
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
  }).sort((a, b) => b.latestTimestamp - a.latestTimestamp);

  return (
    <View style={{ flex: 1 }}>
      {/* Stories row */}
      <StoriesScreen myUsername={myUsername} />

      {/* Add friend */}
      <View style={cl.addRow}>
        <TouchableOpacity style={cl.copyBtn} onPress={async () => {
          try {
            const code = await Obscura.getFriendCode();
            if (code) {
              try { const { Clipboard } = require('react-native'); Clipboard.setString(code); } catch {}
              Alert.alert('Copied!', 'Friend code copied to clipboard');
            }
          } catch (e: any) { Alert.alert('Error', e.message); }
        }}>
          <Text style={cl.copyBtnText}>copy my code</Text>
        </TouchableOpacity>
      </View>
      <View style={cl.addRow}>
        <TextInput style={cl.addInput}
          placeholder="paste friend code" placeholderTextColor="#666"
          value={codeInput} onChangeText={setCodeInput} />
        <TouchableOpacity style={cl.addBtn} onPress={addFriend}>
          <Text style={cl.addBtnText}>add</Text>
        </TouchableOpacity>
      </View>

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
                onPress={() => hasPix ? onViewPix(item.unopenedPix[0]) : onSelectFriend(item.friend)}
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
              <TouchableOpacity style={cl.chatZone} onPress={() => onSelectFriend(item.friend)}>
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
    </View>
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
