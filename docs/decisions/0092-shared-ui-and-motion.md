# 0092: Shared UI components, one icon per concept, and motion tokens

- Status: accepted; amends [0085](0085-ui-style-guide.md)'s prompt radius, icon sizes in menus, and raw colors
- Date: 2026-10-29
- Issue: PLX-1149

## Context

The UI audit (PLX-1147) found the renderer rebuilding the same parts by hand: 58 icon buttons in six sizes, three button class modules and about 18 one-off buttons, 22 copies of the dialog shell in 11 widths, about 20 badges, 30 spinners, and about 20 empty states. Seven concepts were drawn with two or three icons each. Motion used about 17 durations and 12 easings, most dialogs and menus appeared with none, and reduced motion was opt-in per class.

## Decision

### Components

The renderer's shared parts live in `apps/desktop/src/renderer/ui/` and are imported from `ui.tsx`, as before. A view uses these before it draws its own.

| Component | Props | For |
| --- | --- | --- |
| `Button`, `buttonClass` | `variant`: primary, quiet (default), outline, danger. `size`: sm 28px, md 32px (default) | Every text button. `buttonClass` styles a link or label as one |
| `IconButton` | `size`: sm 24px with a 14px icon, md 28px with 16px (default), lg 32px with 20px. `reveal` | Every icon-only button. The caller never sizes the icon. `reveal` shows it only while its row (`group`) is hovered or it has focus |
| `Dialog` | `width`: sm 24rem, md 28rem (default), lg 36rem, xl 44rem. `placement`: center (default), top | Every modal's shell. `ConfirmDialog` is built on it |
| `Badge` | `shape`: chip, pill, count. `tone`: neutral, accent, success, warning, danger | Labels and counts on a tint of their tone |
| `StatusDot` | `tone`: on, off, working, warn, error. `pulse`, `label` | A state as a 6px dot |
| `Spinner` | `size`: sm 14px, md 16px, lg 20px | Work under way |
| `ProgressBar` | `value` (none pulses), `label` | Progress |
| `Kbd` | | A key or shortcut |
| `EmptyState` | `icon`, `title`, `body`, `action` | An empty list or page: a 24px icon and text, never a dashed box |
| `GroupHeading` | `action` | The small heading over a group in a list |
| `Switch`, `Checkbox` | `label`, `checked`, `onChange` | On/off and multiple choice. `Switch` moved from Settings' parts |

Controls are `rounded-md` at every size, and every disabled control is at 50% opacity.

### Icons

`icons.ts` maps each concept to one lucide icon, picked as the one the renderer already used most:

| Concept | Icon | Instead of |
| --- | --- | --- |
| external | ArrowUpRight | ExternalLink |
| refresh | RefreshCw | RotateCw |
| failed | CircleX | CircleAlert, which stays for `error` messages |
| warning | TriangleAlert | |
| terminal | SquareTerminal | Terminal |
| back, forward | ArrowLeft, ArrowRight | ChevronLeft |
| thread | MessagesSquare | MessageSquare |
| edit | Pencil | PencilLine, SquarePen, which stays for `newThread` |
| close | X | |

It also names add, delete, copy, done, more, search, settings, expand, next, pin, unpin, undo, download, loading, success, info, question, pull request, branch, folder, host, and agent. A concept gets an entry before its first use.

### Motion

`index.css`'s `@theme` holds the tokens, and `motion.ts` repeats them for JS (a test keeps them equal):

| Token | Value | For |
| --- | --- | --- |
| `duration-fast` | 120ms | Menus, tooltips, hovers, and every exit |
| `duration-base` | 180ms | Dialogs and panels |
| `duration-slow` | 240ms | What travels: toasts, drawers, progress |
| `ease-out` | cubic-bezier(0.23, 1, 0.32, 1) | What arrives |
| `ease-in` | cubic-bezier(0.55, 0, 1, 0.45) | What leaves |
| `ease-in-out` | cubic-bezier(0.65, 0, 0.35, 1) | What moves on screen |
| `ease-spring` | cubic-bezier(0.34, 1.56, 0.64, 1) | A small overshoot, for a mark that lands |

A Tailwind transition with no duration or easing of its own takes fast and out.

- Every `<dialog>` fades and scales in from 97% at base, and fades out at fast, with its backdrop.
- Every menu built on `menuPanel` (`Menu`, `Picker`, and most dropdowns) fades and grows from its trigger at fast.
- The tooltip fades in at fast.
- A toast slides in at slow and slides out at fast.

Motion stays small: opacity, a 3% scale, or a 16px slide. Nothing glows or bounces past its place.

Reduced motion is one rule: under `.reduce-motion`, every CSS animation and transition ends at once. An animation started from JS goes through `motion.ts`'s `animate`, which plays nothing under reduced motion.

### Tokens

- `--radius-prompt` is 16px. PLX-1089 lowered it from 24px, which read too round, after 0085 was written.
- Menu items draw their icons at 16px, as 0085's icon table says for menu items.
- Text on a danger fill uses `--danger-foreground`, black or white as on the accent. `ui/` and `ui.tsx` use no raw palette classes.
- The z-index scale: `z-raised` 10 (sticky headings), `z-overlay` 20 (a bar or card over a pane), `z-divider` 30 (resize handles), `z-popover` 50 (fixed cards over the window), `z-tooltip` 1000. Menus and dialogs are in the top layer and need none.

## Consequences

- Call sites still draw their own buttons, dialogs, spinners, and dots. PLX-1156 moves them onto these components and icons, file by file.
- A new size, width, duration, or easing between two steps takes the nearer one, or changes this record.
- Every dialog in the app now animates, including those not yet on `Dialog`, since the motion is on the `<dialog>` element.
- `settings/parts.tsx` and `ConnectionStatus.tsx` still have their own `StatusDot` until their callers move.
