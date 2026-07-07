import React from 'react';
import Svg, { Path, Circle, Line } from 'react-native-svg';

/**
 * Line-style icons (Feather-ish), tinted via `color` and scaled via `size`.
 * Match the app's hand-rolled SVG convention (see AddFriendIcon). Used for the
 * camera controls and the bottom tab bar so we stop shipping text where every
 * camera app uses glyphs.
 */

type IconProps = { size?: number; color?: string; strokeWidth?: number };

export function CameraIcon({ size = 26, color = '#fff', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
        stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      />
      <Circle cx="12" cy="13" r="4" stroke={color} strokeWidth={strokeWidth} />
    </Svg>
  );
}

export function ChatIcon({ size = 26, color = '#fff', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"
        stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      />
    </Svg>
  );
}

/** Lightning bolt. Filled when `on`, outline otherwise, with a slash when off. */
export function FlashIcon({ size = 24, color = '#fff', strokeWidth = 2, on = false }: IconProps & { on?: boolean }) {
  const bolt = 'M13 2 L4 14 h6 l-1 8 l9 -12 h-6 z';
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d={bolt}
        stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round"
        fill={on ? color : 'none'}
      />
      {!on && (
        <Line x1="3" y1="3" x2="21" y2="21" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      )}
    </Svg>
  );
}

/** Camera flip — two arrows chasing each other in a circle (rotate). */
export function FlipCameraIcon({ size = 26, color = '#fff', strokeWidth = 2 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M23 4v6h-6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M1 20v-6h6" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <Path
        d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
        stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      />
    </Svg>
  );
}
