import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  SafeAreaView, View, Text, TextInput, TouchableOpacity, FlatList,
  KeyboardAvoidingView, Platform, Animated,
} from 'react-native';
import { Obscura, conversationId, type Friend, type ModelEntry } from '../native/ObscuraModule';
import { ObscuraEvents } from '../events';
import { s } from '../styles';

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

export function ChatScreen({ friend, myUserId, myUsername, onBack }: {
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

  useEffect(() => {
    loadMessages();
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'messageReceived') {
        loadMessages();
        setTypers([]);
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
    } catch (e: any) {
      const { Alert } = require('react-native');
      Alert.alert('Send failed', e.message);
    }
  };

  const onChangeText = (t: string) => {
    setText(t);
    if (t.length > 0) Obscura.sendTyping(convId);
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.chatHeader}>
        <TouchableOpacity onPress={onBack}><Text style={s.backBtn}>{'<'}</Text></TouchableOpacity>
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
            <Text style={s.sendBtnText}>{'>'}</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
