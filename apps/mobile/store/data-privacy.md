# App Privacy and Data safety answers

Draft answers for App Store Connect's App Privacy and Play Console's Data safety form (PLX-1614), drawn from the privacy policy (`site/public/privacy.html`, PLX-1648) and the code it describes. They cover the phone app only. The desktop app's PostHog usage events aren't in the phone app and aren't declared here.

These are legal statements, and Ryan submits them. Check each against the policy at the time of submission.

## What the phone app and its services collect

| Data | Where it goes | Why |
| --- | --- | --- |
| Name, email address | Clerk, at sign-in | The account |
| Account id | Clerk, and the relay, which keys an account's computers by it | The account, and listing the account's computers |
| Push token | The relay, then Apple or Google | Sending notifications |
| Profile picture, if the sign-in provider gives one | Clerk | Shown in the app |
| IP address and the approximate location Clerk derives from it, per sign-in session | Clerk | The account page's list of signed-in devices |

What the app handles but nobody else can read: prompts, agent replies, code, diffs, attached photos and files, and dictated text. They go from the phone to the user's own computer over a connection encrypted end to end. A notification's title and text are sealed the same way. Dictation audio is turned into text by the phone's own speech recognition.

What the app doesn't do: analytics, crash reporting, advertising, tracking, reading the phone's location or contacts, or purchases.

## App Store Connect: App Privacy

**Do you or your third-party partners collect data from this app?** Yes.

| Data type | Collected | Linked to the user | Used for tracking | Purpose |
| --- | --- | --- | --- | --- |
| Contact Info > Name | Yes | Yes | No | App Functionality |
| Contact Info > Email Address | Yes | Yes | No | App Functionality |
| Identifiers > User ID | Yes | Yes | No | App Functionality |
| Identifiers > Device ID | Yes | Yes | No | App Functionality |
| Location > Coarse Location | Yes | Yes | No | App Functionality |

Coarse Location is declared because Clerk keeps each sign-in session's IP address and the approximate location it derives from it, and shows them on the account page's device list. The app never asks for the phone's location and has no location permission.

These five match `ios.privacyManifests.NSPrivacyCollectedDataTypes` in `app.json`. Keep the two in step.

Every other type: not collected. The ones a reviewer may ask about:

| Data type | Answer | Why |
| --- | --- | --- |
| User Content > Photos or Videos, Audio Data, Other User Content | Not collected | Attachments and messages go only to the user's own computer, encrypted end to end. Apple counts data as collected when it leaves the device in a form the developer or a partner can read |
| Usage Data, Diagnostics | Not collected | The phone app has no analytics or crash reporting |
| Precise Location, Contacts, Health, Financial Info, Browsing History, Search History, Purchases, Sensitive Info | Not collected | The app doesn't read them |

TODO (Ryan): the profile picture. Clerk stores the picture the sign-in provider gives, and the app shows it. If you count that as the user's photo, add User Content > Photos or Videos (linked, App Functionality) here and to the privacy manifest in `app.json`. The draft leaves it out, as PLX-1608's manifest did.

**Tracking**: No. `NSPrivacyTracking` is `false`, and the app has no tracking domains.

## Play Console: Data safety

| Question | Answer |
| --- | --- |
| Does your app collect or share any of the required user data types? | Yes |
| Is all of the user data collected by your app encrypted in transit? | Yes |
| Do you provide a way for users to request that their data is deleted? | Yes |
| Account deletion URL | `https://parallax.codes/delete-account` |
| Can users delete their account in the app? | Yes: Settings > the account row > Security > Delete account |
| Independent security review | No |

Data types:

| Category > type | Collected | Shared | Processed ephemerally | Required | Purposes |
| --- | --- | --- | --- | --- | --- |
| Personal info > Name | Yes | No | No | Required | Account management |
| Personal info > Email address | Yes | No | No | Required | Account management |
| Personal info > User IDs | Yes | No | No | Required | Account management, App functionality |
| Device or other IDs | Yes | No | No | Optional: only with notifications on | App functionality |
| Location > Approximate location | Yes | No | No | Required | Account management, Fraud prevention, security, and compliance |

Approximate location is declared for the same reason as Apple's Coarse Location: Clerk keeps each sign-in session's IP address and the approximate location it derives from it. The app holds no location permission.

"Shared" is No because Clerk, Cloudflare, and Google handle the data as service providers for Parallax, which Play doesn't count as sharing.

Not declared, and why:

| Category | Why |
| --- | --- |
| Photos and videos, Audio files, Files and docs, Messages | They go only to the user's own computer, encrypted end to end. Play's form exempts data that end-to-end encryption makes unreadable to everyone but sender and recipient |
| App activity, App info and performance | The phone app has no analytics or crash reporting |
| Precise location, Contacts, Financial info, Health and fitness, Calendar, Web browsing | The app doesn't read them |

## Open before submitting

- What the policy says the relay keeps after an account is deleted (PLX-1612) conflicts with both stores' deletion rules until that issue ships. Play's form asks whether deleting the account deletes its data. Answering yes is accurate only after PLX-1612, or if Ryan removes the relay data by hand for each request.
- Android's `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO` need Play's photo and video permissions declaration, or the photo picker instead (PLX-1613).
- Android notifications use FCM. Until the relay has it (PLX-1372, PLX-1556), the Android app registers no push token, and Device or other IDs could be left out for a first Android release without notifications.
- Age rating and content rating questionnaires: no violence, sexual content, gambling, or user-to-user communication. Apple's questionnaire also asks about AI features. TODO (Ryan): answer it for an app that shows the output of AI agents the user runs on their own computer.
- Whether Clerk revokes Sign in with Apple tokens when a user deletes their account wasn't found in Clerk's documentation (PLX-1608). Apple's deletion guidance asks for it.
