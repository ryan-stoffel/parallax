# 0086: Every icon is Hugeicons stroke-rounded

- Status: accepted
- Date: 2026-10-25
- Issue: PLX-1000

## Context

The desktop app drew its interface icons with lucide-react, the browser's with Google's Material Symbols (PLX-970), and a mini PC by hand. Two families with different strokes, corners, and proportions sat side by side, and the UI audit for PLX-996 scored iconography below Claude and Codex.

## Decision

- Every interface icon in `apps/desktop/src/renderer` is a Hugeicons stroke-rounded glyph from `@hugeicons/core-free-icons`, drawn by `@hugeicons/react` at its 1.5 stroke. `lucide-react` is gone.
- `icons.tsx` is the one place glyphs are chosen. It exports each icon under the name the app imports, so call sites keep their names, classes, and props. Each icon carries `data-icon` with its kebab name for tests.
- Each name maps to Hugeicons' icon of the same meaning. These are not always same-named; for example, `ArrowUp` is `ArrowUp02`, since Hugeicons' `ArrowUp01` is a chevron.
- `symbols.tsx` keeps the browser's Material names but draws Hugeicons glyphs.
- Project icon keys stay the names plxd stores (0032), each mapped to a glyph.
- Brand logos (`logos.tsx`, the iOS and Android marks), file-type icons, Parallax's working and done marks, and charts and progress rings stay their own.
- Hugeicons has no mini PC, so `DeviceIcon` draws one at Hugeicons' stroke and rounding.

## Consequences

- A new icon is added to `icons.tsx`, picked from Hugeicons' free stroke-rounded set.
- A glyph swap is one line in `icons.tsx`.
