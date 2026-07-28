/**
 * Node-side test suite: the app's domain layer and the bridge boundary.
 *
 * `src/domain` is the pure logic being moved out of the kits (obscura-proto/KIT_API.md §8.2) — no
 * React Native imports, no mocks needed. `src/native` is the bridge wrapper and `src/state` the
 * effects that drive it, both tested against the in-memory kit double
 * (`src/native/__fixtures__/FakeObscuraBridge.ts`) that `jest.setup.ts` installs in place of the
 * real native module. All run in ~1s, which is what makes them worth running on every PR.
 *
 * Still absent, and deliberately: anything that RENDERS. `src/state/store.ts`'s event handling
 * lives inside the `ObscuraBootstrap` hook, so covering it needs a React renderer
 * (`react-test-renderer` or `@testing-library/react-native`) that this repo does not yet depend on.
 * That is a dependency decision, and it belongs in its own change with its own jest project entry —
 * not smuggled in with the double. The double is the prerequisite for it either way.
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
