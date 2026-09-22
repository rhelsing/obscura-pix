# Android testing distribution

Successful `main` CI runs trigger `.github/workflows/android-distribution.yml`.
The workflow rebuilds the exact tested commit as a signed, minified universal
APK, retains it as a GitHub artifact for 30 days, and sends it to the configured
Firebase App Distribution tester group. Maintainers can also run the workflow
manually for the current `main` commit.

Pull requests never receive distribution credentials. Their Android CI build
uses the checked-in Firebase stub and debug signing as a compile gate.

## Firebase

The Firebase Android app must use package `dev.barrelmaker.obscura`. Enable App
Distribution, create a tester group, and add each tester's Google account.

Download the real `google-services.json` for local push testing. Keep it at
`android/app/google-services.json`; the file is gitignored.

## Signing key

Create one long-lived release key and keep an encrypted backup outside the
repository:

```bash
mkdir -p ~/.config/obscura
keytool -genkeypair -v \
  -keystore ~/.config/obscura/android-release.p12 \
  -storetype PKCS12 \
  -alias obscura-release \
  -keyalg RSA -keysize 4096 -validity 10000
```

Use the same store and key password for PKCS12. Every distributed APK must use
this identity so it can update an existing installation.

For a local signed build, create ignored `android/keystore.properties`:

```properties
storeFile=/absolute/path/to/android-release.p12
storePassword=...
keyAlias=obscura-release
keyPassword=...
```

Then run:

```bash
just android-distribution 1 1.0.0-test.1
```

Unlike `just android-release`, this command fails if signing, version metadata,
or the real Firebase configuration is missing.

## GitHub testing environment

Create a `testing` environment without required reviewers when every successful
`main` build should distribute automatically. Configure its deployment branches
to allow only `main`; a workflow selected from another branch must not receive
the signing secrets.

Configure these environment variables:

| Variable | Purpose |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full Google workload identity provider resource name. |
| `GCP_SERVICE_ACCOUNT` | Dedicated distribution service-account email. |
| `FIREBASE_ANDROID_APP_ID` | Firebase Android App ID. |
| `FIREBASE_TESTER_GROUP` | Firebase App Distribution group alias. |

Configure these environment secrets:

| Secret | Purpose |
|---|---|
| `GOOGLE_SERVICES_JSON_BASE64` | Base64-encoded real Firebase Android configuration. |
| `ANDROID_RELEASE_KEYSTORE_BASE64` | Base64-encoded PKCS12 signing key. |
| `ANDROID_RELEASE_STORE_PASSWORD` | PKCS12 password. |
| `ANDROID_RELEASE_KEY_ALIAS` | Signing alias, normally `obscura-release`. |
| `ANDROID_RELEASE_KEY_PASSWORD` | PKCS12 password. |

The workflow validates the Firebase package and App ID before building and
never writes credentials outside runner-temporary or ignored paths.

## Google authentication

Use GitHub's OpenID Connect token with Google Workload Identity Federation.
Restrict the provider to `rhelsing/obscura-pix`, grant the repository principal
`roles/iam.workloadIdentityUser` on a dedicated service account, and grant that
service account `roles/firebaseappdistro.admin` in the Firebase project.

The provider condition must also require `assertion.ref == 'refs/heads/main'`
and
`assertion.job_workflow_ref == 'rhelsing/obscura-pix/.github/workflows/android-distribution.yml@refs/heads/main'`.
Repository-only conditions are too broad because another branch or workflow
could otherwise request a distribution token.

Do not create a long-lived service-account JSON key for GitHub Actions.

## Installing a build

Firebase emails newly added testers an invitation. After accepting it, a tester
can install the latest build from the Firebase App Tester page. Later builds
signed with the same key update the existing app.

The workflow summary links to the retained GitHub artifact as a fallback. A
manual run is appropriate for rebuilding the current `main` commit; normal
pushes use the post-CI trigger. Re-run the original distribution workflow when
retrying an older tested commit.
