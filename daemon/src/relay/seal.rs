//! A push's title and text, sealed for the user's phones (0100), so the relay and Apple carry them
//! without reading them. A phone's notification service extension opens them
//! (`apps/mobile/plugins/notification-service/NotificationService.swift`).

use parallax_protocol::{AgentOutputItem, ParallaxEvent};
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, NONCE_LEN, Nonce, UnboundKey};
use serde_json::json;

use crate::remote::base64url;

/// The most characters of a title or a text, as the phone cuts a reply (`REPLY_CHARS`).
const MAX_CHARS: usize = 140;

/// `state`'s text: "Needs your approval", or the start of the run's reply, or what the state means
/// when it has none. As the phone's own notification says it (`apps/mobile/src/push.ts`).
pub(super) fn text_for(state: &str, reply: Option<String>) -> String {
    match state {
        "needsYou" => "Needs your approval".to_owned(),
        "failed" => reply.unwrap_or_else(|| "Failed".to_owned()),
        _ => reply.unwrap_or_else(|| "Finished".to_owned()),
    }
}

/// A prompt's first line, for a thread with no title, or "Image" for a prompt of images alone.
pub(super) fn first_line(prompt: &str) -> String {
    match prompt.trim().lines().next() {
        Some(line) if !line.is_empty() => line.to_owned(),
        _ => "Image".to_owned(),
    }
}

/// The start of the last reply in `events`, newest first, as plain text. It reads text as the
/// phone's transcript does (`apps/desktop/src/renderer/transcript.ts`): deltas build a message,
/// since some backends only stream, and a whole text or a turn's result replaces them.
pub(super) fn last_reply(events: impl Iterator<Item = ParallaxEvent>) -> Option<String> {
    let events: Vec<_> = events.collect();
    let items = events.into_iter().rev().flat_map(|event| match event {
        ParallaxEvent::AgentOutput { items, .. } => items,
        _ => Vec::new(),
    });
    let mut said: Option<(Option<String>, String)> = None;
    let mut streaming = false;
    for item in items {
        // A delta with no id continues only the delta right before it.
        let continues = std::mem::replace(&mut streaming, false);
        match item {
            AgentOutputItem::TextDelta { message_id, text } => {
                streaming = true;
                match &mut said {
                    Some((id, whole))
                        if (message_id.is_some() && *id == message_id)
                            || (message_id.is_none() && continues) =>
                    {
                        whole.push_str(&text);
                    }
                    _ => said = Some((message_id, text)),
                }
            }
            AgentOutputItem::Text { message_id, text } => said = Some((message_id, text)),
            AgentOutputItem::TurnFinished {
                result: Some(text), ..
            } if !text.trim().is_empty() => said = Some((None, text)),
            _ => {}
        }
    }
    said.and_then(|(_, text)| reply_text(&text))
}

/// Seals `title` and `text` for run `run` of host `host` reaching `state`: base64url of a random
/// nonce and the AES-256-GCM ciphertext. The host, run, and state are its associated data, so
/// nothing that opens it can show it for another push. `None` only if the OS has no random numbers.
pub(super) fn seal(
    key: &[u8; 32],
    host: &str,
    run: &str,
    state: &str,
    title: &str,
    text: &str,
) -> Option<String> {
    let mut nonce = [0; NONCE_LEN];
    getrandom::fill(&mut nonce).ok()?;
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).ok()?);
    let mut sealed = json!({ "title": cut(title), "text": cut(text) })
        .to_string()
        .into_bytes();
    key.seal_in_place_append_tag(
        Nonce::assume_unique_for_key(nonce),
        Aad::from(format!("{host}:{run}:{state}")),
        &mut sealed,
    )
    .ok()?;
    Some(base64url(&[&nonce[..], &sealed].concat()))
}

/// `markdown` as plain text on one line, as `replyText` in `apps/mobile/src/alerts.ts` makes it.
/// `None` when empty.
fn reply_text(markdown: &str) -> Option<String> {
    let plain: Vec<String> = markdown.lines().map(plain_line).collect();
    let text = plain
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty()).then_some(text)
}

/// One line of markdown without its fence, block marker, links' targets, and inline marks.
fn plain_line(line: &str) -> String {
    let line = line.split("```").next().unwrap_or_default();
    let mut text = without_links(without_block_marker(line));
    for mark in ["**", "__", "~~", "*"] {
        text = without_mark(&text, mark);
    }
    text.replace('`', "")
}

