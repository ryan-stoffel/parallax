//! What `plxd tui` puts on the screen, and where, for clicks: the header, the transcript with
//! each run of tool calls folded into one line, the sidebar, the lists below the prompt, the
//! prompt or a permission request, and the status line.

use jiff::Timestamp;
use jiff::tz::TimeZone;
use parallax_protocol::{AgentEffort, AgentToolStatus};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Margin, Position, Rect};
use ratatui::style::{Color, Style, Stylize as _};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Clear, Paragraph, Wrap};
use unicode_width::{UnicodeWidthChar as _, UnicodeWidthStr as _};

use super::transcript::{Entry, Pending};
use super::{App, Hits, MENU_ROWS, Menu, effort_name, markdown, mode_name, summary, tilde};

/// The app's mark, `ParallaxMark`, in dark mode: its two circles and their overlap.
const MARK_BLUE: [u8; 3] = [0x2b, 0x5c, 0xff];
const MARK_CORAL: [u8; 3] = [0xff, 0x4a, 0x1f];
const MARK_OVERLAP: [u8; 3] = [0xe4, 0xe4, 0xe7];
pub(super) const BLUE: Color = Color::Rgb(MARK_BLUE[0], MARK_BLUE[1], MARK_BLUE[2]);
const CORAL: Color = Color::Rgb(MARK_CORAL[0], MARK_CORAL[1], MARK_CORAL[2]);

/// The logo's width and height in pixels: 18 columns, and 9 rows of two pixels each, enough for
/// its circles to read as circles.
const LOGO_PIXELS: u16 = 18;

/// The band behind the user's messages, as Claude Code marks them.
const USER_BG: Color = Color::Rgb(0x3a, 0x35, 0x3e);

/// The spinner's frames, Claude Code's.
const SPINNER: [&str; 6] = ["·", "✢", "✳", "✶", "✻", "✽"];

/// The sidebar's width, as far as the terminal allows.
const SIDEBAR_WIDTH: u16 = 48;

impl App {
    pub(super) fn draw(&self, frame: &mut Frame) {
        let area = frame.area().inner(Margin::new(1, 0));
        let notice = self
            .notice
            .as_deref()
            .map_or(0, |text| text.lines().count() + 1);
        let pending = self.pending();
        let prompt_rows = match pending {
            Some(pending) if pending.always => 7,
            Some(_) => 6,
            None => self.input_lines(area.width).len(),
        };
        let suggestions = self.suggestions();
        let mentions = self.mentions();
        let below = match &self.menu {
            Some(menu) if !menu.sidebar() => menu.items.len().min(MENU_ROWS) + 1,
            _ if !suggestions.is_empty() => suggestions.len(),
            _ if !mentions.is_empty() => mentions.len(),
            _ => 2,
        };
        let rows = |n: usize| Constraint::Length(u16::try_from(n).unwrap_or(u16::MAX));
        let [
            body,
            notice_area,
            spinner,
            meta,
            top_rule,
            prompt,
            bottom_rule,
            footer,
        ] = Layout::vertical([
            Constraint::Fill(1),
            rows(notice),
            rows(usize::from(self.working_since.is_some())),
            rows(1),
            rows(1),
            rows(prompt_rows),
            rows(1),
            rows(below),
        ])
        .areas(area);
        self.draw_transcript(frame, body);
        if let Some(text) = &self.notice {
            let lines: Vec<Line> = text
                .lines()
                .map(|line| Line::from(line).dark_gray())
                .collect();
            frame.render_widget(Paragraph::new(lines), notice_area);
        }
        if let Some(since) = self.working_since {
            let line = Line::from(vec![
                Span::from(format!("{} Working… ", SPINNER[self.frame % SPINNER.len()])).fg(CORAL),
                Span::from(format!(
                    "({} · esc to interrupt)",
                    duration(since.elapsed().as_secs())
                ))
                .dark_gray(),
            ]);
            frame.render_widget(Paragraph::new(line), spinner);
        }
        self.draw_meta(frame, meta);
        let rule = Paragraph::new("─".repeat(usize::from(area.width))).dark_gray();
        frame.render_widget(rule.clone(), top_rule);
        frame.render_widget(rule, bottom_rule);
        match pending {
            Some(pending) => self.draw_approval(frame, prompt, pending),
            None => self.draw_prompt(frame, prompt),
        }
        self.draw_below(frame, footer, &suggestions, &mentions);
    }

