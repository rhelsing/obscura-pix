/**
 * The `react-native` module, as jest sees it.
 *
 * `ObscuraModule.ts` resolves its bridge at **import time**:
 *
 * ```ts
 * const ObscuraBridge = TurboModuleRegistry.get('ObscuraBridge') || NativeModules.ObscuraBridge || null;
 * const Bridge = ObscuraBridge || new Proxy({}, { get: () => noop });
 * ```
 *
 * So the way to give it a real bridge is to make `NativeModules.ObscuraBridge` exist — which means
 * mocking `react-native` itself rather than adding a test seam to production code. That choice
 * matters: it means the tests exercise **the real `ObscuraModule.ts`**, including its
 * `JSON.stringify` calls, its event-name string, and its `getEmitter()` null-check. A test seam
 * would have bypassed exactly the layer most likely to be wrong.
 *
 * `jest.setup.ts` installs this via `jest.mock('react-native', …)`, so every suite gets it without
 * per-file boilerplate.
 *
 * Only the surface pix's tested modules actually touch is implemented. When a test needs more of
 * React Native than this — anything that renders — that is the signal to add a real RN preset and a
 * renderer as a separate jest project, not to grow this file into a reimplementation of the
 * platform.
 */

import { FakeObscuraBridge } from './FakeObscuraBridge';

/**
 * One bridge instance for the whole module registry, mutated in place between tests.
 *
 * A singleton rather than a per-test instance because `ObscuraModule.ts` captures the reference at
 * import and caches a `NativeEventEmitter` built from it; a fresh instance per test would leave the
 * module talking to the previous one. `FakeObscuraBridge.__reset()` exists to make this safe.
 */
export const fakeBridge = new FakeObscuraBridge();

/** The fake the module under test is talking to. */
export function getFakeBridge(): FakeObscuraBridge {
  return fakeBridge;
}

export const NativeModules = {
  ObscuraBridge: fakeBridge,
};

export const TurboModuleRegistry = {
  get(name: string): unknown {
    return name === 'ObscuraBridge' ? fakeBridge : null;
  },
  getEnforcing(name: string): unknown {
    const m = TurboModuleRegistry.get(name);
    if (!m) throw new Error(`TurboModuleRegistry.getEnforcing(${name}): not found in the RN mock`);
    return m;
  },
};

/**
 * Minimal `NativeEventEmitter`.
 *
 * The real one requires the native module to expose `addListener` / `removeListeners`; the fake
 * bridge implements both, and this delegates to them, so the subscribe/unsubscribe path that
 * `onObscuraEvent` depends on is genuinely exercised rather than stubbed.
 */
export class NativeEventEmitter {
  constructor(private readonly nativeModule: FakeObscuraBridge) {}

  addListener(eventName: string, handler: (event: any) => void): { remove: () => void } {
    return this.nativeModule.addListener(eventName, handler);
  }
}

export const Platform = { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default };
