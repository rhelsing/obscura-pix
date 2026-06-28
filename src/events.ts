import { NativeModules, NativeEventEmitter, type EmitterSubscription } from 'react-native';

/**
 * Single shared NativeEventEmitter for all Obscura native -> JS events.
 *
 * Safe to import when the native module isn't present (e.g. under jest):
 * we return a no-op stub that lets `.addListener(...).remove()` work without
 * touching the missing native module.
 */
type ObscuraEmitter = { addListener: (name: string, handler: (e: any) => void) => EmitterSubscription };

function makeEmitter(): ObscuraEmitter {
  const native = NativeModules.ObscuraBridge;
  if (native) return new NativeEventEmitter(native);
  return {
    addListener: (_n, _h) => ({ remove: () => {} } as EmitterSubscription),
  };
}

export const ObscuraEvents: ObscuraEmitter = makeEmitter();