/// `line` after a heading's, quote's, or list item's marker.
fn without_block_marker(line: &str) -> &str {
    let line = line.trim_start();
    let spaced = |rest: &str| rest.starts_with(char::is_whitespace);
    let hashes = line.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && spaced(&line[hashes..]) {
        return &line[hashes..];
    }
    if let Some(rest) = line.strip_prefix('>') {
        return rest;
    }
    if line.starts_with(['-', '*', '+']) && spaced(&line[1..]) {
        return &line[1..];
    }
    let digits = line.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && line[digits..].starts_with('.') && spaced(&line[digits + 1..]) {
        return &line[digits + 1..];
    }
    line
}

/// `line` with each `[label](target)` and `![label](target)` as its label.
fn without_links(line: &str) -> String {
    let mut text = String::new();
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let found = rest[open + 1..].find("](").and_then(|middle| {
            let label = &rest[open + 1..open + 1 + middle];
            let target = &rest[open + 1 + middle + 2..];
            let end = target.find(')')?;
            (!label.contains(']')).then_some((label, &target[end + 1..]))
        });
        let before = &rest[..open];
        if let Some((label, after)) = found {
            text.push_str(before.strip_suffix('!').unwrap_or(before));
            text.push_str(label);
            rest = after;
        } else {
            text.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
        }
    }
    text.push_str(rest);
    text
}

/// `line` with each pair of `mark` around some text removed.
fn without_mark(line: &str, mark: &str) -> String {
    let mut text = String::new();
    let mut rest = line;
    while let Some(open) = rest.find(mark) {
        let inner = &rest[open + mark.len()..];
        let close = inner
            .char_indices()
            .skip(1)
            .find_map(|(at, _)| inner[at..].starts_with(mark).then_some(at));
        let Some(close) = close else { break };
        text.push_str(&rest[..open]);
        text.push_str(&inner[..close]);
        rest = &inner[close + mark.len()..];
    }
    text.push_str(rest);
    text
}

/// `text` cut to about [`MAX_CHARS`], at a word when one ends in its second half.
fn cut(text: &str) -> String {
    if text.chars().count() <= MAX_CHARS {
        return text.to_owned();
    }
    let cut: String = text.chars().take(MAX_CHARS).collect();
    let word = cut.char_indices().rev().find(|(_, c)| *c == ' ');
    let kept = match word {
        Some((at, _)) if cut[..at].chars().count() > MAX_CHARS / 2 => &cut[..at],
        _ => &cut[..],
    };
    format!("{}…", kept.trim_end())
}

/// What the phone does: opens `sealed` with `key` and the push's own `host:run:state`.
#[cfg(test)]
pub(super) fn open(key: &[u8; 32], aad: &str, sealed: &str) -> Option<serde_json::Value> {
    let bytes = crate::remote::base64url_decode(sealed)?;
    let (nonce, ciphertext) = bytes.split_at(NONCE_LEN);
    let key = LessSafeKey::new(UnboundKey::new(&AES_256_GCM, key).ok()?);
    let mut body = ciphertext.to_vec();
    let plain = key
        .open_in_place(
            Nonce::try_assume_unique_for_key(nonce).ok()?,
            Aad::from(aad),
            &mut body,
        )
        .ok()?;
    serde_json::from_slice(plain).ok()
}

#[cfg(test)]
mod tests {
    use parallax_protocol::RunId;

    use super::*;

    const KEY: [u8; 32] = [7; 32];

    #[test]
    fn a_sealed_push_opens_only_with_its_key_host_run_and_state() {
        let sealed = seal(&KEY, "host", "run", "done", "Fix the bug", "All done").unwrap();
        assert_eq!(
            open(&KEY, "host:run:done", &sealed).unwrap(),
            json!({ "title": "Fix the bug", "text": "All done" })
        );
        assert!(open(&[8; 32], "host:run:done", &sealed).is_none());
        for other in ["other:run:done", "host:other:done", "host:run:failed"] {
            assert!(open(&KEY, other, &sealed).is_none(), "{other}");
        }
        let again = seal(&KEY, "host", "run", "done", "Fix the bug", "All done").unwrap();
        assert_ne!(sealed, again, "each has its own nonce");
    }

