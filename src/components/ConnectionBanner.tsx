import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSession } from '../state/store';
import { colors } from '../styles';

/**
 * Global connection indicator. Mounted once at the app root (like ToastHost).
 *
 * Renders nothing while connected. When the session is authenticated but the
 * socket stays down for more than a short grace period, it slides down a thin
 * pill under the header so the user knows why nothing is syncing.
 *
 * Two deliberate anti-jank choices:
 *   • Grace period — a not-connected state must persist for [GRACE_MS] before the
 *     pill appears. This swallows the normal cold-start blip (the socket often
 *     connects in well under a second, and at launch the store briefly still
 *     holds its default 'disconnected') and fast reconnects, so the pill doesn't
 *     flash on every launch.
 *   • Single stable label — once shown, the client is in a sustained outage and
 *     the gateway is looping disconnected/reconnecting/connecting on backoff.
 *     Showing one calm "reconnecting…" avoids the text flip-flopping through
 *     three states. The precise 4-state value is still on the Profile screen.
 */

const GRACE_MS = 1200;

export function ConnectionBanner() {
  const insets = useSafeAreaInsets();
  const { authed, connState } = useSession();

  const notConnected = authed && connState !== 'connected';

  // Debounce reveal: only show after `notConnected` has held for GRACE_MS; hide
  // immediately once connected (or logged out). Because the effect only re-runs
  // when `notConnected` flips, transitions *between* not-connected substates
  // don't reset the timer or change what's shown.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!notConnected) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [notConnected]);

  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: shown ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [shown, anim]);

  // Keep mounted (so exit animates) but skip layout/touch cost when fully hidden.
  return (
    <View pointerEvents="none" style={[styles.host, { top: insets.top + 52 }]}>
      <Animated.View
        style={[
          styles.pill,
          {
            opacity: anim,
            transform: [
              { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) },
            ],
          },
        ]}
      >
        <View style={[styles.dot, { backgroundColor: colors.connecting }]} />
        <Text style={styles.label}>Reconnecting…</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 100,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  label: { color: colors.text, fontSize: 13, fontWeight: '600' },
});
