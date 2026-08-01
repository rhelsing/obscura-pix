# Firebase Setup

Firebase client configuration is gitignored and must be supplied per
environment.

## Current support

- Android FCM token delivery and background processing are implemented.
- iOS push delivery is **not** implemented. The Swift bridge can request
  notification permission and register a token with the kit, but the app does
  not obtain or forward an APNs/FCM token and has no Notification Service
  Extension. See [`IOS_PARITY.md`](IOS_PARITY.md).

## Android

Download `google-services.json` from the Firebase project's Android app
(`com.obscuraapp.android`) and place it at:

```text
android/app/google-services.json
```

The file must not appear in `git status`. The CI release-build job creates a
non-production stub because it verifies compilation rather than push delivery.

If the build reports that `google-services.json` is missing, confirm the path
and exact filename. Android push also requires a device or emulator with Google
Play Services.

## iOS production prerequisites

These steps are prerequisites for implementing iOS push; completing them alone
does not enable push in the current app.

1. Download `GoogleService-Info.plist` for `com.obscuraapp.ios`.
2. Add it to the `ObscuraApp` Xcode target with target membership enabled.
3. Create an APNs authentication key in the Apple Developer portal.
4. Upload that key, its Key ID, and the Apple Team ID under Firebase Cloud
   Messaging.
5. Enable Push Notifications and the Background Modes → Remote notifications
   capability.
6. Add Firebase Messaging, forward its token through `pushTokenReceived`, and
   handle the server's content-free background notification in the app
   delegate. The current payload does not launch a Notification Service
   Extension.

## Repository policy

The Firebase config files contain project identifiers and client API keys.
They are not server credentials, but repository policy keeps them out of the
public tree. Firebase Admin service-account credentials are secrets and must
never enter this repository.
