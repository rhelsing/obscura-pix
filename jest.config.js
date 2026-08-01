/**
 * Node-side test suite: the app's domain layer and the bridge boundary.
 *
 * `src/domain` is the pure logic being moved out of the kits (obscura-proto/KIT_API.md §8.2) — no
 * React Native imports, no mocks needed. `src/native` is the bridge wrapper and `src/state` the
 * effects that drive it, both tested against the in-memory kit double
 * (`src/native/__fixtures__/FakeObscuraBridge.ts`) that `jest.setup.ts` installs in place of the
 * real native module. All run in ~1s, which is what makes them worth running on every PR.
 *
 * Still absent, and deliberately: anything that RENDERS. Covering a component needs a React
 * renderer (`react-test-renderer` or `@testing-library/react-native`) that this repo does not yet
 * depend on. That is a dependency decision, and it belongs in its own change with its own jest
 * project entry — not smuggled in with the double.
 *
 * What that does NOT excuse, and used to: `store.ts`'s drain triggers. They lived inside the
 * `ObscuraBootstrap` hook, so the renderer gap was also swallowing the single write path and every
 * one of the four triggers that decide whether a message is ever seen — 17% covered, 0% branch, with
 * two live defects in it. The event switch and the cold-start pull are now plain exported functions
 * the hook merely subscribes and calls (`applyObscuraEvent`, `loadSession`), covered by
 * `src/state/__tests__/store.test.ts`. Only the hook wiring itself still needs a renderer.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  roots: ['<rootDir>/src/domain', '<rootDir>/src/native', '<rootDir>/src/state'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};
