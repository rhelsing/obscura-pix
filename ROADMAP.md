# Roadmap

What's built, what's next.

## Done

- [x] Auth (register, login, session restore)
- [x] Friends (codes, add, accept, pending/accepted states)
- [x] Chat (encrypted messages, conversation-scoped)
- [x] Typing indicators (animated dots, cross-platform)
- [x] 24-hour stories (post, feed, TTL expiry)
- [x] Profiles (display name, bio, synced to friends)
- [x] Private settings (theme, notifications — never leaves device)
- [x] Encrypted attachments (upload, download, AES-GCM)
- [x] Device linking (QR/code approval flow)
- [x] Auto-reconnect (ping keepalive, exponential backoff)
- [x] Session persistence (kit-owned, survives app restart)
- [x] Debug log (in-app, Settings tab)
- [x] Cross-platform interop (iOS ↔ Android proven)
- [x] **Camera + send photo** — vision-camera + photo preview + recipient picker
- [x] **Ephemeral pix viewing** — view-once with display-duration timer + opened/delivered status
- [x] **Push notifications** — APNS + FCM, heads-up banners, deep-link to chat tab
- [x] **React Navigation** — native-stack + bottom tabs, real back stack
- [x] **Zustand state** — single store + useModelEntries hook, no prop-drilling

## Phase 2: Ephemeral viewing polish

- [ ] 1x or 2x view option (sender chooses)
- [ ] Screenshot detection + notification to sender

## Phase 3: Rich Chat

- [ ] Send photos in chat (inline, not just Pix)
- [ ] Voice notes (record + send as encrypted attachment)
- [ ] Message disappears after viewed or 24h
- [ ] "Screenshotted" status in chat
- [ ] Read receipts (ECS signal — same pattern as typing)

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
`ObscuraBridge.swift` implementing `docs/BRIDGE.md`, and the `ObscuraKit-swift`
Swift kit wired as a local SPM package. It builds, launches, and runs the auth
flow on the simulator. The cross-platform bridge contract (methods, events,
payload shapes, atomicity / EXIF / OOM requirements) lives in `docs/BRIDGE.md`;
Android's `ObscuraBridgeModule.kt` is the reference implementation. See
`docs/IOS_PARITY.md` for detailed status and the reproducible-build gap.

- [x] Scaffold `ios/` (RN 0.86, bundle `com.obscuraapp.ios`, deployment 16.0)
- [x] Implement `ObscuraBridge.swift` against `docs/BRIDGE.md`
- [x] Wire `ObscuraKit-swift` as a local Swift Package
- [x] App icons + launch screen assets
- [x] Simulator-verified auth flow end-to-end
- [ ] **Make the build reproducible** — repoint the SPM + libsignal paths from
      the machine-local `obscura-client-ios` to a sibling `ObscuraKit-swift`
      checkout (mirroring Android's `OBSCURA_KIT_PATH` composite build) and add a
      `macos-26` iOS CI job that builds the libsignal FFI (see `docs/IOS_PARITY.md`)
- [ ] Push (#11): APNs entitlement + FCM-via-APNs token wiring
- [ ] On-device test + TestFlight build

## Not Planned

- AR filters / lenses
- Drawing on photos
- Video calls
- Snap Map / location
- Memories / saved snaps
- Bitmoji
- Snap score
- Chat wallpapers
