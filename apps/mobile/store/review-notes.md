# Review notes

A template for App Store Connect's App Review Information and Play Console's App access (PLX-1614). Fill each `{{...}}` before submitting, and send nothing with one left in. The review access option is Ryan's choice on PLX-1372. This template assumes the fixed setup code on a review computer. Rewrite "How to get in" if he chooses another.

## Contact

| Field | Value |
| --- | --- |
| First and last name | `{{REVIEW_CONTACT_NAME}}` |
| Phone | `{{REVIEW_CONTACT_PHONE}}` |
| Email | `{{REVIEW_CONTACT_EMAIL}}` |

## Sign-in

| Field | Value |
| --- | --- |
| Sign-in required | Yes |
| User name | `{{REVIEW_ACCOUNT_EMAIL}}` |
| Password | `{{REVIEW_ACCOUNT_PASSWORD}}` |

## Notes

Paste this into the Notes field. Keep it under App Store Connect's 4,000 characters.

```
WHAT PARALLAX IS

Parallax is a client for coding agents that run on the user's own computers. The agents (for example Claude Code or Codex) run inside the free, open-source Parallax desktop app on a Mac, Windows PC, or Linux machine the user owns. This phone app lists the threads on those computers, shows what each agent is doing, and lets the user reply, answer questions, and approve commands.

It is not a remote desktop or screen mirroring app. It never shows or controls the computer's screen. It shows the app's own native views of agent conversations, diffs, and pull requests.

HOW TO GET IN

The app shows nothing without an account and a computer, so we keep a review computer running for you.

1. Open Parallax and tap Sign in.
2. Choose email and enter:
   Email: {{REVIEW_ACCOUNT_EMAIL}}
   Password: {{REVIEW_ACCOUNT_PASSWORD}}
3. The review computer, "{{REVIEW_COMPUTER_NAME}}", appears and asks for its setup code.
4. Enter the 6-digit setup code: {{REVIEW_SETUP_CODE}}
5. Its threads load. Open "{{REVIEW_SAMPLE_THREAD}}" to see a finished thread, or start a new thread in the project "{{REVIEW_SAMPLE_PROJECT}}".

The review computer is online at all times during review. If it doesn't appear, contact {{REVIEW_CONTACT_EMAIL}} and we'll fix it within {{REVIEW_RESPONSE_TIME}}.

ACCOUNT DELETION (5.1.1(v))

Settings > tap the account row at the top > Security > Delete account. After a confirmation, it opens the account's security page, where Delete account completes the deletion. Please don't delete the review account before review ends.

PRIVACY (5.1.1, 5.1.2)

The privacy policy is at https://parallax.codes/privacy and inside the app at Settings > About (the info button) > Privacy policy.

The app sends no user data to any AI provider. Prompts go from the phone to the user's own computer over an end-to-end encrypted connection, and that computer talks to the AI provider with the user's own account there.

The app contains no analytics or advertising SDK and does no tracking.

PUSH NOTIFICATIONS (4.5.4)

The app works with notifications off. Each push carries a fixed line, such as "A thread finished.", that Apple and our relay can read, and the thread's title and the start of the agent's reply encrypted with a key only the user's devices hold. A notification service extension decrypts those on the phone and shows them as the notification's title and text in place of the fixed line. If it can't, the fixed line is shown.

PERMISSIONS

Camera, Photos: attach a picture to a message, only when the user chooses to.
Microphone, Speech Recognition: dictate a message, only when the user taps the microphone.
Local Network: find the user's computers on the same Wi-Fi.

PURCHASES

None. The app is free. It unlocks no paid features or content.
```

## Before submitting

- [ ] Every `{{...}}` above is filled in
- [ ] The review computer is on, signed in to the review account, and shows the sample thread
- [ ] The steps under "How to get in" were walked on a phone that has never signed in, the setup code still works, and the wording matches what that phone showed. They were written before the review access option existed and have not been run
- [ ] The review account signs in with only its password: no second factor, passkey, or email code on a new device
- [ ] `https://parallax.codes/privacy`, `/support`, and `/delete-account` answer, with no TODO left on them
- [ ] Export compliance is answered. `ITSAppUsesNonExemptEncryption` is `false` in `app.json` while the app does its own end-to-end encryption, and that answer is Ryan's to make (PLX-1372)
- [ ] `ios.buildNumber` and `android.versionCode` in `app.json` are raised for this upload
- [ ] Play Console's App access has the same account, code, and steps
