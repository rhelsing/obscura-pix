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

- [ ] Implement `ObscuraBridge.swift` against the contract in `docs/BRIDGE.md`
- [ ] App icons + launch screen assets
- [ ] APNs entitlement + push token wiring
- [ ] TestFlight build

## Not Planned

- AR filters / lenses
- Drawing on photos
- Video calls
- Snap Map / location
- Memories / saved snaps
- Bitmoji
- Snap score
- Chat wallpapers
