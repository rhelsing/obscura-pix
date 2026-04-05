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
- [x] Pix model defined (ephemeral photo schema)
- [x] Device linking (QR/code approval flow)
- [x] Auto-reconnect (ping keepalive, exponential backoff)
- [x] Session persistence (kit-owned, survives app restart)
- [x] Debug log (in-app, Settings tab)
- [x] Cross-platform interop (iOS ↔ Android proven)

## Phase 1: Camera + Send Photo

The core Snapchat interaction — capture and send.

- [ ] Camera screen (home screen, replaces current friends-first layout)
- [ ] Take photo (tap to capture)
- [ ] Front/back camera toggle
- [ ] Flash toggle
- [ ] Add text overlay on captured photo
- [ ] Timer selection (3s, 5s, 10s, no limit)
- [ ] Recipient picker (select friends and/or story)
- [ ] One-tap send to multiple recipients
- [ ] Send photo from camera roll

## Phase 2: Ephemeral Viewing

Photos disappear after viewing — the Snapchat promise.

- [ ] View-once photo display (full screen, tap to dismiss)
- [ ] Photo disappears after viewed (Pix model `displayDuration`)
- [ ] 1x or 2x view option (sender chooses)
- [ ] "Opened" / "Delivered" status on sent snaps
- [ ] Screenshot detection + notification to sender

## Phase 3: Rich Chat

Beyond plain text.

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

## Phase 6: Push Notifications

- [ ] APNS (iOS) + FCM (Android) registration
- [ ] Push on new snap received
- [ ] Push on new chat message
- [ ] Push on friend request
- [ ] Push on streak expiry warning

## Not Planned

- AR filters / lenses
- Drawing on photos
- Video calls
- Snap Map / location
- Memories / saved snaps
- Bitmoji
- Snap score
- Chat wallpapers
