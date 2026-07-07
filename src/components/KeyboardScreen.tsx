import React from 'react';
import {
  KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard, Platform,
  View, StyleSheet, type ViewStyle,
} from 'react-native';

/**
 * Wrapper for plain-View input screens (no ScrollView/FlatList of their own).
 *
 * - Lifts content above the keyboard: `padding` on iOS, `height` on Android.
 *   (Android 15+ enforces edge-to-edge even with edgeToEdgeEnabled=false, so the
 *   manifest's `adjustResize` no longer resizes the window for the IME — the
 *   KeyboardAvoidingView must do it. `height` mirrors ChatScreen/PhotoPreview.)
 * - Tapping any non-input area dismisses the keyboard.
 *
 * Scroll/list screens should NOT use this — a TouchableWithoutFeedback around a
 * ScrollView/FlatList eats scroll gestures. Those use
 * `keyboardShouldPersistTaps="handled"` (+ `keyboardDismissMode="on-drag"`) on
 * the scrollable itself instead.
 */
export function KeyboardScreen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return (
    <KeyboardAvoidingView
      style={[styles.flex, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
        <View style={styles.flex}>{children}</View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