    /// Below the prompt: a list being picked from, the commands `/` lists, the paths `@` lists,
    /// or the status line. The sidebar draws over everything else.
    fn draw_below(
        &self,
        frame: &mut Frame,
        footer: Rect,
        suggestions: &[(&'static str, &'static str)],
        mentions: &[String],
    ) {
        match &self.menu {
            Some(menu) if menu.sidebar() => {
                self.draw_footer(frame, footer);
                self.draw_sidebar(frame, menu);
            }
            Some(menu) => draw_menu(frame, footer, menu),
            None if !suggestions.is_empty() => {
                let selected = self.slash.min(suggestions.len() - 1);
                let lines: Vec<Line> = suggestions
                    .iter()
                    .enumerate()
                    .map(|(i, &(name, what))| {
                        let line = Line::from(vec![
                            Span::from(format!("{name:<10} ")).fg(BLUE),
                            Span::from(what).dark_gray(),
                        ]);
                        if i == selected {
                            line.bold().reversed()
                        } else {
                            line
                        }
                    })
                    .collect();
                frame.render_widget(Paragraph::new(lines), footer);
            }
            // As Claude Code lists them after `@`.
            None if !mentions.is_empty() => {
                let selected = self.mention.min(mentions.len() - 1);
                let lines: Vec<Line> = mentions
                    .iter()
                    .enumerate()
                    .map(|(i, path)| {
                        let line = Line::from(format!("  + {path}"));
                        if i == selected {
                            line.fg(BLUE).bold()
                        } else {
                            line
                        }
                    })
                    .collect();
                frame.render_widget(Paragraph::new(lines), footer);
            }
            None => self.draw_footer(frame, footer),
        }
    }

