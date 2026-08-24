import { Obscura } from '../native/ObscuraModule';

export async function requestStartupPermissions(): Promise<void> {
  const { Camera } = await import('react-native-vision-camera');

  const camera = Camera.getCameraPermissionStatus();
  if (camera === 'not-determined') {
    await Camera.requestCameraPermission();
  }

  const microphone = Camera.getMicrophonePermissionStatus();
  if (microphone === 'not-determined') {
    await Camera.requestMicrophonePermission();
  }

  await Obscura.requestPushPermission();
}
