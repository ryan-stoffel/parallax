import { ExternalLink, Plus, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

import { HOME_VARS, type RegistryAgent } from "../preload/bridge";
import type { ProviderEnvVar, ProviderInstance } from "../protocol/generated/protocol";
import {
  keepRegistryIcon,
  kindOf,
  presets,
  saveProvider,
  versionOf,
  versions,
  withVersion,
  type Preset,
} from "./providers";
import { field, primaryButton, quietButton } from "./settings/parts";
import { IconButton, Segmented } from "./ui";

/** What a new instance starts as: a card's preset, or a registry agent's, with its icon. */
export type Draft = Omit<Preset, "blurb"> & { icon?: string };

/**
 * Registry agents plxd runs as a kind of its own, tuned to it, by registry id: they start from the
 * kind's defaults, not the registry's command.
 */
const tuned: Record<string, Draft> = {
  opencode: { kind: "opencode", name: "OpenCode" },
  "pi-acp": withVersion({ kind: "pi", name: "Pi", args: [], env: [] }, versions["pi"]![0]!),
  "grok-build": { kind: "grokBuild", name: "Grok Build" },
  "antigravity-acp": {
    kind: "antigravity",
    name: "Antigravity",
    program: "",
    programHint:
      "The full path to agy_acp_server.par, from the ACP Registry's Google Antigravity archive.",
  },
  cursor: { kind: "cursor", name: "Cursor" },
};

/**
 * `agent`'s Draft: a kind plxd tunes, or an ACP agent run with npx, or uvx, or else its binary
 * for `platform`, if it has one.
 */
export function registryDraft(agent: RegistryAgent, platform: string): Draft | undefined {
  const own = tuned[agent.id];
  if (own) return own;
  const { npx, uvx, binary } = agent.distribution;
  const env = (vars: Record<string, string> = {}): ProviderEnvVar[] =>
    Object.entries(vars).map(([name, value]) => ({ name, value, secret: false }));
  const base = { kind: "acp" as const, name: agent.name, icon: agent.icon };
  if (npx) {
    const args = ["-y", npx.package, ...(npx.args ?? [])];
    return { ...base, program: "npx", args, env: env(npx.env) };
  }
  if (uvx)
    return { ...base, program: "uvx", args: [uvx.package, ...(uvx.args ?? [])], env: env(uvx.env) };
  // ponytail: this computer's OS, which an SSH host's may not be.
  const os = { darwin: "darwin", win32: "windows" }[platform] ?? "linux";
  const build = Object.entries(binary ?? {}).find(([target]) => target.startsWith(`${os}-`))?.[1];
  if (!build) return undefined;
  const program = build.cmd.split(/[/\\]/).pop()!;
  return {
    ...base,
    program,
    args: build.args ?? [],
    env: env(build.env),
    programHint: `Install ${agent.name} on the host from its archive, then give the full path to ${program}, or put it on the host's PATH.`,
  };
}

/** `base`, or "`base` 2", "`base` 3"…: the first that `taken` doesn't have. */
function unique(base: string, taken: string[], join = " "): string {
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}${join}${n}`;
  return name;
}

/** An instance id from a name: lowercase letters, digits, and `-`. */
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "provider";

const steps = ["Provider", "Identity", "Config"];

/**
 * Add provider, a native modal <dialog> open while it's mounted, in three steps: a provider card
 * or an ACP Registry agent; its display name and id, unique on the host; and how it runs. Add
 * saves it on the host and calls `onAdded` with its id; closing calls `onClose`.
 */
export function AddProviderDialog({
  hostId,
  hostName,
  instances,
  onAdded,
  onClose,
}: {
  hostId: string;
  hostName: string;
  instances: ProviderInstance[];
  onAdded: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>();
  const [name, setName] = useState("");
  // Unset until edited: then the name no longer decides it.
  const [pickedId, setId] = useState<string>();
  const [program, setProgram] = useState("");
  const [home, setHome] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState<ProviderEnvVar[]>([]);
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);

  const ids = instances.map((i) => i.id);
  // A built-in agent takes its kind's id while it's free, which plxd's startup backend, the
  // coordinator, and the host's API keys go by.
  const builtIn = draft && ["claude", "codex", "cursor"].includes(draft.kind);
  const base = builtIn && !ids.includes(draft.kind) ? draft.kind : slug(name);
  const id = pickedId ?? unique(base, ids, "-");
  const idError = !/^[a-z0-9-]+$/.test(id)
    ? "Lowercase letters, digits, and -."
    : ids.includes(id)
      ? "Another provider on this host has it."
      : undefined;
  // Pi and OpenCode ask only what T3 Code asks; Settings has the rest once they're installed.
  const short = draft?.kind === "pi" || draft?.kind === "opencode";
  const homeVar = draft && !short && HOME_VARS[draft.kind];
  // A kind with versions: the one the fields run, which a choice rewrites.
  const choices = draft && !short && versions[draft.kind];
  const command = program.trim();
  const fields = {
    kind: draft?.kind ?? "acp",
    // The kind's own program is left to plxd.
    program: command && command !== kindOf(draft?.kind ?? "acp").program ? command : undefined,
    args: args.split(/\s+/).filter(Boolean),
    env,
  };
  const version = versionOf(fields);
  /** The value of the variable `name`, which a field edits. */
  const valueOf = (name: string) => env.find((v) => v.name === name)?.value ?? "";
  /** Sets the variable `name`, or leaves it out when `value` is empty. */
  const setVar = (name: string, value: string, secret = false) =>
    setEnv([...env.filter((v) => v.name !== name), ...(value ? [{ name, value, secret }] : [])]);

  const choose = (next: Draft, to = 1) => {
    setDraft(next);
    setName(
      unique(
        next.name,
        instances.map((i) => i.name),
      ),
    );
    setId(undefined);
    setProgram(next.program ?? kindOf(next.kind).program ?? "");
    setHome("");
    setArgs((next.args ?? []).join(" "));
    setEnv(next.env ?? []);
    setError(undefined);
    setStep(to);
  };

  const add = async () => {
    if (!draft) return;
    setSaving(true);
    const failed = await saveProvider(hostId, {
      id,
      kind: draft.kind,
      name: name.trim(),
      enabled: true,
      ...(fields.program && { program: fields.program }),
      ...(home.trim() && { home: home.trim() }),
      args: fields.args,
      env: env.filter((v) => v.name),
      models: [],
    });
    setSaving(false);
    if (failed) return setError(failed);
    if (draft.kind === "acp" && draft.icon) keepRegistryIcon(name.trim(), draft.icon);
    onAdded(id);
    dialog.current?.close();
  };

  const close = () => dialog.current?.close();
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[40rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <form
        className="flex max-h-[85vh] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (step === 2) void add();
          else if (step === 1 && !idError && name.trim()) setStep(2);
          else if (step === 0 && draft) setStep(1);
        }}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          <div className="flex-1">
            <h2 id={titleId} className="text-[15px] font-semibold">
              Add provider
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Add an account or configure a provider on {hostName}.
            </p>
          </div>
          <IconButton label="Close" onClick={close}>
            <X />
          </IconButton>
        </div>
        <ol className="flex gap-4 border-b border-border px-5 pb-3 text-[12.5px]">
          {steps.map((s, i) => (
            <li
              key={s}
              aria-current={i === step ? "step" : undefined}
              className="flex items-center gap-1.5 text-muted-foreground aria-[current]:text-foreground"
            >
              <span
                aria-hidden
                className={`grid size-5 place-items-center rounded-full border text-[11px] ${i === step ? "border-accent bg-accent text-white" : "border-border"}`}
              >
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === 0 && (
            <ProviderStep
              chosen={draft}
              onChoose={choose}
              onManual={() => choose({ kind: "acp", name: "ACP agent", args: [] }, 2)}
            />
          )}
          {step === 1 && (
            <div className="flex flex-col gap-4">
              <label className="text-[12.5px] text-muted-foreground">
                Display name
                <input
                  // The native attribute, so a step's first field takes focus.
                  autoFocus
                  required
                  maxLength={64}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="off"
                  className={field}
                />
              </label>
              <label className="text-[12.5px] text-muted-foreground">
                Id
                <input
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  aria-invalid={!!idError}
                  spellCheck={false}
                  autoComplete="off"
                  className={`${field} font-mono`}
                />
                <span
                  role={idError ? "alert" : undefined}
                  className={`mt-1 block ${idError ? "text-danger" : "text-faint-foreground"}`}
                >
                  {idError ?? "How plxd and its logs name it. It can't change later."}
                </span>
              </label>
            </div>
          )}
          {step === 2 && draft && (
            <div className="flex flex-col gap-4">
              {draft.kind === "pi" ? (
                <>
                  <label className="text-[12.5px] text-muted-foreground">
                    Binary path
                    <input
                      autoFocus
                      placeholder="pi"
                      value={valueOf("PI_ACP_PI_COMMAND")}
                      // The `pi` Pi's ACP adapter runs.
                      onChange={(e) => setVar("PI_ACP_PI_COMMAND", e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className={`${field} font-mono`}
                    />
                    <span className="mt-1 block text-faint-foreground">
                      Path to the Pi coding agent binary.
                    </span>
                  </label>
                </>
              ) : draft.kind === "opencode" ? (
                <>
                  <label className="text-[12.5px] text-muted-foreground">
                    Binary path
                    <input
                      autoFocus
                      placeholder="opencode"
                      value={program}
                      onChange={(e) => setProgram(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className={`${field} font-mono`}
                    />
                    <span className="mt-1 block text-faint-foreground">
                      Path to the OpenCode binary.
                    </span>
                  </label>
                  <label className="text-[12.5px] text-muted-foreground">
                    Server URL
                    <input
                      type="url"
                      placeholder="http://127.0.0.1:4096"
                      value={valueOf("OPENCODE_SERVER_URL")}
                      onChange={(e) => setVar("OPENCODE_SERVER_URL", e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className={`${field} font-mono`}
                    />
                    <span className="mt-1 block text-faint-foreground">
                      Leave blank to let Parallax start the server when needed.
                    </span>
                  </label>
                  <label className="text-[12.5px] text-muted-foreground">
                    Server password
                    <input
                      type="password"
                      placeholder="Optional"
                      value={valueOf("OPENCODE_SERVER_PASSWORD")}
                      onChange={(e) => setVar("OPENCODE_SERVER_PASSWORD", e.target.value, true)}
                      autoComplete="off"
                      className={field}
                    />
                    <span className="mt-1 block text-faint-foreground">
                      Kept in the host's keychain.
                    </span>
                  </label>
                </>
              ) : (
                <>
                  {choices && (
                    <div className="flex items-center justify-between gap-4 text-[12.5px] text-muted-foreground">
                      Version
                      <Segmented
                        label="Version"
                        options={choices.map((v) => ({ value: v.label, name: v.label }))}
                        value={version!.label}
                        onChange={(label) => {
                          const next = withVersion(
                            fields,
                            choices.find((v) => v.label === label)!,
                          );
                          setProgram(next.program ?? kindOf(draft.kind).program ?? "");
                          setArgs(next.args.join(" "));
                          setEnv(next.env);
                        }}
                      />
                    </div>
                  )}
                  <label className="text-[12.5px] text-muted-foreground">
                    Binary path
                    <input
                      autoFocus
                      required={!!draft.programHint || draft.kind === "acp"}
                      placeholder={kindOf(draft.kind).program}
                      value={program}
                      onChange={(e) => setProgram(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className={`${field} font-mono`}
                    />
                    {draft.programHint && (
                      <span className="mt-1 block text-faint-foreground">{draft.programHint}</span>
                    )}
                  </label>
                  {homeVar && (
                    <label className="text-[12.5px] text-muted-foreground">
                      {homeVar} path
                      <input
                        placeholder="Default"
                        value={home}
                        onChange={(e) => setHome(e.target.value)}
                        spellCheck={false}
                        autoComplete="off"
                        className={`${field} font-mono`}
                      />
                      <span className="mt-1 block text-faint-foreground">
                        Its own home, for a second account.
                      </span>
                    </label>
                  )}
                  <label className="text-[12.5px] text-muted-foreground">
                    {kindOf(draft.kind).wholeArgs ? "Arguments" : "Launch arguments"}
                    <input
                      value={args}
                      onChange={(e) => setArgs(e.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      className={`${field} font-mono`}
                    />
                  </label>
                  <EnvEditor env={env} onChange={setEnv} />
                </>
              )}
              {error && (
                <p role="alert" className="text-[12.5px] text-danger">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={close} className={quietButton}>
            Cancel
          </button>
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className={quietButton}>
              Back
            </button>
          )}
          <button
            type="submit"
            disabled={
              (step === 0 && !draft) || (step === 1 && (!!idError || !name.trim())) || saving
            }
            className={primaryButton}
          >
            {step === 2 ? "Add provider" : "Next"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** A registry agent's icon, drawn in the text's color: its SVG is a mask over it. */
function RegistryIcon({ url }: { url?: string }) {
  const style = url
    ? ({ mask: `url("${url}") center / contain no-repeat` } as CSSProperties)
    : undefined;
  return <span aria-hidden style={style} className="size-5 shrink-0 bg-current" />;
}

/**
 * Step 1: a card for each preset, then the ACP Registry, searched by name and description, each
 * agent with its repository and Add. Enter manually starts an ACP agent from nothing.
 */
function ProviderStep({
  chosen,
  onChoose,
  onManual,
}: {
  chosen?: Draft;
  onChoose: (draft: Draft) => void;
  onManual: () => void;
}) {
  const [registry, setRegistry] = useState<RegistryAgent[] | string>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    void window.parallax.acpRegistry().then((r) => live && setRegistry(r));
    return () => {
      live = false;
    };
  }, []);
  const q = query.trim().toLowerCase();
  const agents =
    typeof registry === "object"
      ? registry.filter(
          (a) => a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q),
        )
      : [];

  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        {presets.map((p) => {
          const { Logo } = kindOf(p.kind);
          return (
            <button
              key={p.name}
              type="button"
              aria-pressed={chosen?.name === p.name && chosen.kind === p.kind}
              onClick={() => onChoose(p)}
              className="flex items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left hover:bg-hover aria-pressed:border-accent aria-pressed:bg-selected"
            >
              <Logo className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{p.name}</span>
                <span className="block truncate text-[12px] text-muted-foreground">{p.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-5 mb-2 flex items-center justify-between gap-4">
        <h3 className="text-[12.5px] font-medium text-muted-foreground">
          Or choose from ACP Registry
        </h3>
        <button type="button" onClick={onManual} className={quietButton}>
          Enter manually
        </button>
      </div>
      <label className="mb-2 flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
        <Search aria-hidden className="size-4 shrink-0 text-faint-foreground" />
        <input
          type="search"
          aria-label="Search the ACP Registry"
          placeholder="Search agents…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-faint-foreground focus-visible:outline-none"
        />
      </label>
      {typeof registry === "string" ? (
        <p role="alert" className="text-[12.5px] text-danger">
          {registry}
        </p>
      ) : !registry ? (
        <p className="text-[12.5px] text-muted-foreground">Loading the registry…</p>
      ) : (
        <ul aria-label="ACP Registry" className="flex flex-col">
          {agents.map((agent) => {
            const draft = registryDraft(agent, window.parallax.platform);
            const link = agent.repository ?? agent.website;
            return (
              <li
                key={agent.id}
                className="flex items-center gap-3 border-border py-2 not-last:border-b"
              >
                <RegistryIcon url={agent.icon} />
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{agent.name}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {agent.description}
                  </span>
                </div>
                {link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${agent.name}'s page`}
                    className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-3.5"
                  >
                    <ExternalLink aria-hidden />
                  </a>
                )}
                <button
                  type="button"
                  disabled={!draft}
                  title={draft ? undefined : "No build for this host's OS"}
                  aria-label={`Add ${agent.name}`}
                  onClick={() => draft && onChoose(draft)}
                  className={`${quietButton} border border-border disabled:opacity-50`}
                >
                  Add
                </button>
              </li>
            );
          })}
          {agents.length === 0 && (
            <li className="py-2 text-[12.5px] text-faint-foreground">No matching agents</li>
          )}
        </ul>
      )}
    </>
  );
}

