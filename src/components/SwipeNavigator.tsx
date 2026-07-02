import React, { useRef } from 'react';
import { View, PanResponder, StyleSheet, type ViewStyle } from 'react-native';

// Tuning. A gesture is only claimed as a tab-swipe when it's clearly
// horizontal — otherwise vertical scroll (chat list) and vertical drag
// (camera zoom) must keep the touch.
const H_DOMINANCE = 1.5; // |dx| must beat |dy| by this factor
const CLAIM_DX = 45;     // px of horizontal travel before we claim the gesture
const CLAIM_VX = 0.5;    // ...or this horizontal velocity (fast flick)
const FIRE_DX = 30;      // release past this → navigate
const FIRE_VX = 0.3;     // ...or release with at least this velocity

/**
 * Wraps a tab screen so a clear left/right swipe triggers navigation to the
 * sibling tab.
 *
 * Uses the CAPTURE phase (`on*Capture`) so it can intercept a horizontal swipe
 * from children that own the touch — the Camera screen's zoom PanResponder and
 * the chat list's vertical scroll — but *only* once the gesture is horizontally
 * dominant. Vertical gestures never cross the threshold, so scroll and zoom are
 * untouched. The actual tab transition is supplied by the navigator's
 * `animation: 'shift'` option; this component just fires the navigate.
 */
export function SwipeNavigator({
  onSwipeLeft,
  onSwipeRight,
  children,
  style,
}: {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  // Latest callbacks, read without recreating the responder each render.
  const cbs = useRef({ onSwipeLeft, onSwipeRight });
  cbs.current = { onSwipeLeft, onSwipeRight };

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => {
        const horizontal = Math.abs(g.dx) > Math.abs(g.dy) * H_DOMINANCE;
        return horizontal && (Math.abs(g.dx) > CLAIM_DX || Math.abs(g.vx) > CLAIM_VX);
      },
      // Once we've claimed a horizontal swipe, don't let a child yank it back.
      onPanResponderTerminationRequest: () => false,
      onPanResponderRelease: (_e, g) => {
        if (g.dx <= -FIRE_DX || g.vx <= -FIRE_VX) cbs.current.onSwipeLeft?.();
        else if (g.dx >= FIRE_DX || g.vx >= FIRE_VX) cbs.current.onSwipeRight?.();
      },
    }),
  ).current;

  return (
    <View style={[styles.flex, style]} collapsable={false} {...pan.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
