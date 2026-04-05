import { NativeModules, NativeEventEmitter } from 'react-native';

/** Single shared NativeEventEmitter — works when bridge is compiled and linked. */
export const ObscuraEvents = new NativeEventEmitter(NativeModules.ObscuraBridge);
