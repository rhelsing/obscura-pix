import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import QRCode from 'react-native-qrcode-svg';
import { Obscura } from '../native/ObscuraModule';
import { toast } from '../components/Toast';
import { logError } from '../utils/log';
import { encodeFriendQR } from '../friendQR';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

export function AddFriendScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [myCode, setMyCode] = useState('');
  const [codeInput, setCodeInput] = useState('');

  useEffect(() => {
    Obscura.getFriendCode().then(c => setMyCode(c || '')).catch((e) => logError('getFriendCode', e));
  }, []);

  const copyMyCode = async () => {
    if (!myCode) return;
    try { await Obscura.setClipboard(myCode); toast.success('Friend code copied'); }
    catch (e: any) { toast.error(e.message); }
  };

  const addByCode = async () => {
    const code = codeInput.trim();
    if (!code) return;
    try { await Obscura.addFriendByCode(code); setCodeInput(''); toast.success('Friend request sent'); }
    catch (e: any) { toast.error(e.message); }
  };

  // Dedicated scan screen (codeScanner can't coexist with the record camera's
  // video output — see ScanFriendScreen).
  const scanQR = () => nav.navigate('ScanFriend');

  return (
    <View style={afs.container}>
      {/* My QR */}
      <View style={afs.qrCard}>
        {myCode
          ? <QRCode value={encodeFriendQR(myCode)} size={216} backgroundColor="transparent" color="#fff" />
          : <Text style={afs.dim}>loading…</Text>}
      </View>
      <Text style={afs.caption}>friends can scan this to add you</Text>

      {!!myCode && (
        <TouchableOpacity style={afs.codePill} onPress={copyMyCode}>
          <Text style={afs.codeText} numberOfLines={1}>{myCode}</Text>
          <Text style={afs.copyHint}>copy</Text>
        </TouchableOpacity>
      )}

      <View style={afs.divider} />

      {/* Add by code */}
      <Text style={afs.sectionLabel}>add by code</Text>
      <View style={afs.enterRow}>
        <TextInput
          style={afs.input}
          placeholder="paste friend code"
          placeholderTextColor="#666"
          value={codeInput}
          onChangeText={setCodeInput}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={afs.addBtn} onPress={addByCode}>
          <Text style={afs.addBtnText}>add</Text>
        </TouchableOpacity>
      </View>

      {/* Scan */}
      <TouchableOpacity style={afs.scanBtn} onPress={scanQR}>
        <Text style={afs.scanBtnText}>scan a friend's QR</Text>
      </TouchableOpacity>
    </View>
  );
}

const afs = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: 24, alignItems: 'center' },
  qrCard: {
    width: 256, height: 256, borderRadius: 20, backgroundColor: '#111',
    justifyContent: 'center', alignItems: 'center', marginTop: 12,
    borderWidth: 1, borderColor: colors.border,
  },
  dim: { color: colors.textDim, fontSize: 14 },
  caption: { color: colors.textDim, fontSize: 13, marginTop: 12 },
  codePill: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16,
    backgroundColor: '#111', borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12,
    borderWidth: 1, borderColor: colors.border, maxWidth: '100%',
  },
  codeText: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  copyHint: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  divider: { height: 1, backgroundColor: colors.border, alignSelf: 'stretch', marginVertical: 24 },
  sectionLabel: { color: '#666', fontSize: 12, fontWeight: '700', textTransform: 'uppercase', alignSelf: 'flex-start', marginBottom: 8 },
  enterRow: { flexDirection: 'row', gap: 8, alignSelf: 'stretch' },
  input: {
    flex: 1, backgroundColor: '#111', borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12,
    color: colors.text, fontSize: 15, borderWidth: 1, borderColor: colors.border,
  },
  addBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 20, justifyContent: 'center' },
  addBtnText: { color: '#000', fontWeight: '700', fontSize: 15 },
  scanBtn: {
    alignSelf: 'stretch', marginTop: 20, backgroundColor: '#111', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center', borderWidth: 1, borderColor: colors.border,
  },
  scanBtnText: { color: colors.text, fontWeight: '700', fontSize: 15 },
});