    /// The header: the mark beside the version, the model, the provider and mode, and where
    /// the thread works, by its folder when it has one on this computer.
    /// Each line fits in `width`, so a long title can't wrap under the mark.
    fn header(&self, width: u16) -> Vec<Line<'static>> {
        let provider = self
            .provider()
            .map_or_else(|| "host default".to_owned(), |id| self.provider_name(id));
        let title = match &self.open {
            Some(open) => self.title(open.run),
            None => "new thread".to_owned(),
        };
        let place = self
            .folder()
            .map_or_else(|| self.place(), |folder| tilde(&folder));
        let effort = self.effort.or_else(|| self.open_run()?.effort);
        let text = [
            vec![],
            vec![],
            vec![
                Span::from("Parallax ").bold(),
                Span::from(format!("v{}", crate::version())).dark_gray(),
            ],
            vec![
                Span::from(self.model_label()).bold().fg(Color::White),
                Span::from(format!(
                    " · {} effort",
                    effort.map_or("default", effort_name)
                ))
                .dark_gray(),
            ],
            vec![Span::from(format!("{provider} · {}", mode_name(self.mode()))).dark_gray()],
            vec![Span::from(format!("{place} › {title}")).dark_gray()],
            vec![Span::from("/ for commands · @ for files · ← for threads").dark_gray()],
            vec![],
            vec![],
        ];
        self.logo
            .iter()
            .cloned()
            .zip(text)
            .map(|(mut mark, text)| {
                mark.push(Span::raw("   "));
                let mut room = usize::from(width).saturating_sub(usize::from(LOGO_PIXELS) + 3);
                for span in text {
                    let clipped = clip(&span.content, room);
                    room = room.saturating_sub(clipped.width());
                    mark.push(Span::styled(clipped, span.style));
                }
                Line::from(mark)
            })
            .collect()
    }

    /// The header and the open thread, scrolled to the end less [`App::scroll`]. Each run of
    /// tool calls is one block, and where each lands is kept for clicks.
    fn draw_transcript(&self, frame: &mut Frame, area: Rect) {
        let mut header = self.header(area.width);
        header.push(Line::default());
        let mut blocks: Vec<(Option<usize>, Vec<Line>)> = vec![(None, header)];
        if self.open.is_none()
            && let Some(why) = &self.not_here
        {
            let why = Line::from(format!("  {why}")).dark_gray().italic();
            blocks.push((None, vec![why, Line::default()]));
        }
        if let Some(open) = &self.open {
            let entries = &open.transcript.entries;
            let mut i = 0;
            while i < entries.len() {
                let tools = entries[i..]
                    .iter()
                    .take_while(|entry| matches!(entry, Entry::Tool { .. }))
                    .count();
                let (key, mut lines, next) = if tools > 0 {
                    // A click flips a run from what Ctrl+O set for all.
                    let opened = self.expand_all != self.expanded.contains(&i);
                    let run = tool_run(&entries[i..i + tools], opened, area.width);
                    (Some(i), run, i + tools)
                } else {
                    (None, entry_lines(&entries[i], area.width), i + 1)
                };
                lines.push(Line::default());
                blocks.push((key, lines));
                i = next;
            }
        }
        if let Some(error) = &self.error {
            blocks.push((None, vec![Line::from(format!("  ⎿  {error}")).red()]));
        }
        let mut row: u16 = 0;
        let mut tools = Vec::new();
        let mut lines = Vec::new();
        for (key, block) in blocks {
            let height = Paragraph::new(block.clone())
                .wrap(Wrap { trim: false })
                .line_count(area.width);
            let height = u16::try_from(height).unwrap_or(u16::MAX);
            if let Some(key) = key {
                tools.push((row, row.saturating_add(height), key));
            }
            row = row.saturating_add(height);
            lines.extend(block);
        }
        let top = row.saturating_sub(area.height.saturating_add(self.scroll));
        let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
        frame.render_widget(paragraph.scroll((top, 0)), area);
        *self.hits.borrow_mut() = Hits {
            transcript: area,
            top,
            max_scroll: row.saturating_sub(area.height),
            tools,
            sidebar: None,
        };
    }

    /// The sidebar over the left of the screen, as the app lists threads: headings with their
    /// folders, then threads with their ages, the selected one highlighted.
    fn draw_sidebar(&self, frame: &mut Frame, menu: &Menu) {
        let full = frame.area();
        let area = Rect {
            width: SIDEBAR_WIDTH.min(full.width),
            ..full
        };
        frame.render_widget(Clear, area);
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(BLUE))
            .title(Line::from(" Threads ").bold())
            .title_bottom(Line::from(" ↑↓ move · enter open · n new · esc ").dark_gray());
        let inner = block.inner(area);
        frame.render_widget(block, area);
        let width = usize::from(inner.width);
        // Each item's line, with a blank line above each heading but the first.
        let mut rows: Vec<(Line, Option<usize>)> = Vec::new();
        for (i, item) in menu.items.iter().enumerate() {
            let selected = i == menu.selected;
            let line = if item.heading {
                if !rows.is_empty() {
                    rows.push((Line::default(), None));
                }
                let room = width.saturating_sub(item.label.width() + 3);
                Line::from(vec![
                    Span::from(format!(" {}", item.label)).bold(),
                    Span::from(format!("  {}", clip(&item.detail, room))).dark_gray(),
                ])
            } else {
                let dot = if item.working {
                    Span::from(" ● ").fg(CORAL)
                } else {
                    Span::from("   ")
                };
                // The age always shows: the title gives way.
                let room = width.saturating_sub(item.detail.width() + 5);
                let title = clip(&item.label, room);
                let pad = room.saturating_sub(title.width());
                let mut label = Span::from(format!("{title}{}", " ".repeat(pad)));
                if item.current && !selected {
                    label = label.bold().fg(Color::Cyan);
                }
                Line::from(vec![
                    dot,
                    label,
                    Span::from(format!(" {} ", item.detail)).dark_gray(),
                ])
            };
            let line = if selected {
                let pad = width.saturating_sub(line.width());
                let mut line = line;
                line.spans.push(Span::raw(" ".repeat(pad)));
                line.style(Style::new().bg(BLUE).fg(Color::White))
            } else {
                line
            };
            rows.push((line, Some(i)));
        }
        // Keeps the selected row on screen.
        let at = rows
            .iter()
            .position(|(_, item)| *item == Some(menu.selected))
            .unwrap_or(0);
        let height = usize::from(inner.height);
        let skip = (at + 1).saturating_sub(height);
        let mut hits = Vec::new();
        let mut shown = Vec::new();
        for (y, (line, item)) in (inner.y..).zip(rows.into_iter().skip(skip).take(height)) {
            if let Some(item) = item {
                hits.push((y, item));
            }
            shown.push(line);
        }
        frame.render_widget(Paragraph::new(shown), inner);
        self.hits.borrow_mut().sidebar = Some((area, hits));
    }

    /// Above the prompt: what the next message changes on the left, the effort on the right.
    fn draw_meta(&self, frame: &mut Frame, area: Rect) {
        let changes: Vec<String> = [
            self.provider.as_deref().map(|id| self.provider_name(id)),
            self.model.as_ref().map(|_| self.model_label()),
            self.effort
                .map(|effort| format!("{} effort", effort_name(effort))),
            self.permission.map(|mode| mode_name(mode).to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !changes.is_empty() {
            let left = format!("next message: {}", changes.join(" · "));
            frame.render_widget(Paragraph::new(left).fg(BLUE), area);
        }
        let effort = self
            .effort
            .or_else(|| self.open_run()?.effort)
            .unwrap_or(AgentEffort::Unknown);
        let symbol = match effort {
            AgentEffort::Low => "○",
            AgentEffort::High => "●",
            AgentEffort::Xhigh | AgentEffort::Max => "◉",
            _ => "◐",
        };
        let right = format!("{symbol} {} · /effort", effort_name(effort));
        frame.render_widget(Paragraph::new(right).dark_gray().right_aligned(), area);
    }

    pub(super) fn sidebar_open(&self) -> bool {
        self.menu.as_ref().is_some_and(Menu::sidebar)
    }

    /// The prompt's text in lines as wide as the prompt, less its `› `.
    pub(super) fn input_lines(&self, width: u16) -> Vec<String> {
        let width = usize::from(width.saturating_sub(2)).max(1);
        let mut lines = Vec::new();
        // ponytail: wraps by chars, so wide characters can overflow a line; measure display
        // widths if that shows.
        for line in self.input.split('\n') {
            let chars: Vec<char> = line.chars().collect();
            if chars.is_empty() {
                lines.push(String::new());
            }
            lines.extend(
                chars
                    .chunks(width)
                    .map(|chunk| chunk.iter().collect::<String>()),
            );
        }
        lines
    }

    fn draw_prompt(&self, frame: &mut Frame, area: Rect) {
        if self.input.is_empty() {
            let placeholder = match &self.open {
                Some(_) => "Reply, add detail, or steer what it does next".to_owned(),
                None => format!("Start a new thread in {}", self.place()),
            };
            let line = Line::from(vec![
                Span::from("› ").bold(),
                Span::from(placeholder).dark_gray(),
            ]);
            frame.render_widget(Paragraph::new(line), area);
            if !self.sidebar_open() {
                frame.set_cursor_position(Position::new(area.x + 2, area.y));
            }
            return;
        }
        let lines = self.input_lines(area.width);
        let last = lines.len() - 1;
        let cursor_x = u16::try_from(lines[last].chars().count()).unwrap_or(0);
        let shown: Vec<Line> = lines
            .into_iter()
            .enumerate()
            .map(|(i, line)| Line::from(format!("{}{line}", if i == 0 { "› " } else { "  " })))
            .collect();
        frame.render_widget(Paragraph::new(shown), area);
        let y = u16::try_from(last).unwrap_or(0);
        if !self.sidebar_open() {
            frame.set_cursor_position(Position::new(area.x + 2 + cursor_x, area.y + y));
        }
    }

    /// A permission request, in place of the prompt, as Claude Code asks.
    fn draw_approval(&self, frame: &mut Frame, area: Rect, pending: &Pending) {
        let mut answers = vec!["Yes"];
        if pending.always {
            answers.push("Yes, and don't ask again this session");
        }
        answers.push("No");
        let mut lines = vec![
            Line::from(vec![
                Span::from(pending.tool_name.clone()).bold(),
                Span::from(format!("  {}", pending.detail)).dark_gray(),
            ]),
            Line::from("Do you want to proceed?"),
        ];
        for (i, answer) in answers.iter().enumerate() {
            lines.push(if i == self.choice(pending) {
                Line::from(format!("❯ {}. {answer}", i + 1)).fg(BLUE).bold()
            } else {
                Line::from(format!("  {}. {answer}", i + 1))
            });
        }
        let block = Block::bordered()
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(CORAL));
        frame.render_widget(Paragraph::new(lines).block(block), area);
    }

    fn draw_footer(&self, frame: &mut Frame, area: Rect) {
        let transcript = self.open.as_ref().map(|open| &open.transcript);
        let context = transcript
            .and_then(|transcript| transcript.context)
            .map_or(0, |(tokens, window)| tokens * 100 / window.max(1));
        let cost = transcript.map_or(0, |transcript| transcript.cost_micros);
        let dot = || Span::from(" · ").dark_gray();
        let provider = self
            .provider()
            .map_or_else(|| "host default".to_owned(), |id| self.provider_name(id));
        let first = Line::from(vec![
            Span::from(self.model_label()).bold(),
            dot(),
            Span::from(provider),
            dot(),
            Span::from(self.place()).fg(Color::Green),
            dot(),
            Span::from(format!("ctx {context}%")).fg(Color::Yellow),
            dot(),
            Span::from(format!(
                "${}.{:02}",
                cost / 1_000_000,
                cost % 1_000_000 / 10_000
            )),
        ]);
        let second = if self.quitting {
            Line::from("Press Ctrl-C again to exit").dark_gray()
        } else {
            Line::from(vec![
                Span::from(format!("▸▸ {} on ", mode_name(self.mode()))).fg(CORAL),
                Span::from("(shift+tab to cycle) · / for commands · ← for threads").dark_gray(),
            ])
        };
        frame.render_widget(Paragraph::new(vec![first, second]), area);
    }
}

