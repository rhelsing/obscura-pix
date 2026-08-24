# Firebase setup

## Android

Ordinary builds use the tracked non-delivery stub:

```bash
cp android/app/google-services.stub.json android/app/google-services.json
```

For real push delivery, replace it with the Firebase Android configuration for
`com.obscuraapp.android`. The destination file is gitignored. A push-capable
device or emulator must have Google Play Services.

## iOS

iOS push is not implemented. Remaining work is tracked in
[`IOS_PARITY.md`](IOS_PARITY.md); privacy and payload requirements are in
[`PUSH_NOTIFICATIONS.md`](PUSH_NOTIFICATIONS.md).

## Repository policy

Client Firebase files remain gitignored. Firebase Admin credentials are server
secrets and must never enter this repository.
