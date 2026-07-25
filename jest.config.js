/**
 * Pure-logic test suite for the app's domain layer.
 *
 * Scoped to `src/domain` on purpose: that is where the logic being moved out of the kits lands
 * (obscura-proto/KIT_API.md §8.2), and it has no React Native imports, so these tests need no
 * native mocks, no simulator and no device. They run in ~1s, which is what makes them worth running
 * on every PR. Component/screen tests, when they exist, will need the RN preset and belong in a
 * separate project entry.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  roots: ['<rootDir>/src/domain'],
  testMatch: ['**/__tests__/**/*.test.ts'],
};
