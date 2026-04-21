import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, Animated, StyleSheet,
} from 'react-native';
import { Obscura, conversationId, type Friend, type ModelEntry } from '../native/ObscuraModule';
import { ObscuraEvents } from '../events';
import { s, colors } from '../styles';

// ─── Typing Bubble ──────────────────────────────────────

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

// ─── Timeline item types ────────────────────────────────

type TimelineItem = ModelEntry & { _kind: 'message' | 'pix' };

// ─── Chat Screen ────────────────────────────────────────

export function ChatScreen({ friend, myUserId, myUsername, onBack, onViewPix }: {
  friend: Friend; myUserId: string; myUsername: string; onBack: () => void;
  onViewPix?: (entry: ModelEntry) => void;
}) {
  const [messages, setMessages] = useState<ModelEntry[]>([]);
  const [pixEntries, setPixEntries] = useState<ModelEntry[]>([]);
  const [text, setText] = useState('');
  const [typers, setTypers] = useState<string[]>([]);
  const convId = conversationId(myUserId, friend.userId);

  const load = useCallback(() => {
    Obscura.queryEntries('directMessage', { 'data.conversationId': convId })
      .then(msgs => setMessages(msgs));
    Obscura.allEntries('pix').then(all => {
      // Pix between me and this friend (sent or received)
      const relevant = all.filter(p =>
        (p.data.senderUsername === friend.username && p.data.recipientUsername === myUsername) ||
        (p.data.senderUsername === myUsername && p.data.recipientUsername === friend.username)
      );
      setPixEntries(relevant);
    });
  }, [convId, friend.username, myUsername]);

  useEffect(() => {
    load();
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'messageReceived') {
        load();
        setTypers([]); // clear typing bubble when a real message arrives
      }
      if (event.type === 'typingChanged' && event.conversationId === convId) {
        setTypers(event.typers || []);
      }
    });
    Obscura.observeTyping(convId);
    return () => {
      sub.remove();
      Obscura.stopObservingTyping(convId);
    };
  }, [convId, load]);

  // Build unified timeline sorted by timestamp
  const timeline: TimelineItem[] = [
    ...messages.map(m => ({ ...m, _kind: 'message' as const })),
    ...pixEntries.map(p => ({ ...p, _kind: 'pix' as const })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  const send = async () => {
    if (!text.trim()) return;
    const msg = text;
    setText('');
    try {
      await Obscura.stopTyping(convId);
      await Obscura.createEntry('directMessage', {
        conversationId: convId, content: msg, senderUsername: myUsername,
      });
      load();
    } catch (e: any) {
      const { Alert } = require('react-native');
      Alert.alert('Send failed', e.message);
    }
  };

  const onChangeText = (t: string) => {
    setText(t);
    if (t.length > 0) Obscura.sendTyping(convId);
  };

  const renderItem = ({ item }: { item: TimelineItem }) => {
    // ─── Chat message
    if (item._kind === 'message') {
      const isMine = item.data.senderUsername === myUsername;
      return (
        <View style={[s.msgRow, isMine ? s.msgRowRight : s.msgRowLeft]}>
          <View style={[s.msgBubble, isMine ? s.myBubble : s.theirBubble]}>
            <Text style={isMine ? s.myBubbleText : s.theirBubbleText}>{item.data.content}</Text>
          </View>
        </View>
      );
    }

    // ─── Pix entry
    const iSent = item.data.senderUsername === myUsername;
    const viewed = !!item.data.viewedAt;

    if (!iSent && !viewed) {
      // Received, unviewed — yellow "Tap to view" bar
      return (
        <TouchableOpacity style={cs.pixBarFilled} onPress={() => onViewPix?.(item)}>
          <Text style={cs.pixBarFilledText}>
            {item.data.caption ? `Tap to view: ${item.data.caption}` : 'Tap to view'}
          </Text>
        </TouchableOpacity>
      );
    }

    if (!iSent && viewed) {
      // Received, viewed — dashed outline bar
      return (
        <View style={cs.pixBarViewed}>
          <Text style={cs.pixBarViewedText}>
            {item.data.caption || 'Viewed'}
          </Text>
        </View>
      );
    }

    if (iSent && !viewed) {
      // Sent, not opened — centered gray text
      return (
        <View style={cs.pixStatus}>
          <Text style={cs.pixStatusText}>you Sent Pix</Text>
        </View>
      );
    }

    // Sent, they opened — centered gray text
    return (
      <View style={cs.pixStatus}>
        <Text style={cs.pixStatusText}>{friend.username} viewed your pix</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.chatHeader}>
        <TouchableOpacity onPress={onBack}><Text style={s.backBtn}>{'<'}</Text></TouchableOpacity>
        <Text style={s.chatTitle}>{friend.username}</Text>
      </View>

      <FlatList
        data={timeline}
        keyExtractor={(item, i) => item.id || `${i}`}
        style={s.messageList}
        renderItem={renderItem}
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
            <Text style={s.sendBtnText}>{'>'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const cs = StyleSheet.create({
  pixBarFilled: {
    backgroundColor: colors.accent, borderRadius: 12, padding: 14,
    marginVertical: 4, marginHorizontal: 12, alignItems: 'center',
  },
  pixBarFilledText: { color: '#000', fontWeight: '700', fontSize: 15 },
  pixBarViewed: {
    borderWidth: 2, borderColor: colors.accent, borderStyle: 'dashed', borderRadius: 12,
    padding: 14, marginVertical: 4, marginHorizontal: 12, alignItems: 'center',
  },
  pixBarViewedText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
  pixStatus: { paddingVertical: 12, alignItems: 'center' },
  pixStatusText: { color: '#666', fontSize: 13 },
});
