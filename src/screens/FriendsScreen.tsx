import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert } from 'react-native';
import { Obscura, type Friend } from '../native/ObscuraModule';
import { s } from '../styles';

export function FriendsScreen({ friends, pending, onSelectFriend }: {
  friends: Friend[]; pending: Friend[]; onSelectFriend: (f: Friend) => void;
}) {
  const [codeInput, setCodeInput] = useState('');

  const addFriend = async () => {
    try { await Obscura.addFriendByCode(codeInput); setCodeInput(''); }
    catch (e: any) { Alert.alert('Error', e.message); }
  };

  const copyMyCode = async () => {
    try {
      const code = await Obscura.getFriendCode();
      if (code) {
        try { const { Clipboard } = require('react-native'); Clipboard.setString(code); } catch {}
        Alert.alert('Copied!', 'Friend code copied to clipboard');
      }
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  return (
    <View style={s.screen}>
      <TouchableOpacity style={s.codeBtn} onPress={copyMyCode}>
        <Text style={s.codeBtnText}>copy my friend code</Text>
      </TouchableOpacity>

      <View style={s.row}>
        <TextInput style={[s.input, { flex: 1, marginBottom: 0 }]}
          placeholder="paste friend code" placeholderTextColor="#666"
          value={codeInput} onChangeText={setCodeInput} />
        <TouchableOpacity style={s.smallBtn} onPress={addFriend}>
          <Text style={s.smallBtnText}>add</Text>
        </TouchableOpacity>
      </View>

      {pending.length > 0 && (<>
        <Text style={s.sectionTitle}>requests</Text>
        {pending.map(f => (
          <View key={f.userId} style={s.friendRow}>
            <Text style={s.friendName}>{f.username}</Text>
            {f.status === 'pending_received' ? (
              <TouchableOpacity style={s.smallBtn} onPress={() => Obscura.acceptFriend(f.userId, f.username)}>
                <Text style={s.smallBtnText}>accept</Text>
              </TouchableOpacity>
            ) : (
              <Text style={{ color: '#999', fontSize: 12 }}>pending</Text>
            )}
          </View>
        ))}
      </>)}

      <Text style={s.sectionTitle}>friends</Text>
      {friends.length === 0 ? (
        <Text style={s.empty}>no friends yet — share your code</Text>
      ) : friends.map(f => (
        <TouchableOpacity key={f.userId} style={s.friendRow} onPress={() => onSelectFriend(f)}>
          <View style={s.avatar}><Text style={s.avatarText}>{f.username[0]?.toUpperCase()}</Text></View>
          <Text style={s.friendName}>{f.username}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
