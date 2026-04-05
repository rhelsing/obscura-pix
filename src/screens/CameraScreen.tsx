import React, { useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import {
  Camera, useCameraDevice, useCameraPermission,
  type PhotoFile,
} from 'react-native-vision-camera';
import { colors } from '../styles';

export function CameraScreen({ onPhotoCaptured }: {
  onPhotoCaptured?: (photo: PhotoFile) => void;
}) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const camera = useRef<Camera>(null);
  const device = useCameraDevice(facing);

  const takePhoto = useCallback(async () => {
    if (!camera.current) return;
    const photo = await camera.current.takePhoto({ flash });
    onPhotoCaptured?.(photo);
  }, [flash, onPhotoCaptured]);

  const flipCamera = () => setFacing(f => f === 'back' ? 'front' : 'back');
  const toggleFlash = () => setFlash(f => f === 'off' ? 'on' : 'off');

  // Test photo for simulator — must be before any early returns (hooks rule)
  const takeTestPhoto = useCallback(async () => {
    const r = Math.floor(Math.random() * 256);
    const g = Math.floor(Math.random() * 256);
    const b = Math.floor(Math.random() * 256);
    const w = 100, h = 100;
    const rowSize = Math.ceil((w * 3) / 4) * 4;
    const pixelDataSize = rowSize * h;
    const fileSize = 54 + pixelDataSize;
    const buf = new Uint8Array(fileSize);
    buf[0] = 0x42; buf[1] = 0x4D;
    buf[2] = fileSize & 0xFF; buf[3] = (fileSize >> 8) & 0xFF;
    buf[4] = (fileSize >> 16) & 0xFF; buf[5] = (fileSize >> 24) & 0xFF;
    buf[10] = 54; buf[14] = 40;
    buf[18] = w & 0xFF; buf[19] = (w >> 8) & 0xFF;
    buf[22] = h & 0xFF; buf[23] = (h >> 8) & 0xFF;
    buf[26] = 1; buf[28] = 24;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const offset = 54 + y * rowSize + x * 3;
        buf[offset] = b; buf[offset + 1] = g; buf[offset + 2] = r;
      }
    }
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let base64 = '';
    for (let i = 0; i < buf.length; i += 3) {
      const a = buf[i], bb = buf[i + 1] || 0, c = buf[i + 2] || 0;
      base64 += chars[a >> 2] + chars[((a & 3) << 4) | (bb >> 4)] +
        (i + 1 < buf.length ? chars[((bb & 15) << 2) | (c >> 6)] : '=') +
        (i + 2 < buf.length ? chars[c & 63] : '=');
    }
    const path = `${RNFS.TemporaryDirectoryPath}/test_photo_${Date.now()}.bmp`;
    await RNFS.writeFile(path, base64, 'base64');
    onPhotoCaptured?.({ path, width: w, height: h } as any);
  }, [onPhotoCaptured]);

  // Permission not granted yet
  if (!hasPermission) {
    return (
      <View style={cs.permissionContainer}>
        <Text style={cs.permissionText}>camera access needed</Text>
        <TouchableOpacity style={cs.permissionBtn} onPress={requestPermission}>
          <Text style={cs.permissionBtnText}>grant access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openSettings()}>
          <Text style={cs.settingsLink}>open settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // No device available (emulator without camera)
  if (!device) {
    return (
      <View style={cs.permissionContainer}>
        <Text style={cs.permissionText}>no camera available</Text>
        <Text style={cs.hint}>simulator mode — tap to use test photo</Text>
        <TouchableOpacity style={cs.permissionBtn} onPress={takeTestPhoto}>
          <Text style={cs.permissionBtnText}>use test photo</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={cs.container}>
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={true}
        photo={true}
      />

      {/* Controls overlay */}
      <View style={cs.overlay}>
        {/* Top controls */}
        <View style={cs.topControls}>
          <TouchableOpacity style={cs.iconBtn} onPress={toggleFlash}>
            <Text style={cs.iconText}>{flash === 'on' ? 'FLASH ON' : 'FLASH'}</Text>
          </TouchableOpacity>
        </View>

        {/* Bottom controls */}
        <View style={cs.bottomControls}>
          <View style={cs.controlsRow}>
            <TouchableOpacity style={cs.sideBtn} onPress={flipCamera}>
              <Text style={cs.sideBtnText}>FLIP</Text>
            </TouchableOpacity>

            <TouchableOpacity style={cs.captureBtn} onPress={takePhoto} activeOpacity={0.7}>
              <View style={cs.captureBtnInner} />
            </TouchableOpacity>

            <View style={cs.sideBtn} />
          </View>
        </View>
      </View>
    </View>
  );
}

const cs = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  topControls: { flexDirection: 'row', justifyContent: 'flex-end', padding: 16, paddingTop: 8 },
  bottomControls: { paddingBottom: 16, paddingHorizontal: 24 },
  controlsRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  iconBtn: { padding: 12 },
  iconText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  sideBtn: { width: 48, height: 48, justifyContent: 'center', alignItems: 'center' },
  sideBtnText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  captureBtn: {
    width: 76, height: 76, borderRadius: 38, borderWidth: 4,
    borderColor: '#fff', justifyContent: 'center', alignItems: 'center',
  },
  captureBtnInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
  permissionContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 32 },
  permissionText: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 16 },
  permissionBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginBottom: 12 },
  permissionBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  settingsLink: { color: colors.accent, fontSize: 14 },
  hint: { color: '#666', fontSize: 14, marginTop: 8 },
});
