import React, { useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, StyleSheet } from 'react-native';
import { type Friend } from '../native/ObscuraModule';
import { colors } from '../styles';

export function RecipientPicker({ friends, onSend, onCancel }: {
  friends: Friend[];
  onSend: (recipients: Friend[], includeStory: boolean) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeStory, setIncludeStory] = useState(false);

  const toggle = (userId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

  const handleSend = () => {
    const recipients = friends.filter(f => selected.has(f.userId));
    if (recipients.length === 0 && !includeStory) return;
    onSend(recipients, includeStory);
  };

  const count = selected.size + (includeStory ? 1 : 0);

  return (
    <View style={rp.container}>
      <View style={rp.header}>
        <TouchableOpacity onPress={onCancel}>
          <Text style={rp.cancelText}>cancel</Text>
        </TouchableOpacity>
        <Text style={rp.title}>send to</Text>
        <View style={{ width: 50 }} />
      </View>

      {/* Story option */}
      <TouchableOpacity style={rp.row} onPress={() => setIncludeStory(!includeStory)}>
        <View style={[rp.check, includeStory && rp.checkActive]}>
          {includeStory && <Text style={rp.checkMark}>{'V'}</Text>}
        </View>
        <Text style={rp.rowText}>my story</Text>
        <Text style={rp.rowHint}>visible to all friends</Text>
      </TouchableOpacity>

      <Text style={rp.sectionTitle}>friends</Text>

      <FlatList
        data={friends}
        keyExtractor={f => f.userId}
        renderItem={({ item }) => {
          const isSelected = selected.has(item.userId);
          return (
            <TouchableOpacity style={rp.row} onPress={() => toggle(item.userId)}>
              <View style={[rp.check, isSelected && rp.checkActive]}>
                {isSelected && <Text style={rp.checkMark}>{'V'}</Text>}
              </View>
              <View style={rp.avatar}>
                <Text style={rp.avatarText}>{item.username[0]?.toUpperCase()}</Text>
              </View>
              <Text style={rp.rowText}>{item.username}</Text>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={<Text style={rp.empty}>no friends yet</Text>}
      />

      <TouchableOpacity
        style={[rp.sendBtn, count === 0 && rp.sendBtnDisabled]}
        onPress={handleSend}
        disabled={count === 0}
      >
        <Text style={rp.sendBtnText}>
          {count === 0 ? 'select recipients' : `send to ${count}`}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const rp = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, paddingTop: 48 },
  cancelText: { color: colors.accent, fontSize: 16 },
  title: { color: '#fff', fontSize: 18, fontWeight: '700' },
  sectionTitle: { color: '#666', fontSize: 12, fontWeight: '700', marginLeft: 16, marginTop: 16, marginBottom: 8, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: '#444', justifyContent: 'center', alignItems: 'center' },
  checkActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkMark: { color: '#000', fontSize: 14, fontWeight: '700' },
  avatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#333', justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  rowText: { color: '#fff', fontSize: 16, flex: 1 },
  rowHint: { color: '#666', fontSize: 13 },
  empty: { color: '#444', textAlign: 'center', marginTop: 32, fontSize: 14 },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center', margin: 16, marginBottom: 40 },
  sendBtnDisabled: { backgroundColor: '#333' },
  sendBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
});
