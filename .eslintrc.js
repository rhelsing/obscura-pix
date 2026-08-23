module.exports = {
  root: true,
  extends: '@react-native',
  // The native submodule has its own language-specific gates. Its generated build output and
  // vendored dependencies must not become inputs to the app's JavaScript lint.
  ignorePatterns: ['obscura-native/**'],
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
