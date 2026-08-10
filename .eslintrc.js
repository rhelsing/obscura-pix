module.exports = {
  root: true,
  extends: '@react-native',
  // Generated build output inside the native submodule. Gradle emits JavaScript into its HTML test
  // reports, so a kit test run makes `npm run lint` start reporting on machine-written code that is
  // not ours and is not committed.
  ignorePatterns: ['obscura-native/**/build/'],
  rules: {
    // Ban silently-swallowed errors. Empty catches hid two real bugs
    // (pix view-once, camera file:// path). Route errors through
    // logError(tag, e) from src/utils/log.ts instead.
    'no-restricted-syntax': [
      'error',
      {
        selector: 'CatchClause > BlockStatement[body.length=0]',
        message:
          'Do not swallow errors with an empty catch — call logError(tag, e) (src/utils/log.ts) or handle it.',
      },
      {
        selector:
          "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression > BlockStatement[body.length=0]",
        message:
          'Do not swallow a promise rejection with .catch(() => {}) — call logError(tag, e) (src/utils/log.ts).',
      },
    ],
  },
};