/// A list below the prompt: its title and keys, then up to [`MENU_ROWS`] rows around the
/// selected one, with `❯` at the selected and `✓` at the current.
fn draw_menu(frame: &mut Frame, area: Rect, menu: &Menu) {
    let mut lines = vec![Line::from(vec![
        Span::from(format!("{}  ", menu.title)).bold(),
        Span::from("↑↓ choose · enter pick · esc close").dark_gray(),
    ])];
    let first = menu
        .selected
        .saturating_sub(MENU_ROWS - 1)
        .min(menu.items.len().saturating_sub(MENU_ROWS));
    let width = menu
        .items
        .iter()
        .map(|item| item.label.chars().count())
        .max()
        .unwrap_or(0);
    for (i, item) in menu.items.iter().enumerate().skip(first).take(MENU_ROWS) {
        let selected = i == menu.selected;
        let mut line = Line::from(vec![
            Span::from(if selected { "❯ " } else { "  " }).fg(BLUE),
            Span::from(format!("{:<width$}", item.label)),
            Span::from(if item.current { " ✓" } else { "  " }).fg(Color::Green),
            Span::from(format!("  {}", item.detail)).dark_gray(),
        ]);
        if selected {
            line = line.fg(BLUE).bold();
        }
        lines.push(line);
    }
    frame.render_widget(Paragraph::new(lines), area);
}

