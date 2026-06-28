import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, Image, StyleSheet, KeyboardAvoidingView, Keyboard, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackScreenProps, RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

const TIMER_OPTIONS = [
  { label: '3s', value: 3 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: 'no limit', value: 0 },
];

export function PhotoPreviewScreen({ route }: RootStackScreenProps<'PhotoPreview'>) {
  const { photo } = route.params;
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const [caption, setCaption] = useState('');
  const [duration, setDuration] = useState(5);
  const [keyboardUp, setKeyboardUp] = useState(false);

  useEffect(() => {
    const showSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      () => setKeyboardUp(true),
    );
    const hideSub = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboardUp(false),
    );
    return () => { showSub.remove(); hideSub.remove(); };
  }, []);

  const onRetake = () => nav.goBack();
  const onChoose = () =>
    nav.navigate('RecipientPicker', { photo, caption, displayDuration: duration });

  return (
    <View style={ps.container}>
      <Image source={{ uri: `file://${photo.path}` }} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Top: retake button — floats over the photo */}
      <View style={ps.topBar}>
        <TouchableOpacity onPress={onRetake} style={ps.retakeBtn}>
          <Text style={ps.retakeBtnText}>{'X'}</Text>
        </TouchableOpacity>
      </View>

      {/* Caption rides directly above the keyboard via KeyboardAvoidingView
          (Snapchat-style). When the keyboard is up the timer + send button
          are hidden to leave just the caption + keyboard visible. */}
      <KeyboardAvoidingView
        style={ps.kavRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        pointerEvents="box-none"
      >
        <View style={ps.spacer} pointerEvents="none" />
        <TextInput
          style={ps.captionInput}
          placeholder="add a caption..."
          placeholderTextColor="#999"
          value={caption}
          onChangeText={setCaption}
          maxLength={100}
        />
        {!keyboardUp && (
          <View style={ps.controlsBlock}>
            <View style={ps.timerRow}>
              {TIMER_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[ps.timerBtn, duration === opt.value && ps.timerBtnActive]}
                  onPress={() => setDuration(opt.value)}
                >
                  <Text style={[ps.timerText, duration === opt.value && ps.timerTextActive]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity style={ps.sendBtn} onPress={onChoose}>
              <Text style={ps.sendBtnText}>choose recipients</Text>
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const ps = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'flex-start', padding: 16, paddingTop: 48,
    zIndex: 1,
  },
  retakeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  retakeBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  kavRoot: { flex: 1 },
  spacer: { flex: 1 },
  captionInput: {
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, color: '#fff', fontSize: 16,
    marginHorizontal: 16, marginBottom: 12,
  },
  controlsBlock: { paddingHorizontal: 16, paddingBottom: 40 },
  timerRow: { flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 16 },
  timerBtn: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  timerBtnActive: { backgroundColor: colors.accent },
  timerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  timerTextActive: { color: '#000' },
  sendBtn: { backgroundColor: colors.accent, borderRadius: 12, padding: 14, alignItems: 'center' },
  sendBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
});
