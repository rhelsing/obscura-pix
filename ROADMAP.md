# Roadmap

What's built, what's next.

## Done

- [x] Auth (register, login, session restore)
- [x] Friends (codes, add, accept, pending/accepted states)
- [x] Chat (encrypted messages, conversation-scoped)
- [x] Typing indicators (animated dots, cross-platform)
- [x] Stories (post, feed) — **but they do not expire**, see below
- [x] Profiles (display name, bio, synced to friends)
- [x] Encrypted attachments (upload, download, AES-GCM)
- [x] Device linking (QR/code approval flow)
- [x] Auto-reconnect (ping keepalive, exponential backoff)
- [x] Session persistence (kit-owned, survives app restart)
- [x] Debug log (in-app, Profile tab)
- [x] **Camera + send photo** — vision-camera + photo preview + recipient picker
- [x] **Ephemeral pix viewing** — view-once with display-duration timer + opened/delivered status
- [x] **Android push notifications** — FCM silent wakes, generic local notifications, and a
      broad chat-list destination on tap. iOS push remains in Phase 6.
- [x] **React Navigation** — native-stack + bottom tabs, real back stack
- [x] **Zustand state** — single store + useModelEntries hook, no prop-drilling
- [x] **The domain moves out of the kits** — merge, audience resolution and the inbox drain exist
      once, here, in TypeScript (`src/domain/`), with tests and a CI job

## Current gaps

- [ ] **24-hour story expiry.** Nothing expires on either platform.
- [ ] **Repeatable physical iOS ↔ Android release gate.** Foreground interop has
      been demonstrated manually; push, link approval, migration, and release
      signing are not automated.

## Phase 2: Ephemeral viewing polish

- [ ] 1x or 2x view option (sender chooses)
- [ ] Screenshot detection + notification to sender

## Phase 3: Rich Chat

- [ ] Send photos in chat (inline, not just Pix)
- [ ] Voice notes (record + send as encrypted attachment)
- [ ] Message disappears after viewed or 24h
- [ ] "Screenshotted" status in chat
- [ ] Read receipts (ephemeral signal — same pattern as typing)

## Phase 4: Stories V2

- [ ] Multiple snaps per story (swipeable)
- [ ] View count + who viewed
- [ ] Reply to story (opens chat with that friend)
- [ ] Close friends / custom audience for stories

## Phase 5: Streaks

- [ ] Daily snap exchange counter per friend
- [ ] Fire emoji + streak count display
- [ ] Streak expiry warning (approaching 24h without exchange)
- [ ] Streak reminders via push notification

## Phase 6: iOS

A working iOS foundation is committed under `ios/`: a RN 0.86 scaffold,
`ObscuraBridge.swift` implementing `docs/BRIDGE.md`, and
`obscura-native/swift` wired as a local SPM package. It builds in CI and has
completed a physical Android↔iOS foreground interoperability pass. The cross-platform bridge contract (methods, events,
payload shapes, atomicity / EXIF / OOM requirements) lives in `docs/BRIDGE.md`;
both bridges implement that contract. See `docs/IOS_PARITY.md` for detailed
status.

- [x] Scaffold `ios/` (RN 0.86, bundle `com.obscuraapp.ios`, deployment 16.0)
- [x] Implement `ObscuraBridge.swift` against `docs/BRIDGE.md`
- [x] Wire `obscura-native/swift` as a local Swift Package
- [x] App icons + launch screen assets
- [x] Simulator-verified auth flow end-to-end
- [x] Add a `macos-26` iOS CI job that builds the libsignal FFI and app
- [x] Physical Android↔iOS foreground interoperability pass
- [ ] Push (#11): APNs entitlement + FCM-via-APNs token wiring
- [ ] TestFlight/release-signing build

## Not Planned

- AR filters / lenses
- Drawing on photos
- Video calls
- Snap Map / location
- Memories / saved snaps
- Bitmoji
- Snap score
- Chat wallpapers
