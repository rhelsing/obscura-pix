import React, { useRef, useState, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet, Linking, PanResponder } from 'react-native';
import {
  Camera, useCameraDevice, useCameraPermission, useCameraFormat, useMicrophonePermission,
} from 'react-native-vision-camera';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { SwipeNavigator } from '../components/SwipeNavigator';
import { Obscura } from '../native/ObscuraModule';
import { logError } from '../utils/log';
import type { RootStackParamList } from '../navigation/types';
import { colors } from '../styles';

// Quick tap vs press-and-hold threshold for the shutter (ms).
const HOLD_TO_RECORD_MS = 220;

const DOUBLE_TAP_MS = 300;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const touchDist = (touches: { pageX: number; pageY: number }[]) =>
  Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);

export function CameraScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { hasPermission, requestPermission } = useCameraPermission();
  const { hasPermission: hasMic, requestPermission: requestMic } = useMicrophonePermission();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [flash, setFlash] = useState<'off' | 'on'>('off');
  const [zoom, setZoom] = useState(1);
  const [recording, setRecording] = useState(false);
  const camera = useRef<Camera>(null);
  const device = useCameraDevice(facing);

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

  // Single gesture surface for pinch-zoom + double-tap-flip. Owning both in one
  // PanResponder avoids the pinch-vs-tap fight you'd get layering a JS tap
  // catcher over VisionCamera's built-in enableZoomGesture.
  const gesture = useRef({ lastTap: 0, startDist: 0, startZoom: 1, moved: false, lastLoggedZoom: 1 });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        gesture.current.moved = false;
        gesture.current.startDist = 0;
      },
      onPanResponderMove: (e) => {
        const touches = e.nativeEvent.touches;
        if (touches.length !== 2) return;
        gesture.current.moved = true;
        const dev = deviceRef.current;
        if (!dev) return;
        // Establish the pinch baseline once the second finger is down.
        if (!gesture.current.startDist) {
          gesture.current.startDist = touchDist(touches);
          gesture.current.startZoom = zoomRef.current;
          return;
        }
        const ratio = touchDist(touches) / gesture.current.startDist;
        const next = clamp(gesture.current.startZoom * ratio, dev.minZoom, dev.maxZoom);
        setZoom(next);
        // [DEBUG #2] deduped zoom log — remove after tuning
        const r = Math.round(next * 10) / 10;
        if (r !== gesture.current.lastLoggedZoom) {
          gesture.current.lastLoggedZoom = r;
          console.log(`[zoom] ${r}x (min ${dev.minZoom} max ${dev.maxZoom})`);
        }
      },
      onPanResponderRelease: () => {
        gesture.current.startDist = 0;
        if (gesture.current.moved) return; // pinch/drag, not a tap
        const now = Date.now();
        if (now - gesture.current.lastTap < DOUBLE_TAP_MS) {
          gesture.current.lastTap = 0;
          console.log('[flip] via double-tap'); // [DEBUG #4] remove after verifying
          setFacing(f => (f === 'back' ? 'front' : 'back'));
          setZoom(1);
        } else {
          gesture.current.lastTap = now;
        }
      },
    }),
  ).current;

  const takePhoto = useCallback(async () => {
    if (!camera.current) return;
    // [DEBUG #5] capture timing — remove after diagnosing lag
    const t0 = Date.now();
    console.log('[capture] takePhoto start');
    const photo = await camera.current.takePhoto({ flash });
    console.log(`[capture] takePhoto returned +${Date.now() - t0}ms (${photo.width}x${photo.height})`);
    // VisionCamera returns a file:// URL on iOS; the rest of the pipeline (preview,
    // resizeImage, uploadAttachment) and the bridge contract expect a plain path.
    const path = photo.path.replace(/^file:\/\//, '');
    console.log(`[capture] navigating to preview +${Date.now() - t0}ms`);
    nav.navigate('PhotoPreview', {
      photo: { path, width: photo.width, height: photo.height },
      mediaType: 'photo',
    });
  }, [flash, nav]);

  // ─── Video: hold the shutter to record for as long as it's held ───────────
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didRecord = useRef(false);

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
    didRecord.current = false;
    holdTimer.current = setTimeout(() => { didRecord.current = true; startRecording(); }, HOLD_TO_RECORD_MS);
  };
  const onShutterPressOut = () => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (didRecord.current) stopRecording();
    else takePhoto();
  };

  const flipCamera = () => {
    console.log('[flip] via button'); // [DEBUG #4] remove after verifying
    setFacing(f => f === 'back' ? 'front' : 'back');
    setZoom(1);
  };
  const toggleFlash = () => setFlash(f => f === 'off' ? 'on' : 'off');

  // [DEBUG #2/#4] confirms the flip actually landed — remove after verifying
  useEffect(() => { console.log(`[camera] facing=${facing}`); }, [facing]);

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
    <SwipeNavigator
      style={cs.container}
      // Camera is the right-hand tab; swipe right reveals Chats on the left.
      onSwipeRight={() => nav.navigate('MainTabs', { screen: 'Chats' })}
    >
      <Camera
        ref={camera}
        style={StyleSheet.absoluteFill}
        device={device}
        format={format}
        isActive={true}
        photo={true}
        video={true}
        audio={hasMic}
        fps={30}
        videoBitRate="low"
        photoQualityBalance="speed"
        zoom={zoom}
      />

      {/* Gesture surface: pinch-zoom + double-tap-flip. Sits above the preview
          but below the controls overlay (which is box-none so empty areas fall
          through to here while the buttons keep working). */}
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers} />

      {/* Controls overlay. Top/bottom are padded clear of the transparent
          header + tab bar that now float over the full-bleed camera. */}
      <View style={cs.overlay} pointerEvents="box-none">
        {/* Top controls */}
        <View style={[cs.topControls, { paddingTop: insets.top + 8 }]}>
          <TouchableOpacity style={cs.iconBtn} onPress={toggleFlash}>
            <Text style={cs.iconText}>{flash === 'on' ? 'FLASH ON' : 'FLASH'}</Text>
          </TouchableOpacity>
        </View>

        {/* Bottom controls */}
        <View style={[cs.bottomControls, { paddingBottom: tabBarHeight + 20 }]}>
          <View style={cs.controlsRow}>
            <TouchableOpacity style={cs.sideBtn} onPress={flipCamera}>
              <Text style={cs.sideBtnText}>FLIP</Text>
            </TouchableOpacity>

            <Pressable
              onPressIn={onShutterPressIn}
              onPressOut={onShutterPressOut}
              style={[cs.captureBtn, recording && cs.captureBtnActive]}
            >
              <View style={[cs.captureBtnInner, recording && cs.captureBtnInnerActive]} />
            </Pressable>

            <View style={cs.sideBtn} />
          </View>
        </View>
      </View>
    </SwipeNavigator>
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
  captureBtnActive: { borderColor: '#ff3b30' },
  captureBtnInner: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#fff' },
  captureBtnInnerActive: { width: 34, height: 34, borderRadius: 8, backgroundColor: '#ff3b30' },
  permissionContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center', padding: 32 },
  permissionText: { color: '#fff', fontSize: 18, fontWeight: '600', marginBottom: 16 },
  permissionBtn: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 12, marginBottom: 12 },
  permissionBtnText: { color: '#000', fontWeight: '700', fontSize: 16 },
  settingsLink: { color: colors.accent, fontSize: 14 },
  hint: { color: '#666', fontSize: 14, marginTop: 8 },
});