/// The app's mark in [`LOGO_PIXELS`] square pixels, two to a terminal row with `▀` and `▄`.
/// Its circles are `ParallaxMark`'s: radius 7 at (9.5, 9.5) and (14.5, 14.5), here cropped to
/// their bounds. Each pixel is sampled 8 × 8 times. One at least half covered takes the mix of
/// the colors over it, which smooths where the circles meet.
pub(super) fn logo() -> Vec<Vec<Span<'static>>> {
    const SAMPLES: u16 = 8;
    const LOW: f64 = 2.5;
    const SIDE: f64 = 19.0;
    let at = |pixel: u16, sample: u16| {
        let offset = (f64::from(sample) + 0.5) / f64::from(SAMPLES);
        LOW + SIDE * (f64::from(pixel) + offset) / f64::from(LOGO_PIXELS)
    };
    let pixel = |x: u16, y: u16| {
        let mut sum = [0u32; 3];
        let mut hits = 0;
        for (a, b) in (0..SAMPLES).flat_map(|a| (0..SAMPLES).map(move |b| (a, b))) {
            let (px, py) = (at(x, a), at(y, b));
            let inside = |center: f64| (px - center).powi(2) + (py - center).powi(2) <= 49.0;
            let color = match (inside(9.5), inside(14.5)) {
                (true, true) => MARK_OVERLAP,
                (true, false) => MARK_BLUE,
                (false, true) => MARK_CORAL,
                (false, false) => continue,
            };
            hits += 1;
            for (total, part) in sum.iter_mut().zip(color) {
                *total += u32::from(part);
            }
        }
        let mix = |total: u32| u8::try_from(total / hits.max(1)).unwrap_or(u8::MAX);
        (hits * 2 >= u32::from(SAMPLES * SAMPLES))
            .then(|| Color::Rgb(mix(sum[0]), mix(sum[1]), mix(sum[2])))
    };
    (0..LOGO_PIXELS / 2)
        .map(|row| {
            (0..LOGO_PIXELS)
                .map(|x| match (pixel(x, row * 2), pixel(x, row * 2 + 1)) {
                    (Some(up), Some(down)) => Span::styled("▀", Style::new().fg(up).bg(down)),
                    (Some(up), None) => Span::styled("▀", Style::new().fg(up)),
                    (None, Some(down)) => Span::styled("▄", Style::new().fg(down)),
                    (None, None) => Span::raw(" "),
                })
                .collect()
        })
        .collect()
}

