import React from 'react';
import {
  KeyboardAvoidingView, TouchableWithoutFeedback, Keyboard, Platform,
  View, StyleSheet, type ViewStyle,
} from 'react-native';

/**
 * Wrapper for plain-View input screens (no ScrollView/FlatList of their own).
 *
 * - Slides content above the keyboard: `padding` on iOS; Android relies on the
 *   manifest's `adjustResize`, so `behavior` is left undefined there.
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
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <TouchableWithoutFeedback accessible={false} onPress={Keyboard.dismiss}>
        <View style={styles.flex}>{children}</View>
      </TouchableWithoutFeedback>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
