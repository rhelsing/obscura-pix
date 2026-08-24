import { Obscura } from '../native/ObscuraModule';
import { Platform } from 'react-native';

export async function requestStartupPermissions(): Promise<void> {
  const { Camera } = await import('react-native-vision-camera');

  const camera = Camera.getCameraPermissionStatus();
  if (camera === 'not-determined' || (Platform.OS === 'android' && camera === 'denied')) {
    await Camera.requestCameraPermission();
  }

  const microphone = Camera.getMicrophonePermissionStatus();
  if (microphone === 'not-determined' || (Platform.OS === 'android' && microphone === 'denied')) {
    await Camera.requestMicrophonePermission();
  }

  await Obscura.requestPushPermission();
}