/// A run of tool calls as Claude Code folds it: one line summing it up, then once opened, each
/// call with what it returned. Its dot is yellow while one runs, red when one failed, and green
/// once all are done.
fn tool_run(tools: &[Entry], opened: bool, width: u16) -> Vec<Line<'static>> {
    let names = tools.iter().filter_map(|entry| match entry {
        Entry::Tool { name, .. } => Some(name.as_str()),
        _ => None,
    });
    let running = tools
        .iter()
        .any(|entry| matches!(entry, Entry::Tool { status: None, .. }));
    let failed = tools.iter().any(|entry| {
        matches!(entry, Entry::Tool { status: Some(status), .. } if *status != AgentToolStatus::Ok)
    });
    let color = if running {
        Color::Yellow
    } else if failed {
        Color::Red
    } else {
        Color::Green
    };
    let mut head = vec![Span::from("● ").fg(color), Span::from(summary(names))];
    if opened {
        let mut lines = vec![Line::from(head)];
        for tool in tools {
            lines.extend(entry_lines(tool, width).into_iter().map(|mut line| {
                line.spans.insert(0, Span::raw("  "));
                line
            }));
        }
        return lines;
    }
    if running && let Some(Entry::Tool { name, detail, .. }) = tools.last() {
        head.push(Span::from(format!(" · {}", call(name, detail))).dark_gray());
    }
    head.push(Span::from("  (click or ctrl+o to expand)").dark_gray());
    vec![Line::from(head)]
}

/// The lines an entry shows, `width` columns wide, as Claude Code lays them out: a message on a
/// band after `❯`, `●` before a reply or a tool call, `⎿` before what the tool returned, and `✻`
/// after a turn.
fn entry_lines(entry: &Entry, width: u16) -> Vec<Line<'static>> {
    match entry {
        // Wrapped here, so the band fills each row to the edge.
        Entry::User(text) => {
            let width = usize::from(width).max(3);
            let band = Style::new().bg(USER_BG).fg(Color::White);
            text.lines()
                .flat_map(|line| wrap(line, width - 2))
                .enumerate()
                .map(|(i, row)| {
                    let prefix = if i == 0 { "❯ " } else { "  " };
                    let pad = (width - 2).saturating_sub(row.width());
                    Line::from(format!("{prefix}{row}{}", " ".repeat(pad))).style(band)
                })
                .collect()
        }
        Entry::Assistant { text, .. } => markdown::lines(text)
            .into_iter()
            .enumerate()
            .map(|(i, mut line)| {
                let prefix = if i == 0 { "● " } else { "  " };
                line.spans.insert(0, Span::raw(prefix));
                line
            })
            .collect(),
        Entry::Tool {
            name,
            detail,
            status,
            output,
            ..
        } => {
            let color = match status {
                Some(AgentToolStatus::Ok) => Color::Green,
                Some(_) => Color::Red,
                None => Color::Yellow,
            };
            let mut lines = vec![Line::from(vec![
                Span::from("● ").fg(color),
                Span::from(call(name, detail)).bold(),
            ])];
            if let Some(output) = output {
                lines.push(Line::from(format!("  ⎿  {output}")).dark_gray());
            }
            lines
        }
        Entry::Note(text) => vec![Line::from(format!("  {text}")).dark_gray().italic()],
        Entry::Done { secs, at } => {
            let worked = if *secs == 0 {
                String::new()
            } else {
                format!("Worked for {} · ", duration(*secs))
            };
            vec![Line::from(format!("✻ {worked}done {}", clock(*at))).dark_gray()]
        }
    }
}

