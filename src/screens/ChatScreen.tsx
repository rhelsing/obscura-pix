import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, Animated, StyleSheet,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura, onObscuraEvent, conversationId, type ModelEntry } from '../native/ObscuraModule';
import { useSession, useModelEntries } from '../state/store';
import { toast } from '../components/Toast';
import { SendIcon } from '../components/icons';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { openPixViewer } from '../navigation/openPixViewer';
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
    <View style={cs.typingBubble}>
      {[dot1, dot2, dot3].map((opacity, i) => (
        <Animated.View key={i} style={[cs.typingDot, { opacity }]} />
      ))}
    </View>
  );
}

// ─── Timeline item types ────────────────────────────────

type TimelineItem = ModelEntry & { _kind: 'message' | 'pix' };

// ─── Chat Screen ────────────────────────────────────────

export function ChatScreen({ route }: RootStackScreenProps<'Chat'>) {
  const { friend } = route.params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { myUserId, myUsername } = useSession();
  const headerHeight = useHeaderHeight();
  const allMessages = useModelEntries('directMessage');
  const allPix = useModelEntries('pix');
  const [text, setText] = useState('');
  const [typers, setTypers] = useState<string[]>([]);
  const convId = conversationId(myUserId, friend.userId);

  // Per-conversation slice of the global cache.
  const messages = useMemo(
    () => allMessages.filter(m => m.data.conversationId === convId),
    [allMessages, convId],
  );
  // Pix between me and this friend (sent or received).
  const pixEntries = useMemo(
    () => allPix.filter(p =>
      (p.data.senderUsername === friend.username && p.data.recipientUsername === myUsername) ||
      (p.data.senderUsername === myUsername && p.data.recipientUsername === friend.username)
    ),
    [allPix, friend.username, myUsername],
  );

  const onViewPix = (entry: ModelEntry) => openPixViewer(nav, [entry]);

  // Typing observer + bubble — separate from entry-cache subscriptions since
  // typing isn't backed by entries.
  useEffect(() => {
    const unsub = onObscuraEvent((event) => {
      if (event.type === 'messageReceived' && event.model === 'directMessage') {
        setTypers([]); // clear typing bubble when a real message arrives
      } else if (event.type === 'typingChanged' && event.conversationId === convId) {
        setTypers(event.typers || []);
      }
    });
    Obscura.observeTyping(convId);
    return () => {
      unsub();
      Obscura.stopObservingTyping(convId);
    };
  }, [convId]);

  // Build unified timeline sorted by timestamp.
  const timeline: TimelineItem[] = useMemo(() => [
    ...messages.map(m => ({ ...m, _kind: 'message' as const })),
    ...pixEntries.map(p => ({ ...p, _kind: 'pix' as const })),
  ].sort((a, b) => a.timestamp - b.timestamp), [messages, pixEntries]);

  const send = async () => {
    if (!text.trim()) return;
    const msg = text;
    setText('');
    try {
      await Obscura.stopTyping(convId);
      await Obscura.createEntry('directMessage', {
        conversationId: convId, content: msg, senderUsername: myUsername,
      });
    } catch (e: any) {
      toast.error(e.message);
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
        <View style={[cs.msgRow, isMine ? cs.msgRowRight : cs.msgRowLeft]}>
          <View style={[cs.msgBubble, isMine ? cs.myBubble : cs.theirBubble]}>
            <Text style={isMine ? cs.myBubbleText : cs.theirBubbleText}>{item.data.content}</Text>
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
        <TouchableOpacity style={cs.pixBarFilled} onPress={() => onViewPix(item)}>
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
          <Text style={cs.pixStatusText}>You sent a pix</Text>
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
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
      >
        <FlatList
          data={timeline}
          keyExtractor={(item, i) => item.id || `${i}`}
          style={cs.messageList}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          renderItem={renderItem}
          ListFooterComponent={typers.length > 0 ? (
            <View style={[cs.msgRow, cs.msgRowLeft]}>
              <TypingBubble />
            </View>
          ) : null}
        />

        <View style={cs.composer}>
          <TextInput style={cs.composerInput} placeholder="Message" placeholderTextColor={colors.textDim}
            value={text} onChangeText={onChangeText} />
          <TouchableOpacity style={cs.sendBtn} onPress={send} disabled={!text.trim()}>
            <SendIcon size={20} color={colors.onAccent} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const cs = StyleSheet.create({
  messageList: { flex: 1, paddingHorizontal: 12 },
  msgRow: { marginVertical: 2 },
  msgRowRight: { alignItems: 'flex-end' },
  msgRowLeft: { alignItems: 'flex-start' },
  msgBubble: { borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8, maxWidth: '75%' },
  myBubble: { backgroundColor: colors.accent },
  theirBubble: { backgroundColor: colors.surface },
  myBubbleText: { color: colors.onAccent, fontSize: 16 },
  theirBubbleText: { color: colors.text, fontSize: 16 },
  typingBubble: {
    flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 18,
    paddingHorizontal: 14, paddingVertical: 10, gap: 4, marginVertical: 2,
  },
  typingDot: {
    width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textDim,
  },
  composer: { flexDirection: 'row', padding: 12, gap: 8, borderTopWidth: 0.5, borderTopColor: colors.border },
  composerInput: { flex: 1, backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, color: colors.text, fontSize: 16 },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 20, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
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
  pixStatusText: { color: colors.textDim, fontSize: 13 },
});
