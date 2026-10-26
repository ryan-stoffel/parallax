# 0085: One font, one type scale, one radius scale, one icon family, and a black dark theme

- Status: accepted; supersedes [0083](0083-project-surfaces.md)'s Sora for headings
- Date: 2026-10-25
- Issue: PLX-996

## Context

A UI audit against T3 Code, Claude Desktop, and Codex in ChatGPT found the desktop app's renderer using more than 20 font sizes, half pixels among them (11, 11.5, 12, 12.5, 13, 13.5, 14, 15…), five weights, two text faces, and about 18 corner radii, each picked where it was written. Its dark theme was tinted blue where the others are neutral, near black.

## Decision

### Font

Inter (`Inter Variable`, bundled) is the interface font on every OS, at three weights: 400 for text, 500 for labels and titles, 600 for headings. The user's font in Settings > Appearance still wins. Sora is only the Parallax wordmark. Code stays in JetBrains Mono.

### Type scale

Every font size in `apps/desktop/src/renderer` comes from `index.css`'s `@theme`. It resets Tailwind's own (`--text-*: initial`), so `text-sm` doesn't build, and nothing new uses an arbitrary `text-[…px]`.

| Type | Size | For |
| --- | --- | --- |
| `text-micro` | 10px | Counters on badges, a repo's initials |
| `text-caption` | 11px | Keys, small labels |
| `text-meta` | 12px | Second lines, statuses, descriptions, hints |
| `text-body` | 13px | The UI's text: rows, menus, buttons, inputs, inline code |
| `text-reading` | 14px | The transcript, the composer, section headings |
| `text-heading` | 18px | Page headings, Markdown's h1 and h2 |
| `text-display` | 24px | New Thread's question, onboarding, big numbers |
| `text-hero` | 40px | The Usage page's largest numbers |

The type sizes set only the size, so text keeps the line height around it.

### Roles

The same kind of text is the same size and weight everywhere:

| Text | Style |
| --- | --- |
| Sidebar row titles, settings rows, menu items, dialog fields | `text-body`, 500 for a title, 400 otherwise |
| Second lines: a row's repo and branch, a setting's description, statuses | `text-meta` in muted or faint |
| Settings section headings | `text-reading`, 600 |
| Page headings (Settings, Usage, a Project) | `text-heading`, 600 |
| The transcript and composer | `text-reading`, 400 |

### Radius scale

| Radius | Size | For |
| --- | --- | --- |
| `rounded-sm` | 4px | Marks: keys, inline code, tiles, small bars |
| `rounded-md` | 6px | Controls: buttons, inputs, chips, menu items |
| `rounded-lg` | 8px | Rows, cards, menus, popovers |
| `rounded-xl` | 12px | Surfaces: panels, dialogs, settings groups |
| `rounded-prompt` | 24px | Prompt boxes (the composer, MiniPrompt) and the bars tucked over and under them |
| `rounded-full` | | Pills, avatars, dots, round buttons |

`--radius-*: initial` resets Tailwind's own here too.

### Icons

Every interface icon is lucide's, the browser's included, which drew Material Symbols before. A CSS rule (`index.css`) draws every lucide icon's lines at 1.5px whatever its size, since lucide's own stroke is 2 in 24 and thins and thickens with the icon. An icon given its own `strokeWidth`, such as a check in a tiny checkbox, keeps it.

| Size | For |
| --- | --- |
| `size-3` | 12px marks: a pin, a PR's checks |
| `size-3.5` | 14px, beside text: rows, chips, second lines |
| `size-4` | 16px controls: buttons, menu items, the composer |
| `size-5` | 20px large buttons and tiles |

Outside these:
- Illustrative icons in empty states, onboarding, file cards, and the browser's signed-out profile draw at 24 or 32px.
- Checks inside tiny checkboxes draw at their box's 8 to 10px, with their own heavier stroke.
- Brand logos, file-type icons, and Parallax's own marks keep their own drawing.

### Exempt

These stay as they are:
- KaTeX's `em` size
- avatar initials, which scale with the avatar
- the terminal, which takes its size from Appearance
- percent radii on image squircles
- 1 to 2px radii on chart bars, loaders, and confetti

### Dark theme

Parallax Dark is near black with no tint, as T3 Code's is:
- the sidebar `#000000`
- the thread `#0a0a0a`
- raised surfaces such as the composer, cards, and menus `#141414`

Borders, hover, and selection are white at 8%, 5%, and 8%. The accent stays the logo's blue.

## Consequences

- A change that needs a size or radius between two steps takes the nearer one, or changes this record.
- Colors already come only from `index.css`'s tokens. Raw palette classes such as `text-emerald-500` that remain are follow-up work.
- The mobile app's theme (`apps/mobile/src/theme.ts`) repeats these colors, and its test holds it to them. It keeps Sora as its type.
