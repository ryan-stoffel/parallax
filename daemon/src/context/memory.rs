//! Memory entries in a scope's context folder (0044, PLX-405): `memory/<kind>/<slug>.md`, whose
//! first lines are its kind, title, source, date, and writer, then a blank line and the body.
//! plxd writes the header, and reads it back leniently, since the user may edit a file anywhere.
//!
//! A proposal, `proposals/<slug>.md`, has the same form. A Project child's also names the scope
//! it is for (`Scope:`), and waits in the Project's folder until its coordinator's next wake-up
//! carries it ([`pending`]).

use std::fmt::Write as _;
use std::path::Path;

use parallax_protocol::MemoryKind;

/// The header's fields, in the order they are written.
const FIELDS: [&str; 5] = ["Kind", "Title", "Source", "Date", "Writer"];

/// An entry's header, as read back from its file. A field the file lacks is `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Header {
    pub kind: Option<MemoryKind>,
    pub title: Option<String>,
    pub source: Option<String>,
    pub date: Option<String>,
    pub writer: Option<String>,
    /// The scope a child's proposal is for: `you`, `repo`, or `project`.
    pub scope: Option<String>,
}

/// The folder name of `kind`, or `None` for one this plxd doesn't know.
pub(crate) fn kind_name(kind: MemoryKind) -> Option<&'static str> {
    match kind {
        MemoryKind::Preference => Some("preference"),
        MemoryKind::Convention => Some("convention"),
        MemoryKind::Decision => Some("decision"),
        MemoryKind::Gotcha => Some("gotcha"),
        MemoryKind::Unknown => None,
    }
}

/// The kind of the entry at `path`, if it is one: `memory/<kind>/<file>`.
pub(crate) fn entry_kind(path: &str) -> Option<MemoryKind> {
    let mut parts = path.split('/');
    let (Some("memory"), Some(kind), Some(_), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    parse_kind(kind)
}

fn parse_kind(name: &str) -> Option<MemoryKind> {
    [
        MemoryKind::Preference,
        MemoryKind::Convention,
        MemoryKind::Decision,
        MemoryKind::Gotcha,
    ]
    .into_iter()
    .find(|kind| kind_name(*kind) == Some(name))
}

/// An entry's file: the header, a blank line, then `body`, with a `Scope:` line last in the
/// header when `scope` is given. Each value is one line: a line break in one becomes a space.
pub(crate) fn render(
    kind: MemoryKind,
    title: &str,
    source: &str,
    date: &str,
    writer: &str,
    scope: Option<&str>,
    body: &str,
) -> String {
    let kind = kind_name(kind).unwrap_or_default();
    let values = [kind, title, source, date, writer];
    let mut text = String::new();
    let scope = scope.map(|scope| ("Scope", scope));
    for (field, value) in FIELDS.iter().copied().zip(values).chain(scope) {
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        let _ = writeln!(text, "{field}: {value}");
    }
    text.push('\n');
    text.push_str(body);
    text
}

/// Reads the header at the start of `content`, and returns it with the body after it. The header
/// ends at the first blank line, or at the first line that isn't a known `Field: value`; content
/// with no header at all is all body.
pub(crate) fn parse(content: &str) -> (Header, &str) {
    let mut header = Header::default();
    let mut rest = content;
    while !rest.is_empty() {
        let (line, after) = rest.split_once('\n').unwrap_or((rest, ""));
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            rest = after;
            break;
        }
        let Some((field, value)) = line.split_once(':') else {
            break;
        };
        let value = Some(value.trim().to_owned());
        match field {
            "Kind" => header.kind = value.as_deref().and_then(parse_kind),
            "Title" => header.title = value,
            "Source" => header.source = value,
            "Date" => header.date = value,
            "Writer" => header.writer = value,
            "Scope" => header.scope = value,
            _ => break,
        }
        rest = after;
    }
    if header == Header::default() {
        return (header, content);
    }
    (header, rest)
}

