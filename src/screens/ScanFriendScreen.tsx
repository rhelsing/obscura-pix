import React, { useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import {
  Camera, useCameraDevice, useCameraPermission, useCodeScanner,
} from 'react-native-vision-camera';
import type { Code } from 'react-native-vision-camera';
import { useNavigation, useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Obscura } from '../native/ObscuraModule';
import { toast } from '../components/Toast';
import { parseFriendQR } from '../friendQR';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

/**
 * Dedicated QR scan mode. Per the vision-camera constraint, the code scanner
 * can't run alongside a video output (iOS throws not-compatible-with-outputs;
 * Android hits CameraX's use-case limit) — so this is its own screen with
 * `photo` + `codeScanner` only (no video/audio/frameProcessor), NOT the record
 * camera tab. isActive is gated on focus so it releases cleanly on exit.
 */
export function ScanFriendScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const isFocused = useIsFocused();
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  const handled = useRef(false); // onCodeScanned fires repeatedly — only act once

  const onCodeScanned = useCallback((codes: Code[]) => {
    if (handled.current) return;
    for (const c of codes) {
      const code = parseFriendQR(c.value);
      if (!code) continue; // ignore non-Obscura QR codes
      handled.current = true;
      Obscura.addFriendByCode(code)
        .then(() => { toast.success('Friend request sent'); nav.goBack(); })
        .catch((e: any) => { toast.error(e.message); handled.current = false; });
      return;
    }
  }, [nav]);

  const codeScanner = useCodeScanner({ codeTypes: ['qr'], onCodeScanned });

  if (!hasPermission) {
    return (
      <View style={ss.center}>
        <Text style={ss.msg}>camera access needed to scan</Text>
        <TouchableOpacity style={ss.btn} onPress={requestPermission}>
          <Text style={ss.btnText}>grant access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openSettings()}>
          <Text style={ss.link}>open settings</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!device) {
    return <View style={ss.center}><Text style={ss.msg}>no camera available</Text></View>;
  }

  return (
    <View style={ss.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isFocused}
        codeScanner={codeScanner}
        photo={true}
      />
      <View style={ss.overlay} pointerEvents="box-none">
        <View style={ss.frame} />
        <Text style={ss.hint}>point at a friend's QR code</Text>
      </View>
      <TouchableOpacity style={ss.close} onPress={() => nav.goBack()}>
        <Text style={ss.closeText}>{'X'}</Text>
      </TouchableOpacity>
    </View>
  );
}

const ss = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 32 },
  msg: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 16, textAlign: 'center' },
  btn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginBottom: 12 },
  btnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  link: { color: colors.accent, fontSize: 14 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center' },
  frame: {
    width: 240, height: 240, borderRadius: 24,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)',
  },
  hint: { color: '#fff', fontSize: 15, fontWeight: '600', marginTop: 20, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  close: {
    position: 'absolute', top: 48, left: 16, width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center',
  },
  closeText: { color: '#fff', fontSize: 18, fontWeight: '700' },
});
