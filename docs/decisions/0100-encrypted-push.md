# 0100: A closed app's notification opens a title and text plxd sealed for the user's phones

- Status: accepted; amends [0068](0068-relay.md)'s Push section
- Date: 2026-11-04
- Issue: PLX-1338

## Context

A closed app's notification said only "A thread finished", because 0068 keeps thread content from Parallax Relay and Apple. Ryan wants the thread's name as the title and the start of the agent's reply as the text, and chose to do it encrypted, so that promise holds.

## Decision

- **Key.** Each computer makes one random 32-byte key, once, in `relay-push-key` in its data folder, owner-only, as it keeps `remote-key`. `relay/pushKey`, behind the `relayPushKey` capability, answers with the key and the relay id its pushes carry. plxd has no method scopes: any session can call any method, and it can already read every thread this key would open. The desktop's renderer is refused it, since nothing there uses it.
- **Sealing.** With a run's push, plxd sends `sealed`: base64url of a random 12-byte nonce and the AES-256-GCM ciphertext (ring, which plxd already builds) of JSON `{title, text}`. The associated data is `<hostId>:<run>:<state>`, so a sealed text can't be shown for another push. The title is the thread's, or its prompt's first line. The text is "Needs your approval" for `needsYou`, and for `done` and `failed` the start of the last reply as plain text, or "Finished" or "Failed" when there is none, as the app's own notification says it. Each is cut to about 140 characters. If the key, title, or events can't be read, the push goes without `sealed`.
- **Relay.** The relay carries `sealed` without decoding it and never logs it. It sets `mutable-content` on an APNs payload that has one and keeps the fixed text as the alert. One longer than 2,400 characters is dropped and the push still goes. plxd's longest fits, and the payload stays well under APNs' 4 KB.
- **Phone.** On connecting to a computer with the capability, the app saves its key under the relay id with `expo-secure-store` in the keychain group `<team>.dev.parallax.mobile.pushKeys`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, since an extension runs while the phone is locked. The app lists its own group first in `keychain-access-groups`, so its other items, such as the account's session, stay out of the shared group. The team comes from `ios.appleTeamId` in `app.json`, which the app and the plugin both read.
- **Extension.** `plugins/withNotificationService.js` adds a `UNNotificationServiceExtension`, `dev.parallax.mobile.NotificationService`, on prebuild, from `plugins/notification-service/`. It opens `sealed` and sets the title and text. Any failure delivers the fixed text. It leaves `userInfo` alone, so tapping opens the thread as before.

## Rejected

- **Plain through the relay.** The simplest, and it breaks 0068: the relay and Apple could read every title and reply.
- **Generic only.** Keeps the promise, and leaves a notification that doesn't say which thread or what happened.

## Consequences

- A phone shows the fixed text for a computer it hasn't connected to since the phone was set up, or since that computer lost or remade its key. The next connection fixes it. There is no rotation: deleting `relay-push-key` makes a new key, and each phone gets it when it next connects.
- A device removed from the account keeps the keys it saved, but stops getting pushes, since the relay drops it. A stolen key opens only pushes taken from Apple or the relay.
- The relay can still see which run reached which state and when, and that the sealed text's length is about that of its plaintext.
- The extension is a new App ID, `dev.parallax.mobile.NotificationService`, which signing must cover. It needs no Push Notifications capability of its own, and keychain sharing needs nothing registered, only the team's prefix.
- A notification service extension has about 30 seconds and little memory. This one does one keychain read and one decrypt.
