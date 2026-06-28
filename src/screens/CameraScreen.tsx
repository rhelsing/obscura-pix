import React, { useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking } from 'react-native';
import {
  Camera, useCameraDevice, useCameraPermission,
  type PhotoFile,
} from 'react-native-vision-camera';
import { Obscura } from '../native/ObscuraModule';
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

  // Emulator fallback — native side synthesizes a JPEG so the rest of the
  // capture pipeline (resize / upload) sees the same shape as a real photo.
  const takeTestPhoto = useCallback(async () => {
    const img = await Obscura.writeTestImage(100, 100);
    onPhotoCaptured?.({ path: img.path, width: img.width, height: img.height } as any);
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
  overlay: { ...StyleSheet.absoluteFill, justifyContent: 'space-between' },
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