/// A tool call as `Name(what it does)`.
fn call(name: &str, detail: &str) -> String {
    if detail.is_empty() {
        name.to_owned()
    } else {
        format!("{name}({detail})")
    }
}

/// `secs` as Claude Code counts a turn: 11s, or 2m 5s.
fn duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

/// `at` on this computer's clock, such as 4:36 PM.
fn clock(at: Timestamp) -> String {
    at.to_zoned(TimeZone::system())
        .strftime("%-I:%M %p")
        .to_string()
}

/// `text` cut to `room` columns, with `…` when it was wider.
fn clip(text: &str, room: usize) -> String {
    if text.width() <= room {
        return text.to_owned();
    }
    if room == 0 {
        return String::new();
    }
    let mut clipped = String::new();
    let mut used = 0;
    for c in text.chars() {
        let width = c.width().unwrap_or(0);
        if used + width + 1 > room {
            break;
        }
        used += width;
        clipped.push(c);
    }
    clipped.push('…');
    clipped
}

/// `line` in rows at most `width` columns wide, broken between words, and inside a word only
/// when it's wider than a row. An empty line is one empty row.
fn wrap(line: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = vec![String::new()];
    for word in line.split(' ') {
        let row = rows.last_mut().expect("rows starts with one");
        let gap = usize::from(!row.is_empty());
        if row.width() + gap + word.width() <= width {
            if gap == 1 {
                row.push(' ');
            }
            row.push_str(word);
            continue;
        }
        let mut row = String::new();
        for c in word.chars() {
            if row.width() + c.width().unwrap_or(0) > width {
                rows.push(std::mem::take(&mut row));
            }
            row.push(c);
        }
        rows.push(row);
    }
    if rows.len() > 1 && rows[0].is_empty() {
        rows.remove(0);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::{clip, duration, tool_run, wrap};
    use crate::tui::transcript::Entry;

    fn tool(name: &str, status: Option<parallax_protocol::AgentToolStatus>) -> Entry {
        Entry::Tool {
            call_id: name.to_owned(),
            name: name.to_owned(),
            detail: "ls".to_owned(),
            status,
            output: Some("out".to_owned()),
        }
    }

    #[test]
    fn a_tool_run_folds_into_one_line_until_opened() {
        let tools = [
            tool("Bash", Some(parallax_protocol::AgentToolStatus::Ok)),
            tool("Read", None),
        ];
        let folded: Vec<String> = tool_run(&tools, false, 80)
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(
            folded,
            ["● Ran 1 shell command, read 1 file · Read(ls)  (click or ctrl+o to expand)"]
        );
        let opened = tool_run(&tools, true, 80);
        assert_eq!(
            opened.len(),
            5,
            "the summary, then each call and its output"
        );
        assert_eq!(opened[1].to_string(), "  ● Bash(ls)");
    }

    #[test]
    fn durations_and_clipping() {
        assert_eq!([duration(11), duration(125)], ["11s", "2m 5s"]);
        assert_eq!([clip("abc", 3), clip("abcdef", 4)], ["abc", "abc…"]);
        assert_eq!(clip("日本語の", 5), "日本…", "by columns, not chars");
    }

    #[test]
    fn wrapping_breaks_between_words() {
        assert_eq!(
            wrap("write a file and delete it", 12),
            ["write a file", "and delete", "it"]
        );
        assert_eq!(wrap("abcdefgh", 3), ["abc", "def", "gh"]);
        assert_eq!(wrap("", 5), [""]);
    }
}
