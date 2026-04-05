import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { colors } from '../styles';

const TIMER_OPTIONS = [
  { label: '3s', value: 3 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: 'no limit', value: 0 },
];

export function PhotoPreviewScreen({ photoPath, onSend, onRetake }: {
  photoPath: string;
  onSend: (opts: { caption: string; displayDuration: number }) => void;
  onRetake: () => void;
}) {
  const [caption, setCaption] = useState('');
  const [duration, setDuration] = useState(5);

  return (
    <View style={ps.container}>
      <Image source={{ uri: `file://${photoPath}` }} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Top: retake button */}
      <View style={ps.topBar}>
        <TouchableOpacity onPress={onRetake} style={ps.retakeBtn}>
          <Text style={ps.retakeBtnText}>{'X'}</Text>
        </TouchableOpacity>
      </View>

      {/* Bottom: caption + timer + send */}
      <View style={ps.bottomArea}>
        <TextInput
          style={ps.captionInput}
          placeholder="add a caption..."
          placeholderTextColor="#999"
          value={caption}
          onChangeText={setCaption}
          maxLength={100}
        />

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

        <TouchableOpacity
          style={ps.sendBtn}
          onPress={() => onSend({ caption, displayDuration: duration })}
        >
          <Text style={ps.sendBtnText}>choose recipients</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const ps = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', justifyContent: 'flex-start', padding: 16, paddingTop: 48 },
  retakeBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  retakeBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  bottomArea: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 16, paddingBottom: 40 },
  captionInput: {
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10, color: '#fff', fontSize: 16, marginBottom: 12,
  },
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
