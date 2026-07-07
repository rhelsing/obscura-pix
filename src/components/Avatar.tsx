import React from 'react';
import { View, Text, StyleSheet, type ViewStyle } from 'react-native';
import { colors } from '../styles';

/**
 * Circular avatar showing the first letter of `name`. Single source of truth
 * for the initial-in-a-circle pattern used by the chat list, recipient picker,
 * story circles, and the header button. Font size derives from `size` so every
 * caller stays proportional.
 *
 * Callers that need a ring/badge wrap this; the avatar itself is just the disc.
 */
export function Avatar({
  name,
  size = 44,
  background = colors.accent,
  color = colors.onAccent,
  style,
}: {
  name?: string;
  size?: number;
  background?: string;
  color?: string;
  style?: ViewStyle;
}) {
  const initial = name?.[0]?.toUpperCase() || '?';
  const discStyle = { width: size, height: size, borderRadius: size / 2, backgroundColor: background };
  const textStyle = { color, fontSize: Math.round(size * 0.42) };
  return (
    <View style={[styles.base, discStyle, style]}>
      <Text style={[styles.initial, textStyle]}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { justifyContent: 'center', alignItems: 'center' },
  initial: { fontWeight: '700' },
});
