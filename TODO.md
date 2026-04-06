# Tech Debt & Best Practices

Ordered by impact. Check off as completed.

## High Priority

- [ ] **React Navigation** — Replace `useState<string>('main')` screen machine with `@react-navigation/native`. Gives proper back stack, gesture navigation, screen transitions, deep linking, and auto-unmount of offscreen screens. Current screens stay mounted in memory.

- [ ] **Base64 → file URI for images** — `data:image/jpeg;base64,...` in `<Image>` keeps the entire image as a string in JS thread memory. Write downloaded attachments to a temp file via RNFS, use `file://` URI. Or use `react-native-fast-image` with disk caching. Affects story viewer, pix viewer, chat photos.

- [ ] **Shared state (Context or Zustand)** — All state lives in App.tsx and gets prop-drilled 3-4 levels. `friends`, `pending`, `connState`, `myUsername`, `myUserId` all passed as props. Use React Context or Zustand for a lightweight store. Eliminates `refreshTrigger` hack — deletion reactively updates all consumers.

- [ ] **useMemo on computed lists** — `ChatListScreen` rebuilds the `activities` array on every render even when inputs haven't changed. Wrap in `useMemo(fn, [friends, messages, pixEntries])`. Same for story grouping in `StoriesScreen`.

## Medium Priority

- [ ] **FlatList optimization** — Add `getItemLayout` for fixed-height rows, `maxToRenderPerBatch`, `windowSize` tuning, and `React.memo` on `renderItem` components. Matters when message/friend counts grow.

- [ ] **Error boundaries** — One bad render crashes the whole app. Wrap each screen in an `ErrorBoundary` that shows a fallback UI with retry. React Native doesn't have built-in error boundaries — use `react-native-error-boundary` or a custom class component.

- [ ] **TypeScript strictness** — Remove `as any` casts. Type the event discriminated union properly so `event.type === 'friendsUpdated'` narrows the type. Add `strict: true` to tsconfig if not already set.

- [ ] **Keyboard handling everywhere** — Only ChatScreen has `KeyboardAvoidingView`. Friend code input, story post, profile edit all get covered by keyboard on small screens. Wrap all input-containing screens.

## Low Priority

- [ ] **Loading/skeleton states** — Screens flash empty then populate. Show skeleton placeholders (gray boxes) while data loads. Especially for chat list and stories.

- [ ] **Consistent style pattern** — Some screens use `s.` from shared `styles.ts`, others define local `StyleSheet.create` with different prefixes (`cl.`, `sv.`, `cs.`, `ps.`, `rp.`). Pick one convention: shared styles for reusable patterns, local for screen-specific.

- [ ] **Image resizing pipeline** — `react-native-image-resizer` is imported dynamically with try/catch fallback. Should be a proper import with the native module linked on both platforms. Resize all photos to 1080px max before upload.

- [ ] **Temp file cleanup** — Camera photos, resized images, downloaded attachments create temp files. Only camera cleanup exists (`RNFS.unlink` in finally block). Need a periodic sweep or cleanup on app launch.

## Architecture Notes

These aren't bugs — just patterns to keep in mind as the app grows:

- **Navigation library** is the single biggest improvement. Every screen-level bug (back button, state leaks, keyboard, transitions) gets fixed for free.
- **Shared state** is the second biggest. Every prop-drilling bug and refresh hack goes away.
- **Image pipeline** (resize → upload → cache → file URI display) should be one utility, not spread across App.tsx, CameraScreen, StoriesScreen, and the bridge.
