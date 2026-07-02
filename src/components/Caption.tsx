import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { logError } from '../utils/log';

/**
 * Shared caption model + renderer. Single source of truth so the composer
 * (PhotoPreviewScreen) and the viewer (StoriesScreen) can never drift.
 *
 * The caption travels as a JSON blob in the entry's `captionMeta` string field
 * (see schema.ts). The plain text stays in `caption` for push/preview. Nothing
 * about this touches the native bridge — createEntry stores the JSON opaquely,
 * identically on iOS and Android.
 */

// ─── Fonts ───────────────────────────────────────────────
// Mapped to real SYSTEM fonts per platform — no bundling, no .ttf files. The
// two platforms don't share font names (and neither ships Comic Sans), so each
// slot picks the closest native equivalent on each OS; they look a little
// different per-platform but are always available. The caption blob stores the
// font INDEX, so the wire format stays platform-independent — we resolve
// index → the right family per platform here at render time.
interface FontDef { label: string; ios: string; android: string }

const FONT_DEFS: FontDef[] = [
  { label: 'Clean',  ios: 'System',          android: 'sans-serif' }, // 0 — default sans (SF / Roboto)
  { label: 'Comic',  ios: 'Chalkboard SE',   android: 'casual' },     // 1 — casual (Chalkboard / Coming Soon)
  { label: 'Serif',  ios: 'Georgia',         android: 'serif' },      // 2 — serif (Georgia / Noto Serif)
  { label: 'Script', ios: 'Snell Roundhand', android: 'cursive' },    // 3 — script (Snell / Dancing Script)
  { label: 'Mono',   ios: 'Menlo',           android: 'monospace' },  // 4 — mono (Menlo / Droid mono)
];

/** Resolved fontFamily string per platform, indexed the same as the blob's `font`. */
export const CAPTION_FONTS = FONT_DEFS.map(
  f => Platform.select({ ios: f.ios, android: f.android, default: f.ios }) as string,
);

/** Short labels for the font-cycle UI, same index order. */
export const CAPTION_FONT_LABELS = FONT_DEFS.map(f => f.label);

// Color swatches offered for the bold style.
export const CAPTION_COLORS = [
  '#ffffff', '#000000', '#ff2d55', '#ffcc00', '#34c759', '#0a84ff', '#af52de',
];

// ─── Model ───────────────────────────────────────────────

export type CaptionStyle = 'bar' | 'bold';

export interface CaptionMeta {
  style: CaptionStyle;
  /**
   * Normalized 0..1 vertical position.
   * - bar:  top edge of the full-width bar
   * - bold: center of the text
   */
  y: number;
  /** Normalized 0..1 horizontal center. Bold only (bar is always full width). */
  x?: number;
  /** Rotation in radians. Bold only. */
  rot?: number;
  /** Uniform scale factor (pinch-to-resize). Bold only. Default 1. */
  scale?: number;
  /** Text color. Bold only. */
  color?: string;
  /** Index into CAPTION_FONTS. Bold only. */
  font?: number;
}

export const DEFAULT_BAR: CaptionMeta = { style: 'bar', y: 0.72 };
export const DEFAULT_BOLD: CaptionMeta = {
  style: 'bold', x: 0.5, y: 0.5, rot: 0, scale: 1, color: '#ffffff', font: 0,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function parseCaptionMeta(raw?: string | null): CaptionMeta | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (m && (m.style === 'bar' || m.style === 'bold') && typeof m.y === 'number') return m;
  } catch (e) {
    logError('caption.parse', e); // malformed blob — fall back to plain caption
  }
  return null;
}

export function serializeCaptionMeta(meta: CaptionMeta): string {
  return JSON.stringify(meta);
}

// ─── Shared visuals ──────────────────────────────────────
// Exported so the composer's interactive/Animated version renders pixel-identical
// to the static viewer version below.
export const captionStyles = StyleSheet.create({
  barWrap: {
    left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingVertical: 10, paddingHorizontal: 16,
  },
  barText: {
    color: '#fff', fontSize: 20, fontWeight: '600', textAlign: 'center',
  },
  boldText: {
    fontSize: 34, fontWeight: '900', textAlign: 'center',
    // Vertical-centering the glyph inside its own box so it lands exactly where
    // it's dragged. iOS: an explicit lineHeight makes iOS center the glyph in
    // the line box (without it, the ascender-heavy metrics push text high).
    // Android: includeFontPadding/textAlignVertical do the same job there.
    lineHeight: 40, includeFontPadding: false, textAlignVertical: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4,
  },
});

/** Text style for the bold caption given its meta (font + color). */
export function boldTextStyle(meta: CaptionMeta) {
  return [
    captionStyles.boldText,
    { fontFamily: CAPTION_FONTS[meta.font ?? 0], color: meta.color ?? '#fff' },
  ];
}

// ─── Static renderer (viewer) ────────────────────────────

/**
 * Read-only caption for the viewer. `width`/`height` are the container size the
 * normalized coords map into (the full-screen media area).
 */
export function CaptionView(
  { meta, text, width, height }: { meta: CaptionMeta; text: string; width: number; height: number },
) {
  if (!text) return null;

  if (meta.style === 'bar') {
    return (
      <View
        pointerEvents="none"
        style={[captionStyles.barWrap, { position: 'absolute', top: clamp01(meta.y) * height }]}
      >
        <Text style={captionStyles.barText}>{text}</Text>
      </View>
    );
  }

  // bold — centered in the container, then translated to (x,y) and rotated
  // about its own center (RN transform-origin is center).
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
      <Text
        style={[
          boldTextStyle(meta),
          {
            transform: [
              { translateX: ((meta.x ?? 0.5) - 0.5) * width },
              { translateY: (clamp01(meta.y) - 0.5) * height },
              { rotate: `${meta.rot ?? 0}rad` },
              { scale: meta.scale ?? 1 },
            ],
          },
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