/** A new instance's variables: name, value, and whether it's a secret, each removable. */
function EnvEditor({
  env,
  onChange,
}: {
  env: ProviderEnvVar[];
  onChange: (env: ProviderEnvVar[]) => void;
}) {
  const set = (i: number, change: Partial<ProviderEnvVar>) =>
    onChange(env.map((v, j) => (j === i ? { ...v, ...change } : v)));
  return (
    <fieldset className="text-[12.5px] text-muted-foreground">
      <legend>Environment</legend>
      {env.map((v, i) => (
        <div key={i} className="mt-1.5 flex items-center gap-2">
          <input
            aria-label={`Variable ${i + 1} name`}
            required={!!v.value}
            pattern="[A-Za-z_][A-Za-z0-9_]*"
            placeholder="NAME"
            value={v.name}
            onChange={(e) =>
              set(i, {
                name: e.target.value,
                // A name that says it holds a key makes it a secret.
                ...(/KEY|TOKEN|SECRET/i.test(e.target.value) && { secret: true }),
              })
            }
            spellCheck={false}
            autoComplete="off"
            className={`${field} mt-0 w-56 font-mono`}
          />
          <input
            aria-label={v.name ? `Value of ${v.name}` : `Variable ${i + 1} value`}
            // A preset's secret, such as an API key, has to be given.
            required={v.secret && !!v.name}
            type={v.secret ? "password" : "text"}
            value={v.value ?? ""}
            onChange={(e) => set(i, { value: e.target.value })}
            spellCheck={false}
            autoComplete="off"
            className={`${field} mt-0 flex-1`}
          />
          <label className="flex shrink-0 items-center gap-1">
            <input
              type="checkbox"
              checked={v.secret}
              onChange={(e) => set(i, { secret: e.target.checked })}
            />
            Secret
          </label>
          <IconButton
            label={`Remove ${v.name || `variable ${i + 1}`}`}
            onClick={() => onChange(env.filter((_, j) => j !== i))}
          >
            <X aria-hidden />
          </IconButton>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...env, { name: "", value: "", secret: false }])}
        className={`${quietButton} mt-1.5 -ml-2.5 flex items-center gap-1 [&_svg]:size-3.5`}
      >
        <Plus aria-hidden />
        Add variable
      </button>
    </fieldset>
  );
}
