import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { Obscura, type ModelEntry } from '../native/ObscuraModule';
import { ObscuraEvents } from '../events';
import { colors } from '../styles';

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function PixInbox({ myUsername, onViewPix }: {
  myUsername: string;
  onViewPix?: (entry: ModelEntry) => void;
}) {
  const [received, setReceived] = useState<ModelEntry[]>([]);
  const [sent, setSent] = useState<ModelEntry[]>([]);

  const load = useCallback(() => {
    Obscura.allEntries('pix').then(entries => {
      const rx = entries.filter(e => e.data.recipientUsername === myUsername)
        .sort((a, b) => b.timestamp - a.timestamp);
      const tx = entries.filter(e => e.data.senderUsername === myUsername)
        .sort((a, b) => b.timestamp - a.timestamp);
      setReceived(rx);
      setSent(tx);
    }).catch(() => {});
  }, [myUsername]);

  useEffect(() => {
    load();
    const sub = ObscuraEvents.addListener('ObscuraEvent', (event) => {
      if (event.type === 'messageReceived') load();
    });
    return () => sub.remove();
  }, [load]);

  return (
    <View style={pi.container}>
      {received.length > 0 && (
        <>
          <Text style={pi.section}>received</Text>
          <FlatList
            data={received}
            keyExtractor={item => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={pi.row} onPress={() => onViewPix?.(item)}>
                <View style={pi.dot} />
                <View style={pi.info}>
                  <Text style={pi.sender}>{item.data.senderUsername}</Text>
                  {item.data.caption ? <Text style={pi.caption}>{item.data.caption}</Text> : null}
                </View>
                <Text style={pi.time}>{timeAgo(item.timestamp)}</Text>
              </TouchableOpacity>
            )}
          />
        </>
      )}

      {sent.length > 0 && (
        <>
          <Text style={pi.section}>sent</Text>
          {sent.map(item => (
            <View key={item.id} style={pi.row}>
              <View style={[pi.dot, pi.dotSent]} />
              <View style={pi.info}>
                <Text style={pi.sender}>{item.data.recipientUsername}</Text>
              </View>
              <Text style={pi.time}>{timeAgo(item.timestamp)}</Text>
            </View>
          ))}
        </>
      )}

      {received.length === 0 && sent.length === 0 && (
        <Text style={pi.empty}>no pix yet — take a photo and send it</Text>
      )}
    </View>
  );
}

const pi = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  section: { color: '#666', fontSize: 12, fontWeight: '700', marginTop: 16, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, gap: 12 },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accent },
  dotSent: { backgroundColor: '#666' },
  info: { flex: 1 },
  sender: { color: '#fff', fontSize: 16, fontWeight: '600' },
  caption: { color: '#999', fontSize: 13, marginTop: 2 },
  time: { color: '#666', fontSize: 12 },
  empty: { color: '#444', textAlign: 'center', marginTop: 48, fontSize: 14 },
});