    /// `MAX_SEALED` in `relay/src/host.ts`, which fits well under APNs' 4 KB with the rest.
    #[test]
    fn the_longest_sealed_push_fits_the_relays_cap() {
        for character in ["😀", "\u{1}", "\""] {
            let long = character.repeat(1000);
            let sealed = seal(&KEY, "host", "run", "done", &long, &long).unwrap();
            assert!(sealed.len() <= 2400, "{}", sealed.len());
        }
    }

    #[test]
    fn a_reply_is_plain_text_and_a_long_one_is_cut() {
        // The same cases as `replyText` in `apps/mobile/src/alerts.test.ts`.
        assert_eq!(
            reply_text(
                "## Done\n\n- **Fixed** the `foo_bar` bug in [the parser](https://x.dev/a)\n- *Added* a test\n```ts\nlet a;\n```"
            )
            .unwrap(),
            "Done Fixed the foo_bar bug in the parser Added a test let a;"
        );
        assert_eq!(reply_text(" \n ```\n```"), None);
        let long = cut(&"word ".repeat(100));
        assert!(long.ends_with("word…"), "{long}");
        assert!(long.chars().count() <= 141);
        assert_eq!(cut("short"), "short");
    }

    #[test]
    fn the_last_reply_is_the_newest_text() {
        let run = RunId::generate();
        let output = |items| ParallaxEvent::AgentOutput {
            run_id: run,
            items,
            compacted: None,
        };
        let text = |text: &str| AgentOutputItem::Text {
            message_id: None,
            text: text.to_owned(),
        };
        let thinking = AgentOutputItem::Reasoning {
            message_id: None,
            text: "hmm".to_owned(),
        };
        let newest_first = vec![
            output(vec![thinking.clone()]),
            output(vec![text("First"), text("**All** done"), thinking]),
            output(vec![text("Older")]),
        ];
        assert_eq!(
            last_reply(newest_first.into_iter()).as_deref(),
            Some("All done")
        );
        assert_eq!(last_reply(std::iter::empty()), None);
    }

    #[test]
    fn the_last_reply_reads_a_streamed_message_and_a_turns_result() {
        let run = RunId::generate();
        let output = |items| ParallaxEvent::AgentOutput {
            run_id: run,
            items,
            compacted: None,
        };
        let delta = |id: Option<&str>, text: &str| AgentOutputItem::TextDelta {
            message_id: id.map(str::to_owned),
            text: text.to_owned(),
        };
        let thinking = AgentOutputItem::Reasoning {
            message_id: None,
            text: "hmm".to_owned(),
        };
        let older = AgentOutputItem::Text {
            message_id: None,
            text: "Older".to_owned(),
        };
        let finished = |result: &str| AgentOutputItem::TurnFinished {
            turn_id: None,
            result: Some(result.to_owned()),
            cursor: None,
            session_id: None,
        };
        // Each case is in the order the agent said it.
        let reply = |items: Vec<Vec<AgentOutputItem>>| {
            let newest_first: Vec<_> = items.into_iter().rev().map(output).collect();
            last_reply(newest_first.into_iter())
        };

        // A backend that only streams, across events, and a message cut off after an older one.
        assert_eq!(
            reply(vec![
                vec![older.clone()],
                vec![delta(None, "Hel")],
                vec![delta(None, "lo")]
            ])
            .as_deref(),
            Some("Hello")
        );
        // Without an id, anything between deltas starts a new message. With one, it doesn't.
        assert_eq!(
            reply(vec![vec![
                delta(None, "First"),
                thinking.clone(),
                delta(None, "Second")
            ]])
            .as_deref(),
            Some("Second")
        );
        assert_eq!(
            reply(vec![vec![
                delta(Some("a"), "One "),
                thinking,
                delta(Some("a"), "message")
            ]])
            .as_deref(),
            Some("One message")
        );
        // A turn's result is the last thing said, unless it's blank.
        assert_eq!(
            reply(vec![vec![older.clone(), finished("Result")]]).as_deref(),
            Some("Result")
        );
        assert_eq!(
            reply(vec![vec![older, finished(" ")]]).as_deref(),
            Some("Older")
        );
    }

    #[test]
    fn a_state_says_its_own_text_without_a_reply() {
        assert_eq!(
            text_for("needsYou", Some("x".into())),
            "Needs your approval"
        );
        assert_eq!(text_for("done", None), "Finished");
        assert_eq!(text_for("failed", None), "Failed");
        assert_eq!(text_for("done", Some("x".into())), "x");
    }
}
