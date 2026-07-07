import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet, Linking, PanResponder, Animated } from 'react-native';
import {
  Camera, useCameraDevice, useCameraPermission, useCameraFormat, useMicrophonePermission,
} from 'react-native-vision-camera';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Obscura } from '../native/ObscuraModule';
import { useCameraActive } from '../navigation/CameraActiveContext';
import { logError } from '../utils/log';
import { FlashIcon, FlipCameraIcon } from '../components/icons';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

// Quick tap vs press-and-hold threshold for the shutter (ms).
const HOLD_TO_RECORD_MS = 220;

// Space the bottom controls clear of the floating tab bar. Small — enough to
// clear the tab bar but keep the shutter grounded near the bottom (a large gap
// made it look like it floated in dead space).
const TAB_BAR_CLEARANCE = 24;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const touchDist = (touches: { pageX: number; pageY: number }[]) =>
  Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);

export function CameraScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hasPermission, requestPermission } = useCameraPermission();
  const { hasPermission: hasMic, requestPermission: requestMic } = useMicrophonePermission();
  const insets = useSafeAreaInsets();
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [zoom, setZoom] = useState(1);
  const [recording, setRecording] = useState(false);
  const camera = useRef<Camera>(null);
  const device = useCameraDevice(facing);

  // Keep the VisionCamera session live only while the record-camera tab is
  // actually on-screen and the app is foregrounded. MainTabs drives this via
  // CameraActiveContext (MainTabs-focused && app-active): it stays true across a
  // left/right tab swipe (so the preview slides in live, not black), but flips
  // false when a modal covers MainTabs — notably ScanFriend, which opens its
  // OWN camera and would otherwise collide with this one on CameraX — or when
  // the app backgrounds (screen lock), which is what fixes the black-preview-
  // after-unlock bug.
  const cameraActive = useCameraActive();

  // Cap to a sane 1080p30 format. Without this VisionCamera picks a 120fps HEVC
  // monster that makes the recording AssetWriter slow to start + huge files.
  // We downscale photos to 1080 before sending anyway, so this is lossless there.
  const format = useCameraFormat(device, [
    { fps: 30 },
    { videoResolution: { width: 1920, height: 1080 } },
    { photoResolution: { width: 1920, height: 1080 } },
  ]);

  // Mic for video audio — request once. Recording still works (silent) if denied.
  useEffect(() => { if (!hasMic) requestMic(); }, [hasMic, requestMic]);

  // Warm the audio HAL so hold-to-record starts instantly (cold AVAudioSession
  // activation is ~1.4s on iOS). Warm on mount + re-warm after each recording,
  // since VisionCamera deactivates the session when a recording ends.
  const prewarmAudio = useCallback(() => {
    Obscura.prewarmAudioSession().catch((e) => logError('prewarmAudio', e));
  }, []);
  useEffect(() => { prewarmAudio(); }, [prewarmAudio]);

  // Latest values the (once-created) PanResponder closures read from.
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const deviceRef = useRef(device);
  deviceRef.current = device;

  // Pinch-to-zoom gesture surface. Deliberately claims ONLY when a second
  // finger is down — a single-finger horizontal drag is left for the tab pager
  // (react-native-pager-view) so the swipe-to-Chats gesture tracks the finger.
  // (Camera flip is the FLIP button; a 1-finger double-tap would fight the
  // pager swipe, so it was removed.)
  const gesture = useRef({ startDist: 0, startZoom: 1 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (e) => e.nativeEvent.touches.length === 2,
      onPanResponderMove: (e) => {
        const touches = e.nativeEvent.touches;
        if (touches.length !== 2) return;
        const dev = deviceRef.current;
        if (!dev) return;
        // Establish the pinch baseline once the second finger is down.
        if (!gesture.current.startDist) {
          gesture.current.startDist = touchDist(touches);
          gesture.current.startZoom = zoomRef.current;
          return;
        }
        const ratio = touchDist(touches) / gesture.current.startDist;
        setZoom(clamp(gesture.current.startZoom * ratio, dev.minZoom, dev.maxZoom));
      },
      onPanResponderRelease: () => { gesture.current.startDist = 0; },
      onPanResponderTerminate: () => { gesture.current.startDist = 0; },
    }),
  ).current;

  const takePhoto = useCallback(async () => {
    if (!camera.current) return;
    const photo = await camera.current.takePhoto({ flash });
    // VisionCamera returns a file:// URL on iOS; the rest of the pipeline (preview,
    // resizeImage, uploadAttachment) and the bridge contract expect a plain path.
    const path = photo.path.replace(/^file:\/\//, '');
    nav.navigate('PhotoPreview', {
      photo: { path, width: photo.width, height: photo.height },
      mediaType: 'photo',
    });
  }, [flash, nav]);

  // ─── Video: hold the shutter to record for as long as it's held ───────────
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecord = useRef(false);

  // Simple shutter-button press feedback: scale down on touch, spring back on
  // release. Native-driver so it's instant (<16ms) even while the ~440ms photo
  // capture runs on the JS/native bridge — the button acknowledges the tap
  // immediately instead of feeling unresponsive until the capture completes.
  const shutterScale = useRef(new Animated.Value(1)).current;
  const animateShutter = useCallback((to: number) => {
    Animated.spring(shutterScale, {
      toValue: to, useNativeDriver: true, speed: 40, bounciness: 6,
    }).start();
  }, [shutterScale]);

  const startRecording = useCallback(() => {
    if (!camera.current) return;
    setRecording(true);
    camera.current.startRecording({
      // h264 for universal cross-platform playback (iOS defaults to HEVC, which
      // isn't as reliably decodable on Android). videoBitRate="low" on <Camera>
      // keeps the file small since we don't transcode.
      videoCodec: 'h264',
      onRecordingFinished: (video) => {
        setRecording(false);
        prewarmAudio(); // re-warm for the next record (VisionCamera just deactivated)
        const path = video.path.replace(/^file:\/\//, '');
        nav.navigate('PhotoPreview', {
          photo: { path, width: 0, height: 0 },
          mediaType: 'video',
        });
      },
      onRecordingError: (e) => { setRecording(false); prewarmAudio(); logError('record', e); },
    });
  }, [nav, prewarmAudio]);

  const stopRecording = useCallback(async () => {
    try { await camera.current?.stopRecording(); } catch (e) { logError('stopRecording', e); }
  }, []);

  // Press-in arms a hold timer; if held past the threshold we record, otherwise
  // the release fires a normal photo. Release always ends a recording.
  const onShutterPressIn = () => {
    animateShutter(0.88);
    didRecord.current = false;
    holdTimer.current = setTimeout(() => { didRecord.current = true; startRecording(); }, HOLD_TO_RECORD_MS);
  };
  const onShutterPressOut = () => {
    animateShutter(1);
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (didRecord.current) stopRecording();
    else takePhoto();
  };

  const flipCamera = () => {
    setFacing(f => f === 'back' ? 'front' : 'back');
    setZoom(1);
  };
  const toggleFlash = () => setFlash(f => f === 'off' ? 'on' : 'off');

  // Emulator fallback — native side synthesizes a JPEG so the rest of the
  // capture pipeline (resize / upload) sees the same shape as a real photo.
  const takeTestPhoto = useCallback(async () => {
    const img = await Obscura.writeTestImage(100, 100);
    nav.navigate('PhotoPreview', {
      photo: { path: img.path, width: img.width, height: img.height },
    });
  }, [nav]);

  // Permission not granted yet
  if (!hasPermission) {
    return (
      <View style={cs.permissionContainer}>
        <Text style={cs.permissionText}>Camera access needed</Text>
        <TouchableOpacity style={cs.permissionBtn} onPress={requestPermission}>
          <Text style={cs.permissionBtnText}>Grant access</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => Linking.openSettings()}>
          <Text style={cs.settingsLink}>Open settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // No device available (emulator without camera)
  if (!device) {
    return (
      <View style={cs.permissionContainer}>
        <Text style={cs.permissionText}>No camera available</Text>
        <Text style={cs.hint}>Simulator mode — tap to use test photo</Text>
        <TouchableOpacity style={cs.permissionBtn} onPress={takeTestPhoto}>
          <Text style={cs.permissionBtnText}>Use test photo</Text>
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
        format={format}
        isActive={cameraActive}
        photo={true}
        video={true}
        audio={hasMic}
        fps={30}
        videoBitRate="low"
        photoQualityBalance="speed"
        zoom={zoom}
      />

      {/* Pinch-zoom gesture surface. Claims only on a 2-finger move, so a
          single-finger horizontal drag falls through to the tab pager for the
          swipe-to-Chats transition. Below the controls overlay (box-none). */}
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />

      {/* Controls overlay. Top/bottom are padded clear of the transparent
          header + tab bar that float over the full-bleed camera. */}
      <View style={cs.overlay} pointerEvents="box-none">
        {/* Top controls */}
        <View style={[cs.topControls, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity style={cs.iconBtn} onPress={toggleFlash} accessibilityLabel="Toggle flash">
            <FlashIcon size={24} color={flash === 'on' ? colors.accent : '#fff'} on={flash === 'on'} />
          </TouchableOpacity>
        </View>

        {/* Bottom controls. Shutter is centered (grounded); flip sits to its
            right as an icon. Kept close to the tab bar so it doesn't float. */}
        <View style={[cs.bottomControls, { paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }]}>
          <View style={cs.controlsRow}>
            <Animated.View style={{ transform: [{ scale: shutterScale }] }}>
              <Pressable
                onPressIn={onShutterPressIn}
                onPressOut={onShutterPressOut}
                style={[cs.captureBtn, recording && cs.captureBtnActive]}
                accessibilityLabel="Capture"
              >
                <View style={[cs.captureBtnInner, recording && cs.captureBtnInnerActive]} />
              </Pressable>
            </Animated.View>

            <TouchableOpacity style={cs.flipBtn} onPress={flipCamera} accessibilityLabel="Flip camera">
              <FlipCameraIcon size={30} color="#fff" />
            </TouchableOpacity>
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
  // Shutter centered so it reads as the anchor; flip floats to its right.
  controlsRow: { alignItems: 'center', justifyContent: 'center' },
  flipBtn: {
    position: 'absolute', right: 8, width: 52, height: 52,
    borderRadius: 26, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  iconBtn: { padding: 10 },
  captureBtn: {
    width: 84, height: 84, borderRadius: 42, borderWidth: 5,
    borderColor: '#fff', justifyContent: 'center', alignItems: 'center',
  },
  captureBtnActive: { borderColor: '#ff3b30' },
  captureBtnInner: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#fff' },
  captureBtnInnerActive: { width: 34, height: 34, borderRadius: 8, backgroundColor: '#ff3b30' },
  permissionContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 32 },
  permissionText: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 16 },
  permissionBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginBottom: 12 },
  permissionBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  settingsLink: { color: colors.accent, fontSize: 14 },
  hint: { color: '#666', fontSize: 14, marginTop: 8 },
});
