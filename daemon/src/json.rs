//! A tiny shared helper for counting a JSON string's size the way `serde_json` actually writes
//! it, used wherever a byte budget has to hold after encoding, not just before it (#157, #190).

/// The size of `text` as a JSON string's content, as `serde_json` writes it: `"` and `\\` and the
/// short escapes (`\n`, `\t`, ...) take two bytes, other control characters six (`\u00XX`).
pub(crate) fn escaped_len(text: &str) -> usize {
    text.bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 0x08 | 0x0c => 2,
            0x00..=0x1f => 6,
            _ => 1,
        })
        .sum()
}
