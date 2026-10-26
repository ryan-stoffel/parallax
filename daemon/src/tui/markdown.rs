//! The little Markdown `plxd tui` renders in replies: headings, bullets, fenced code, and inline
//! `code` and **bold**. Anything else shows as written.

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

/// Inline and fenced code's color.
const CODE: Color = Color::Rgb(0x89, 0xdc, 0xeb);

/// `text` as styled lines.
pub fn lines(text: &str) -> Vec<Line<'static>> {
    let mut fenced = false;
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            out.push(Line::from(Span::styled(
                line.to_owned(),
                Style::new().fg(CODE),
            )));
        } else if let Some(heading) = heading(line) {
            out.push(Line::from(inline(
                heading,
                Style::new().add_modifier(Modifier::BOLD),
            )));
        } else if let Some(item) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
            let mut spans = vec![Span::raw("• ")];
            spans.extend(inline(item, Style::new()));
            out.push(Line::from(spans));
        } else {
            out.push(Line::from(inline(line, Style::new())));
        }
    }
    out
}

/// A heading's text, without its `#`s.
fn heading(line: &str) -> Option<&str> {
    let text = line.trim_start_matches('#');
    (text.len() < line.len() && text.starts_with(' ')).then(|| text.trim_start())
}

/// `text` split into spans at `code` and **bold**, on top of `base`. An unclosed marker is text.
fn inline(text: &str, base: Style) -> Vec<Span<'static>> {
    let mut spans = Vec::new();
    let mut rest = text;
    loop {
        let code = rest.find('`');
        let bold = rest.find("**");
        let (at, marker, style) = match (code, bold) {
            (Some(c), Some(b)) if b < c => (b, "**", base.add_modifier(Modifier::BOLD)),
            (Some(c), _) => (c, "`", base.fg(CODE)),
            (None, Some(b)) => (b, "**", base.add_modifier(Modifier::BOLD)),
            (None, None) => break,
        };
        let after = &rest[at + marker.len()..];
        let Some(end) = after.find(marker) else { break };
        if at > 0 {
            spans.push(Span::styled(rest[..at].to_owned(), base));
        }
        spans.push(Span::styled(after[..end].to_owned(), style));
        rest = &after[end + marker.len()..];
    }
    if !rest.is_empty() {
        spans.push(Span::styled(rest.to_owned(), base));
    }
    spans
}
