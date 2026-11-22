# Parallax for iOS and Android

The phone app, in React Native with Expo. `ios/` and `android/` are made by `expo prebuild` and never committed, so native settings live in `app.json` and `plugins/`.

```sh
corepack pnpm install
corepack pnpm check   # type check
corepack pnpm test    # unit tests
```

## Android release bundle

Google Play takes an app bundle signed with the upload key. The key and its passwords come from the build's environment and are never in the repo (`plugins/withAndroidReleaseSigning.js`).

Make the upload key once and keep it outside the repo:

```sh
keytool -genkeypair -v -storetype PKCS12 -keyalg RSA -keysize 2048 -validity 10000 \
  -keystore ~/parallax-upload.keystore -alias upload
```

Build the bundle with JDK 17 and the Android SDK (`JAVA_HOME`, `ANDROID_HOME`):

```sh
export PARALLAX_ANDROID_KEYSTORE=~/parallax-upload.keystore
export PARALLAX_ANDROID_KEYSTORE_PASSWORD=...
export PARALLAX_ANDROID_KEY_ALIAS=upload
export PARALLAX_ANDROID_KEY_PASSWORD=...

corepack pnpm exec expo prebuild --platform android --no-install
(cd android && ./gradlew bundleRelease)
```

The bundle is `android/app/build/outputs/bundle/release/app-release.aab`. Check who signed it:

```sh
keytool -printcert -jarfile android/app/build/outputs/bundle/release/app-release.aab
```

Without all four variables a release build (`assembleRelease`, `bundleRelease`) stops and names the missing ones. Debug builds need none. Raise `android.versionCode` in `app.json` for every upload.
