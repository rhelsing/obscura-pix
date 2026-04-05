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

interface FriendActivity {
  friend: Friend;
  lastMessage?: ModelEntry;
  unopenedPix: ModelEntry[];
  latestTimestamp: number;
}

export function ChatListScreen({ friends, pending, myUsername, onSelectFriend, onViewPix }: {
  friends: Friend[];
  pending: Friend[];
  myUsername: string;
  onSelectFriend: (f: Friend) => void;
  onViewPix: (entry: ModelEntry) => void;
}) {
  const [codeInput, setCodeInput] = useState('');
  const [messages, setMessages] = useState<ModelEntry[]>([]);
  const [pixEntries, setPixEntries] = useState<ModelEntry[]>([]);

  const load = useCallback(() => {
    Obscura.allEntries('directMessage').then(setMessages).catch(() => {});
    Obscura.allEntries('pix').then(setPixEntries).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'messageReceived') load();
    });
    return () => sub.remove();
  }, [load]);

  const addFriend = async () => {
    try { await Obscura.addFriendByCode(codeInput); setCodeInput(''); }
    catch (e: any) { Alert.alert('Error', e.message); }
  };

  // Build activity list — each friend with their latest chat + pix
  const activities: FriendActivity[] = friends.map(f => {
    const friendMessages = messages.filter(m =>
      m.data.senderUsername === f.username || m.data.conversationId?.includes(f.userId)
    );
    const lastMessage = friendMessages.sort((a, b) => b.timestamp - a.timestamp)[0];
    const unopenedPix = pixEntries.filter(p =>
      p.data.senderUsername === f.username && p.data.recipientUsername === myUsername
    );
    const latestTimestamp = Math.max(
      lastMessage?.timestamp || 0,
      ...unopenedPix.map(p => p.timestamp),
      0
    );
    return { friend: f, lastMessage, unopenedPix, latestTimestamp };
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
          return (
            <TouchableOpacity
              style={cl.row}
              onPress={() => hasPix ? onViewPix(item.unopenedPix[0]) : onSelectFriend(item.friend)}
            >
              <View style={cl.avatar}>
                <Text style={cl.avatarText}>{item.friend.username[0]?.toUpperCase()}</Text>
              </View>
              {hasPix && <View style={cl.pixDot} />}
              <View style={cl.info}>
                <Text style={cl.username}>{item.friend.username}</Text>
                <Text style={cl.preview} numberOfLines={1}>
                  {hasPix
                    ? `${item.unopenedPix.length} new pix`
                    : item.lastMessage?.data.content
                    ? `${item.lastMessage.data.senderUsername === myUsername ? 'You: ' : ''}${item.lastMessage.data.content}`
                    : 'tap to chat'
                  }
                </Text>
              </View>
              {item.latestTimestamp > 0 && (
                <Text style={cl.time}>{timeAgo(item.latestTimestamp)}</Text>
              )}
            </TouchableOpacity>
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
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },
  avatarPending: { backgroundColor: '#333' },
  avatarText: { color: '#000', fontWeight: '700', fontSize: 20 },
  pixDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, position: 'absolute', left: 50, top: 12, zIndex: 1 },
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