/// The child proposals waiting in Project folder `dir`, each with its path and the lines a
/// coordinator's wake-up shows for it, oldest path first. A file that can't be read is skipped,
/// and stays for the next wake-up.
pub(crate) fn pending(dir: &Path) -> Vec<(String, String)> {
    let Ok(files) = super::list_files(dir) else {
        return Vec::new();
    };
    let mut pending = Vec::new();
    for (path, _) in files {
        if !path.starts_with("proposals/") {
            continue;
        }
        let Some(text) = super::read_file(dir, &path)
            .ok()
            .and_then(|(bytes, _)| String::from_utf8(bytes).ok())
        else {
            continue;
        };
        let (header, body) = parse(&text);
        let quoted: Vec<String> = body
            .trim()
            .lines()
            .map(|line| format!("  > {line}"))
            .collect();
        let line = format!(
            "- Proposal from {}: a {} memory entry for the {} scope, \"{}\". Check it against \
             memory_read, then save it with memory_write or drop it:\n{}",
            header.source.as_deref().unwrap_or("a thread"),
            header.kind.and_then(kind_name).unwrap_or("memory"),
            header.scope.as_deref().unwrap_or("project"),
            header.title.as_deref().unwrap_or(&path),
            quoted.join("\n")
        );
        pending.push((path, line));
    }
    pending
}

/// A file name for `title`: lowercase ASCII letters and digits, with `-` between words, at most
/// 60 bytes, or `entry` if nothing is left.
pub(crate) fn slug(title: &str) -> String {
    let mut slug = String::new();
    for word in title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        if slug.len() + word.len() + 1 > 60 {
            break;
        }
        if !slug.is_empty() {
            slug.push('-');
        }
        slug.push_str(&word.to_ascii_lowercase());
    }
    if slug.is_empty() {
        "entry".to_owned()
    } else {
        slug
    }
}

#[cfg(test)]
mod tests {
    use parallax_protocol::MemoryKind;

    use super::{Header, entry_kind, parse, render, slug};

    #[test]
    fn an_entry_reads_back_its_header_and_body() {
        let text = render(
            MemoryKind::Decision,
            "Use Vitest,\nnot Jest",
            "run 1",
            "2026-10-04",
            "user",
            Some("repo"),
            "We moved off Jest.\n",
        );
        assert_eq!(
            text,
            "Kind: decision\nTitle: Use Vitest, not Jest\nSource: run 1\nDate: 2026-10-04\n\
             Writer: user\nScope: repo\n\nWe moved off Jest.\n"
        );
        let (header, body) = parse(&text);
        assert_eq!(
            header,
            Header {
                kind: Some(MemoryKind::Decision),
                title: Some("Use Vitest, not Jest".to_owned()),
                source: Some("run 1".to_owned()),
                date: Some("2026-10-04".to_owned()),
                writer: Some("user".to_owned()),
                scope: Some("repo".to_owned()),
            }
        );
        assert_eq!(body, "We moved off Jest.\n");
    }

    #[test]
    fn a_file_without_a_header_is_all_body() {
        let (header, body) = parse("# Notes\nSee: the plan\n");
        assert_eq!(header, Header::default());
        assert_eq!(body, "# Notes\nSee: the plan\n");
        let (header, body) = parse("Title: Only a title");
        assert_eq!(header.title.as_deref(), Some("Only a title"));
        assert_eq!(body, "");
    }

    #[test]
    fn only_entry_paths_have_a_kind() {
        assert_eq!(
            entry_kind("memory/gotcha/flaky.md"),
            Some(MemoryKind::Gotcha)
        );
        assert_eq!(entry_kind("knowledge/x.md"), None);
        assert_eq!(entry_kind("memory/other/x.md"), None);
    }

    #[test]
    fn slugs_are_short_lowercase_words() {
        assert_eq!(slug("Use Vitest, not Jest!"), "use-vitest-not-jest");
        assert_eq!(slug("¿?"), "entry");
        assert!(slug(&"word ".repeat(40)).len() <= 60);
    }
}
