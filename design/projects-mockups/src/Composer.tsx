import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUp, AtSign, BookOpen, ChevronDown, GitBranch, MessageCircleQuestion, Paperclip, Server, ShieldCheck, Sparkles, X } from "lucide-react";
import { accounts, efforts, hosts, knowledgeFiles, models, permissionModes } from "./data";
import { useStore } from "./store";
import { Kbd, MenuItem, Popover, ProviderLogo, StatusGlyph } from "./ui";

export type ComposerMode = "task" | "ask";

interface Props {
  variant: "project" | "thread" | "child";
  onSubmit: (text: string, mode: ComposerMode) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

export function Composer({ variant, onSubmit, placeholder, autoFocus }: Props) {
  const { settings, setSettings, children, memory } = useStore();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ComposerMode>("task");
  const [focused, setFocused] = useState(false);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const mentionQuery = /(?:^|\s)@([\w-]*)$/.exec(text)?.[1];
  const mentions = useMemo(() => {
    if (mentionQuery === undefined) return [];
    const q = mentionQuery.toLowerCase();
    const items = [
      ...children.slice(0, 6).map((c) => ({ id: c.id, label: c.title, group: "Threads", status: c.status })),
      ...knowledgeFiles.slice(0, 3).map((f) => ({ id: f.id, label: f.name, group: "Knowledge", status: undefined })),
      ...memory.filter((m) => !m.proposed).slice(0, 2).map((m) => ({ id: m.id, label: m.text, group: "Memory", status: undefined })),
    ];
    return items.filter((i) => i.label.toLowerCase().includes(q)).slice(0, 7);
  }, [mentionQuery, children, memory]);

  const isProject = variant === "project";
  const effectiveMode: ComposerMode = isProject ? mode : "task";
  const empty = text.trim().length === 0;

  const submit = () => {
    if (empty) return;
    onSubmit(text.trim(), effectiveMode);
    setText("");
    setAttachments([]);
  };

  const pickMention = (label: string) => {
    setText((t) => t.replace(/@([\w-]*)$/, `@${label.length > 40 ? label.slice(0, 40) + "..." : label} `));
    setMentionIndex(0);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentions.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentions.length) % mentions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mentions[mentionIndex].label);
        return;
      }
    }
    if (isProject && e.key === "." && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setMode((m) => (m === "task" ? "ask" : "task"));
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const model = models.find((m) => m.name === settings.model) ?? models[0];
  const hostLabel = settings.host === "auto" ? "Best available" : settings.host;

  const ph =
    placeholder ??
    (isProject
      ? effectiveMode === "task"
        ? "Describe a task. Each one runs in its own thread."
        : "Ask the coordinator about this project"
      : variant === "child"
        ? "Message this thread"
        : "Describe a change, paste an error, or drop in a plan");

  let mentionGroup = "";
  return (
    <div className="composer-wrap">
      <form
        className={`composer${focused ? " is-focused" : ""}${effectiveMode === "ask" ? " is-ask" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {mentions.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label="Mention">
            {mentions.map((m, i) => {
              const header = m.group !== mentionGroup ? (mentionGroup = m.group) : null;
              return (
                <div key={m.id}>
                  {header && <div className="mention-menu__group">{header}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === mentionIndex}
                    className="mention-menu__item"
                    onMouseEnter={() => setMentionIndex(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickMention(m.label);
                    }}
                  >
                    {m.status ? <StatusGlyph status={m.status} size={13} /> : <BookOpen size={13} aria-hidden className="faint" />}
                    <span className="truncate">{m.label}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {attachments.length > 0 && (
          <ul className="attachments">
            {attachments.map((a) => (
              <li key={a} className="attachment">
                <Paperclip size={12} aria-hidden />
                {a}
                <button type="button" aria-label={`Remove ${a}`} onClick={() => setAttachments((xs) => xs.filter((x) => x !== a))}>
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <label className="sr-only" htmlFor={`composer-${variant}`}>
          {ph}
        </label>
        <textarea
          id={`composer-${variant}`}
          ref={ref}
          rows={1}
          value={text}
          placeholder={ph}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />

        <div className="composer__bar">
          {isProject && (
            <div className="mode-switch" role="radiogroup" aria-label="What Enter does">
              <button type="button" role="radio" aria-checked={mode === "task"} onClick={() => setMode("task")}>
                <Sparkles size={13} aria-hidden />
                New thread
              </button>
              <button type="button" role="radio" aria-checked={mode === "ask"} onClick={() => setMode("ask")}>
                <MessageCircleQuestion size={13} aria-hidden />
                Ask
              </button>
            </div>
          )}

          {effectiveMode === "task" && (
            <Popover
              label="Model and effort"
              side="top"
              width={300}
              trigger={(open, toggle) => (
                <button type="button" className="chip" aria-expanded={open} onClick={toggle}>
                  <ProviderLogo provider={model.provider} size={13} />
                  {settings.model}
                  <span className="chip__sep">{settings.effort}</span>
                  <ChevronDown size={12} aria-hidden className="faint" />
                </button>
              )}
            >
              {(close) => (
                <div className="menu">
                  <div className="menu__label">Model</div>
                  {models.map((m) => (
                    <MenuItem
                      key={m.id}
                      selected={m.name === settings.model}
                      onSelect={() => setSettings({ ...settings, model: m.name })}
                      hint={m.note}
                    >
                      <ProviderLogo provider={m.provider} size={13} />
                      {m.name}
                    </MenuItem>
                  ))}
                  <div className="menu__sep" />
                  <div className="menu__label">Effort</div>
                  <div className="segmented segmented--full" role="radiogroup" aria-label="Effort">
                    {efforts.map((e) => (
                      <button
                        key={e}
                        type="button"
                        role="radio"
                        aria-checked={settings.effort === e}
                        onClick={() => {
                          setSettings({ ...settings, effort: e });
                          close();
                        }}
                      >
                        {e}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </Popover>
          )}

          {effectiveMode === "task" && (
            <Popover
              label="Permissions"
              side="top"
              width={290}
              trigger={(open, toggle) => (
                <button type="button" className="chip" aria-expanded={open} onClick={toggle}>
                  <ShieldCheck size={13} aria-hidden />
                  {settings.permission}
                </button>
              )}
            >
              {(close) => (
                <div className="menu">
                  <div className="menu__label">Permissions</div>
                  {permissionModes.map((p) => (
                    <MenuItem
                      key={p.id}
                      selected={settings.permission === p.name}
                      onSelect={() => {
                        setSettings({ ...settings, permission: p.name });
                        close();
                      }}
                    >
                      <span className="stack">
                        <span>{p.name}</span>
                        <span className="faint small">{p.note}</span>
                      </span>
                    </MenuItem>
                  ))}
                </div>
              )}
            </Popover>
          )}

          {isProject && effectiveMode === "task" && (
            <Popover
              label="Where it runs"
              side="top"
              width={300}
              trigger={(open, toggle) => (
                <button type="button" className="chip" aria-expanded={open} onClick={toggle}>
                  <Server size={13} aria-hidden />
                  {hostLabel}
                </button>
              )}
            >
              {(close) => (
                <div className="menu">
                  <div className="menu__label">Runs on</div>
                  <MenuItem
                    selected={settings.host === "auto"}
                    onSelect={() => {
                      setSettings({ ...settings, host: "auto" });
                      close();
                    }}
                  >
                    <span className="stack">
                      <span>Best available</span>
                      <span className="faint small">Picks the host and subscription with the most room.</span>
                    </span>
                  </MenuItem>
                  {hosts.map((h) => (
                    <MenuItem
                      key={h.id}
                      selected={settings.host === h.id}
                      hint={`${h.running}/${h.slots}`}
                      onSelect={() => {
                        setSettings({ ...settings, host: h.id });
                        close();
                      }}
                    >
                      <span className="stack">
                        <span>{h.name}</span>
                        <span className="faint small">{h.kind}</span>
                      </span>
                    </MenuItem>
                  ))}
                  <div className="menu__sep" />
                  <div className="menu__label">Subscriptions</div>
                  {accounts.map((a) => (
                    <div key={a.id} className="quota-row">
                      <ProviderLogo provider={a.provider} size={13} />
                      <span className="quota-row__name">{a.name}</span>
                      <span className="meter" aria-label={`${a.used}% used`}>
                        <span style={{ width: `${a.used}%` }} className={a.used >= a.cap ? "is-over" : undefined} />
                      </span>
                      <span className="faint small tabular">{a.used}%</span>
                    </div>
                  ))}
                </div>
              )}
            </Popover>
          )}

          {variant === "thread" && (
            <span className="chip chip--static" title="Branch">
              <GitBranch size={13} aria-hidden />
              feature/PLX-440-rework-updater
            </span>
          )}

          <div className="composer__end">
            <button
              type="button"
              className="icon-btn"
              aria-label="Mention a thread or knowledge"
              onClick={() => {
                setText((t) => (t && !t.endsWith(" ") ? t + " @" : t + "@"));
                ref.current?.focus();
              }}
            >
              <AtSign size={15} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Attach a file"
              onClick={() => setAttachments((xs) => (xs.includes("crash-report.txt") ? [...xs, "screenshot.png"] : [...xs, "crash-report.txt"]))}
            >
              <Paperclip size={15} />
            </button>
            <button type="submit" className="send" disabled={empty} aria-label={effectiveMode === "ask" ? "Ask" : "Start"}>
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      </form>
      <p className={`composer-hint${focused ? " is-visible" : ""}`} aria-hidden={!focused}>
        {isProject ? (
          <>
            <Kbd>Enter</Kbd> {effectiveMode === "task" ? "starts a thread" : "asks the coordinator"}
            <span className="dot-sep" />
            <Kbd>{mod}.</Kbd> switches to {effectiveMode === "task" ? "Ask" : "New thread"}
            <span className="dot-sep" />
            <Kbd>@</Kbd> mentions a thread or file
          </>
        ) : (
          <>
            <Kbd>Enter</Kbd> sends
            <span className="dot-sep" />
            <Kbd>Shift Enter</Kbd> new line
            <span className="dot-sep" />
            <Kbd>@</Kbd> mentions
          </>
        )}
      </p>
    </div>
  );
}
