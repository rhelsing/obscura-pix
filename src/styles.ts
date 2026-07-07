import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#000',
  surface: '#1a1a1a',
  surfaceMuted: '#333', // muted fills: pending avatars, disabled buttons, secondary borders
  accent: '#FFFC00',
  onAccent: '#000',     // text/icons on an accent (yellow) background
  text: '#fff',
  textSecondary: '#999', // list previews, secondary labels
  textDim: '#666',       // hints, timestamps, captions, placeholders
  textMuted: '#444',     // empty states, faint ids
  border: '#222',
  // Semantic status/feedback — one value each, shared by toasts, dots, and states.
  error: '#ef4444',
  success: '#22c55e',
  info: '#38bdf8',
  connected: '#22c55e',
  connecting: '#fbbf24',
  disconnected: '#ef4444',
};

/**
 * Genuinely cross-screen primitives only. Screen-specific styles live in a
 * local StyleSheet inside each screen. `container` is the full-bleed page and
 * `input` the standard text field — both used by Auth, Profile, and/or Chat.
 */
export const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  input: { backgroundColor: colors.surface, borderRadius: 12, padding: 14, color: colors.text, fontSize: 16, marginBottom: 12 },
});
