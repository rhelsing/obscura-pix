# Firebase Setup

Each developer needs to configure their local environment with the Firebase config files. The files are gitignored (they contain project-specific identifiers that some teams prefer not to be public), so they must be fetched manually per environment.

## Prerequisites

- Firebase Admin access to the `obscura` project (ask Ryan if you don't have this)
- For iOS: Apple Developer account access for APNS key setup
- For Android: nothing extra

## One-time per machine: download config files

### Android (`google-services.json`)

1. Go to [Firebase Console → Project settings → Your apps](https://console.firebase.google.com/project/obscura/settings/general/)
2. Find the **Android app** (package name: `com.obscuraapp.android`)
3. Click **"google-services.json"** download button
4. Move the file to `android/app/google-services.json`

```bash
# From project root
mv ~/Downloads/google-services.json android/app/google-services.json
```

### iOS (`GoogleService-Info.plist`)

1. Same Firebase console page, find the **iOS app** (bundle ID: `com.obscuraapp.ios`)
2. Click **"GoogleService-Info.plist"** download button
3. Move the file to `ios/ObscuraApp/GoogleService-Info.plist`

```bash
mv ~/Downloads/GoogleService-Info.plist ios/ObscuraApp/GoogleService-Info.plist
```

**Critical for iOS:** After placing the file, open Xcode and drag it into the project navigator under `ObscuraApp/` target. Without this, the file won't be included in the app bundle and Firebase SDK will fail to init. Check the "Copy items if needed" box and ensure the target membership checkbox is checked.

## Verification

After placing the config files:

```bash
ls -la ios/ObscuraApp/GoogleService-Info.plist    # should exist
ls -la android/app/google-services.json           # should exist

# Both should NOT appear in git status — they're gitignored
git status
```

## APNS setup (iOS only, one-time per project)

iOS requires an APNS authentication key uploaded to Firebase so Firebase can deliver pushes through Apple's servers.

1. Go to [Apple Developer → Keys](https://developer.apple.com/account/resources/authkeys/list) (requires Admin or App Manager role)
2. Click **"+"** to create a new key
3. Name: `Obscura APNS`
4. Check **"Apple Push Notifications service (APNs)"**
5. Click Continue → Register → **Download** the `.p8` file (save it safely — Apple only lets you download once)
6. Note the **Key ID** (10 characters) and your **Team ID** (top-right corner of developer.apple.com)
7. Go to Firebase Console → Project settings → **Cloud Messaging** tab
8. Under **Apple app configuration**, click **Upload** next to "APNs Authentication Key"
9. Upload the `.p8` file, enter Key ID and Team ID
10. Save

This is a one-time setup per Apple Developer team. Once done, all iOS devs on any machine can receive real pushes without additional config.

## Troubleshooting

**Android build fails with "File google-services.json is missing"**
- File isn't in `android/app/`. Re-download from Firebase console.
- File is there but named wrong. Must be exactly `google-services.json` (no suffix, no version).

**iOS build fails with "No such file: GoogleService-Info.plist"**
- File isn't dragged into the Xcode project. Open `ObscuraApp.xcodeproj`, right-click the `ObscuraApp` group, "Add Files to ObscuraApp...", select the plist, check "Copy items if needed" and the target checkbox.

**Pushes arrive on Android but not iOS**
- APNS key not uploaded to Firebase (see APNS setup above).
- App wasn't launched from Xcode with a development provisioning profile — push requires explicit entitlement. Re-install from Xcode, not via TestFlight or ad-hoc.

**Pushes arrive on iOS but not Android**
- Emulator without Google Play Services. Use a Google Play image (the emulator AVD name will say "Google Play" not "Google APIs").
- Rooted emulator / older API level. Use API 30+ with Play Services.

## Why gitignored?

The config files contain:
- Firebase project ID
- App ID
- API key (not a secret — it's a project identifier, not auth credentials)

They're safe to commit in most teams, but we gitignore to keep the Firebase project ID out of the public repo. The real secrets (Firebase Admin SDK service account JSON) live on the server, never in client repos.

## If you're setting up CI

CI should fetch the config files from a secrets store, not commit them. Example with GitHub Actions:

```yaml
- name: Decode google-services.json
  run: echo "${{ secrets.GOOGLE_SERVICES_JSON }}" | base64 -d > android/app/google-services.json

- name: Decode GoogleService-Info.plist
  run: echo "${{ secrets.GOOGLE_SERVICE_INFO_PLIST }}" | base64 -d > ios/ObscuraApp/GoogleService-Info.plist
```

Store the base64-encoded files as GitHub secrets. Do not commit the raw files.
