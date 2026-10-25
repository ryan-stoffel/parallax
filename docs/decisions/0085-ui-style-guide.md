# 0085: One type scale, one radius scale, and a neutral dark theme

- Status: accepted
- Date: 2026-10-25
- Issue: PLX-996

## Context

A UI audit against T3 Code, Claude Desktop, and Codex in ChatGPT found the desktop app's renderer using more than 15 font sizes, half pixels among them (11, 11.5, 12, 12.5, 13, 13.5, 14, 15…), and about 18 corner radii, each picked where it was written. Its dark theme was tinted blue where the other three use neutral grays.

## Decision

Every font size and corner radius in `apps/desktop/src/renderer` comes from a scale in `index.css`'s `@theme`. The scales reset Tailwind's own (`--text-*: initial`, `--radius-*: initial`), so `text-sm` or `rounded-3xl` don't build, and nothing new should use an arbitrary `text-[…px]` or `rounded-[…px]`.

| Type | Size | For |
| --- | --- | --- |
| `text-micro` | 10px | Counters on badges, a repo's initials |
| `text-caption` | 11px | Keys, small labels |
| `text-meta` | 12px | Second lines, statuses, chips, hints |
| `text-body` | 13px | The UI's text: rows, menus, buttons, inputs |
| `text-reading` | 14px | The transcript, the composer, dialog titles |
| `text-heading` | 18px | Page and panel headings |
| `text-display` | 24px | New Thread's question, onboarding, big numbers |
| `text-hero` | 40px | The Usage page's largest numbers |

The type sizes set only the size, so text keeps the line height around it. Weight carries hierarchy within a size: titles are `font-medium` or `font-semibold`, and second lines are `text-faint-foreground`.

| Radius | Size | For |
| --- | --- | --- |
| `rounded-sm` | 4px | Marks: keys, inline code, tiles, small bars |
| `rounded-md` | 6px | Controls: buttons, inputs, chips, menu items |
| `rounded-lg` | 8px | Rows, cards, menus, popovers |
| `rounded-xl` | 12px | Panels and dialogs |
| `rounded-2xl` | 16px | The composer and other large surfaces |
| `rounded-full` | | Pills, avatars, dots, round buttons |

Percent radii on image squircles and 1 to 2px radii on chart bars stay where they are.

Parallax Dark uses neutral grays: the sidebar `#101010`, a step darker than the thread's `#161616`, and raised surfaces such as the composer, cards, and menus `#1f1f1f`. Borders, hover, and selection are white at 8%, 5%, and 8%. The accent stays the logo's blue.

## Consequences

- A change that needs a size between two steps takes the nearer step, or changes this record.
- Colors already come only from `index.css`'s tokens. Raw palette classes such as `text-emerald-500` that remain are follow-up work.
- The mobile app's theme (`apps/mobile/src/theme.ts`) repeats these colors, and its test holds it to them.
