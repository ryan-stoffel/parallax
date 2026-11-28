# Store listing

Draft text for App Store Connect and Play Console (PLX-1614). Every claim here is something the phone app does on `develop`. Change the text when the app changes. Limits are the stores' and each line's count is beside it.

## Both stores

| Field | Text |
| --- | --- |
| Name | Parallax |
| Privacy policy URL | `https://parallax.codes/privacy` |
| Support URL | `https://parallax.codes/support` |
| Account deletion URL (Play) | `https://parallax.codes/delete-account` |
| Marketing URL (optional) | `https://parallax.codes` |
| Copyright | TODO (Ryan): year and legal name |
| Price | Free, with no in-app purchases |

## App Store

**Subtitle** (30 max, 28 used)

```
Your coding agents, anywhere
```

**Promotional text** (170 max, 140 used)

```
Check on the coding agents running on your own computers. Read each thread, answer its questions, approve its commands, and review its work.
```

**Keywords** (100 max, 96 used)

```
coding agent,ai,developer,git,pull request,code review,diff,remote,devtools,programming,terminal
```

No agent's or company's name is in the keywords. Apple's guideline 2.3.7 rejects other companies' trademarks there.

**Category**: Developer Tools. Secondary: Productivity.

## Google Play

**Short description** (80 max, 73 used)

```
Check on the coding agents running on your own computers, from your phone
```

**Category**: Tools. **Tags**: TODO (Ryan), picked from Play Console's list.

## Description

For both stores (4,000 max).

```
Parallax runs coding agents on computers you own. This app is how you check on them from your phone.

Start a task on your desktop, close the laptop, and keep up from anywhere. Every thread on every one of your computers is in one list.

WHAT YOU CAN DO

• Read each thread as the agent works: its replies, the commands it runs, and the files it changes.
• Send a follow-up, or start a new thread in any of your projects.
• Answer an agent's question and approve or deny a command it asks to run.
• Get a notification when a thread needs you, finishes, or fails.
• Review a thread's diff and its pull request.
• Attach a photo or a file to a message, or dictate it.
• Search your threads across computers.
• See a thread's status at a glance in a widget.

YOUR CODE STAYS ON YOUR COMPUTERS

Parallax has no cloud that holds your code. Your threads, prompts, and files live on your own computers. The phone connects to them directly on your network, or through Parallax Connect when you're away. That connection is encrypted from your phone to your computer, so the relay in between can't read it. A notification's title and text are encrypted the same way.

WHAT YOU NEED

• A computer running Parallax for macOS, Windows, or Linux. It is free and open source: github.com/ryan-stoffel/parallax
• A free Parallax account, to find your computers from your phone.
• Your own subscription or API key for the agents you use. Parallax works with Claude Code, Codex, Cursor, and OpenCode. You sign in to each one on your computer, and Parallax runs it there.

The phone app doesn't run agents itself, and it does nothing without a computer of yours to connect to.

OPEN SOURCE

Parallax is Apache-2.0 licensed. Read the code, report a problem, or follow the roadmap on GitHub.

Privacy policy: https://parallax.codes/privacy
Support: https://parallax.codes/support
```

Notes on the description:

- "Parallax works with Claude Code, Codex, Cursor, and OpenCode" names other companies' products to say what Parallax is compatible with. It claims no affiliation. Play's metadata policy and Apple's 2.3 allow that. Remove a name if its owner objects.
- "A widget" is true on both platforms. Live Activities are iOS only, so the shared text leaves them out. Add a line to the App Store copy if you want it: "• Follow running threads in a Live Activity."
- Android notifications need FCM on the relay (PLX-1372, PLX-1556). Until that is live, cut the notification bullet from the Play copy.

## What's New (first release)

```
The first release of Parallax for your phone.
```

## Screenshots

TODO (Ryan): 6.9-inch iPhone screenshots that show the app in use (Apple 2.3.3), and Play's phone screenshots and feature graphic. Suggested screens: the thread list, a thread with an approval, a diff, a pull request, the widget, and Settings > Connections.
