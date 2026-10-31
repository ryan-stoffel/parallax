// The liquid composer (PLX-1206): the real composer's box redrawn as one liquid body that the
// lab's states reshape. The form keeps its own contents and layout; while the lab runs, its fill,
// border, and shadow are drawn by the body behind them, so every state is the same surface
// stretching, pinching, budding, and settling on springs.

import { reducedMotion } from "../../src/renderer/motion";
import { BodyRenderer, type Box, type Rgba, mix, rgba } from "./body";
import { clearEditor, dropFiles, insertText, textAreaOf, wordsIn } from "./dom";
import { Spring, type SpringConfig, clock, springAnimate, springs } from "./spring";

/** How far the canvas reaches past the form: sides, top (for what leaves), and bottom. */
const side = 72;
const top = 340;
const bottom = 48;

/** The voice pill's half size: 208 × 40, about Wispr Flow's. */
const pill = { hw: 104, hh: 20 };
const bars = 17;
const barGap = 7;

/** Slow, soft springs for parts that trail the body, and a no-overshoot fade. */
const trail: SpringConfig = { stiffness: 95, damping: 12 };
const melt: SpringConfig = { stiffness: 60, damping: 13 };
const fade: SpringConfig = { stiffness: 600, damping: 49 };
/** The hero morphs (voice in and out): slower than the body token, so the shape can be read. */
const liquid: SpringConfig = { stiffness: 210, damping: 20 };
const glide: SpringConfig = { stiffness: 14, damping: 7.5 };

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

interface Geo {
  x: number;
  y: number;
  hw: number;
  hh: number;
  r: number;
}
const keys = ["x", "y", "hw", "hh", "r"] as const;

/** One rounded box on springs. */
class Blob {
  readonly s: Record<(typeof keys)[number], Spring>;

  constructor(
    g: Geo,
    public k = 0,
    public layer: Box["layer"] = "body",
    config: SpringConfig = springs.body,
  ) {
    this.s = {
      x: new Spring(g.x, config),
      y: new Spring(g.y, config),
      hw: new Spring(g.hw, config),
      hh: new Spring(g.hh, config),
      r: new Spring(g.r, config),
    };
  }

  to(g: Partial<Geo>, config?: SpringConfig) {
    for (const key of keys) if (g[key] !== undefined) this.s[key].to(g[key], config);
    return this;
  }

  snap(g: Partial<Geo>) {
    for (const key of keys) if (g[key] !== undefined) this.s[key].snap(g[key]);
    return this;
  }

  /** Shrinks to nothing where it is. */
  collapse(config: SpringConfig = springs.wobble) {
    return this.to({ hw: 0, hh: 0, r: 0 }, config);
  }

  advance(dt: number) {
    for (const key of keys) this.s[key].advance(dt);
  }

  get visible() {
    return this.s.hw.value > 0.05 && this.s.hh.value > 0.05;
  }

  box(): Box {
    const { x, y, hw, hh, r } = this.s;
    return {
      x: x.value,
      y: y.value,
      hw: Math.max(0, hw.value),
      hh: Math.max(0, hh.value),
      r: Math.max(0, r.value),
      k: this.k,
      layer: this.layer,
    };
  }
}

interface Colors {
  surface: Rgba;
  border: Rgba;
  ring: Rgba;
  danger: Rgba;
  pillFill: Rgba;
  pillInk: Rgba;
  shadow: Rgba;
  shadowShape: [number, number, number];
}

function readColors(): Colors {
  const dark = document.documentElement.classList.contains("dark");
  const surface = rgba("var(--surface)");
  const foreground = rgba("var(--foreground)");
  const background = rgba("var(--background)");
  return {
    surface,
    border: rgba("var(--border)"),
    ring: rgba("var(--ring)"),
    danger: rgba("var(--danger)"),
    // The pill is a dark capsule in either theme, as Wispr Flow's is: the surface on black, the
    // foreground on white. Its marks are the other one.
    // Neutral, not the light theme's indigo ink, so the pill stays monotone.
    pillFill: dark ? surface : [0.09, 0.09, 0.09, 1],
    pillInk: dark ? foreground : background,
    shadow: dark ? [0, 0, 0, 0.8] : [30 / 255, 27 / 255, 75 / 255, 0.22],
    shadowShape: dark ? [14, -18, 36] : [10, -16, 30],
  };
}

/** Speech-shaped loudness in 0–1: syllables in words, with pauses between them. */
function speech(t: number) {
  const syllable = 0.19;
  const n = Math.floor(t / syllable);
  const hash = (i: number) => {
    const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  // Every fifth to seventh syllable is a pause.
  const word = n % 6 === 5 || (n % 13 === 0 && n > 0);
  const phase = (t % syllable) / syllable;
  const peak = word ? 0.04 : 0.35 + hash(n) * 0.65;
  return peak * Math.sin(Math.PI * phase) ** 1.5;
}

const svg = (body: string, fill = false) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="${fill ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const icons = {
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  stop: svg('<rect width="12" height="12" x="6" y="6" rx="2.5"/>', true),
  terminal: svg('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
  file: svg(
    '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  ),
  pointer: `<svg viewBox="0 0 24 24" width="22" height="22"><path d="M5 2.5v17l4.6-4.3 3 6.6 2.6-1.2-3-6.5 6.3-.4Z" fill="#000" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
};

export class Stage {
  readonly canvas = document.createElement("canvas");
  readonly layer = document.createElement("div");
  private renderer: BodyRenderer;
  private colors = readColors();
  private themeWatch = new MutationObserver(() => (this.colors = readColors()));

  W = 0;
  H = 0;
  private time = 0;
  private last = 0;
  private raf = 0;

  /** rest: the body follows the form's own size. free: a state holds it. */
  private mode: "rest" | "free" = "rest";
  /** Clip the real contents to the body, so a shrinking body swallows them. */
  private clip = false;
  /** Keep the editor's words shown while the other contents are hidden. */
  private textShown = true;

  readonly main: Blob;
  private ends: [Blob, Blob];
  private lobes: [Blob, Blob];
  private reach: Blob;
  private bead: Blob;
  private drop: Blob;
  private buttons: [Blob, Blob];
  private bars: Blob[];

  private tint = new Spring(0, fade);
  private focus = new Spring(0, fade);
  private danger = new Spring(0, fade);
  private hidden = new Spring(0, fade);
  private freeAlpha = new Spring(1, fade);
  private swell = new Spring(0, springs.wobble);
  private breath = 0;
  private listening = false;

  private tickers = new Set<(t: number) => void>();
  private timers: number[] = [];
  private nodes = new Set<HTMLElement>();
  private badge?: { el: HTMLElement; text: string };

  constructor(readonly form: HTMLFormElement) {
    this.W = form.offsetWidth;
    this.H = form.offsetHeight;
    const rest = this.rest();
    this.main = new Blob(rest);
    const none = { x: rest.x, y: rest.y, hw: 0, hh: 0, r: 0 };
    this.ends = [new Blob(none, 16), new Blob(none, 16)];
    this.lobes = [new Blob(none, 10), new Blob(none, 10)];
    this.reach = new Blob(none, 34, "body", springs.wobble);
    this.bead = new Blob(none, 22);
    this.drop = new Blob(none, 30);
    this.buttons = [new Blob(none, 0, "ink1"), new Blob(none, 0, "ink1")];
    this.bars = Array.from({ length: bars }, () => new Blob(none, 5, "ink0", springs.wobble));

    form.dataset["liquid"] = "";
    this.canvas.dataset["liquidOwn"] = "";
    this.canvas.className = "pointer-events-none absolute -z-10";
    this.layer.dataset["liquidOwn"] = "";
    this.layer.className = "pointer-events-none absolute z-20 overflow-visible";
    form.prepend(this.canvas);
    form.append(this.layer);
    this.renderer = new BodyRenderer(this.canvas);
    this.themeWatch.observe(document.documentElement, { attributes: true });
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.themeWatch.disconnect();
    this.clearTimers();
    this.canvas.remove();
    this.layer.remove();
    delete this.form.dataset["liquid"];
    for (const child of this.contents()) {
      child.style.opacity = "";
      child.style.clipPath = "";
    }
    const text = textAreaOf(this.form);
    if (text) text.style.opacity = "";
    const tabs = this.tabs();
    if (tabs) tabs.style.transform = tabs.style.clipPath = tabs.style.opacity = "";
    if (this.badge) this.badge.el.textContent = this.badge.text;
  }

  // The frame

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = (this.last ? Math.min((now - this.last) / 1000, 1 / 30) : 1 / 60) * clock.scale;
    this.last = now;
    this.time += dt;
    this.measure();
    for (const tick of this.tickers) tick(this.time);
    for (const blob of this.blobs()) blob.advance(dt);
    for (const s of [this.tint, this.focus, this.danger, this.hidden, this.freeAlpha, this.swell])
      s.advance(dt);
    this.render();
    this.sync();
  };

  private blobs() {
    return [
      this.main,
      ...this.ends,
      ...this.lobes,
      this.reach,
      this.bead,
      this.drop,
      ...this.buttons,
      ...this.bars,
    ];
  }

  private measure() {
    const W = this.form.offsetWidth;
    const H = this.form.offsetHeight;
    if (W !== this.W || H !== this.H || !this.canvas.style.width) {
      this.W = W;
      this.H = H;
      for (const el of [this.canvas, this.layer])
        Object.assign(el.style, {
          left: `${-side - 1}px`,
          top: `${-top - 1}px`,
          width: `${W + side * 2}px`,
          height: `${H + top + bottom}px`,
        });
    }
    // The focus ring is a resting state: mid-morph the edge stays neutral.
    this.focus.to(this.mode === "rest" && this.form.matches(":focus-within") ? 1 : 0);
    if (this.mode === "rest") this.main.to(this.rest());
  }

  /** The body at rest: relaxed a little when idle, standing full when focused. */
  private rest(): Geo {
    const { W, H } = this;
    const relaxed = this.form.matches(":focus-within") ? 0 : 1;
    const swell = this.swell?.value ?? 0;
    const breath = this.breath * Math.sin(this.time * 1.4) * 0.8;
    return {
      x: W / 2,
      y: H / 2 + relaxed,
      hw: W / 2 - relaxed * 5 + swell * 5,
      hh: H / 2 - relaxed + swell * 3 + breath,
      r: 16,
    };
  }

  /** The main body as drawn: width and height trade off with speed, as a liquid's volume does. */
  private mainBox() {
    const box = this.main.box();
    box.hh = Math.max(0, box.hh + clamp(-0.009 * this.main.s.hw.velocity, -7, 10));
    box.hw = Math.max(0, box.hw + clamp(-0.006 * this.main.s.hh.velocity, -8, 8));
    return box;
  }

  private render() {
    const c = this.colors;
    const boxes: Box[] = [this.mainBox()];
    for (const blob of this.blobs().slice(1)) if (blob.visible) boxes.push(blob.box());
    // The color turns over a short stretch of the morph, so it never sits on a muddy middle.
    const t = clamp((this.tint.value - 0.3) / 0.4);
    const tint = t * t * (3 - 2 * t);
    let border = mix(c.border, c.ring, clamp(this.focus.value) * (1 - tint));
    border = mix(border, c.danger, clamp(this.danger.value));
    this.renderer.draw(
      boxes,
      {
        fill: mix(c.surface, c.pillFill, tint),
        border,
        shadow: [c.shadow[0], c.shadow[1], c.shadow[2], c.shadow[3] * (1 - tint * 0.5)],
        shadowShape: c.shadowShape,
        ink0: [c.pillInk[0], c.pillInk[1], c.pillInk[2], 0.92],
        ink1: [c.pillInk[0], c.pillInk[1], c.pillInk[2], 0.14],
        freeAlpha: clamp(this.freeAlpha.value),
        alpha: 1,
      },
      [side, top],
    );
  }

  /** The form's own children, which the body draws behind. */
  private contents() {
    return [...this.form.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && !("liquidOwn" in el.dataset),
    );
  }

  private tabs() {
    const el = this.form.parentElement?.previousElementSibling;
    return el instanceof HTMLElement ? el : undefined;
  }

  /** Keeps the real contents and the tabs on the body. */
  private sync() {
    const m = this.mainBox();
    const left = m.x - m.hw;
    const right = m.x + m.hw;
    const topEdge = m.y - m.hh;
    const bottomEdge = m.y + m.hh;
    const hidden = clamp(this.hidden.value);
    const text = textAreaOf(this.form);
    for (const el of this.contents()) {
      el.style.opacity = hidden > 0.001 ? String(1 - hidden) : "";
      if (this.clip) {
        const x = el.offsetLeft + 1;
        const y = el.offsetTop + 1;
        el.style.clipPath = `inset(${topEdge - y}px ${x + el.offsetWidth - right}px ${y + el.offsetHeight - bottomEdge}px ${left - x}px round ${m.r}px)`;
      } else el.style.clipPath = "";
    }
    if (text) text.style.opacity = this.textShown ? "" : "0";
    if (text && this.textShown && hidden > 0.001) text.style.opacity = "1";
    // The tabs ride the body's top edge and are tucked to its width.
    const tabs = this.tabs();
    if (tabs) {
      const inset = Math.max(0, this.W / 2 - m.hw - (m.x - this.W / 2));
      const insetRight = Math.max(0, this.W / 2 - m.hw + (m.x - this.W / 2));
      tabs.style.transform = `translateY(${topEdge.toFixed(2)}px)`;
      tabs.style.clipPath = `inset(-20px ${insetRight + 8}px -20px ${inset + 8}px)`;
      tabs.style.opacity = String(clamp((m.hw / (this.W / 2) - 0.72) / 0.22));
    }
  }

  // Helpers for states

  private after(ms: number, fn: () => void) {
    this.timers.push(window.setTimeout(fn, reducedMotion() ? 0 : ms / clock.scale));
  }

  private clearTimers() {
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
  }

  /** A node in the layer, placed by `place` in the form's coordinates. */
  private node(className: string, html = "") {
    const el = document.createElement("div");
    el.className = `absolute top-0 left-0 ${className}`;
    el.innerHTML = html;
    this.layer.append(el);
    this.nodes.add(el);
    return el;
  }

  private place(el: HTMLElement, x: number, y: number, scale = 1) {
    el.style.transform = `translate(${(x + side).toFixed(2)}px, ${(y + top).toFixed(2)}px) translate(-50%, -50%) scale(${scale.toFixed(4)})`;
  }

  private removeNode(el: HTMLElement) {
    this.nodes.delete(el);
    const a = el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], {
      duration: 120,
      fill: "forwards",
    });
    a.onfinish = () => el.remove();
  }

  /**
   * Starts a state: clears the last one's timers, tickers, and nodes, and lets its extra shapes
   * go from wherever they are. Under reduced motion, the body dips and comes back instead.
   */
  private begin() {
    this.clearTimers();
    this.tickers.clear();
    this.listening = false;
    for (const el of this.nodes) this.removeNode(el);
    for (const blob of [...this.ends, ...this.lobes, this.reach, this.bead, ...this.buttons])
      blob.collapse();
    for (const bar of this.bars) bar.collapse();
    if (this.drop.layer === "body") this.drop.collapse();
    this.breath = 0;
    this.swell.to(0);
    this.danger.to(0);
    if (reducedMotion())
      for (const el of [this.canvas, this.layer])
        el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 180, easing: "ease-out" });
  }

  /** Gives the body back to the form's own size and shows its contents. */
  private release() {
    this.mode = "rest";
    this.tint.to(0);
    this.hidden.to(0);
    this.textShown = true;
    this.after(380, () => (this.clip = false));
  }

  /** Lays copies of the editor's words over them, in a group that can move as one. */
  private copyWords() {
    const { words, font } = wordsIn(this.form);
    if (!words.length) return;
    const left = Math.min(...words.map((w) => w.x));
    const right = Math.max(...words.map((w) => w.x + w.width));
    const topY = Math.min(...words.map((w) => w.y));
    const bottomY = Math.max(...words.map((w) => w.y + w.height));
    const cx = (left + right) / 2;
    const cy = (topY + bottomY) / 2;
    const group = this.node("");
    group.style.width = group.style.height = "0px";
    const spans = words.map((w) => {
      const span = document.createElement("span");
      span.textContent = w.text;
      Object.assign(span.style, font, {
        position: "absolute",
        whiteSpace: "pre",
        lineHeight: `${w.height}px`,
        left: `${w.x - cx}px`,
        top: `${w.y - cy}px`,
      });
      group.append(span);
      return span;
    });
    return { group, spans, words, cx, cy, width: right - left, height: bottomY - topY };
  }

  // The states

  /** Idle: the body relaxes a little and settles, focus or not. */
  idle() {
    this.begin();
    this.release();
    (document.activeElement as HTMLElement | null)?.blur();
  }

  /** Focus: the body stands up to its full size with a small overshoot, and the edge lights. */
  focusIn() {
    this.begin();
    this.release();
    textAreaOf(this.form)?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
    this.main.s.hh.kick(70);
    this.main.s.hw.kick(90);
  }

  /** Voice: the box drains into a dark pill at its foot, its ends trailing as droplets. */
  voice() {
    this.begin();
    const { W, H } = this;
    this.mode = "free";
    this.clip = true;
    this.hidden.to(1, fade);
    this.textShown = false;
    const x = W / 2;
    const y = H - 6 - pill.hh;
    this.main.s.x.to(x, liquid);
    this.main.s.hh.to(pill.hh, liquid);
    this.main.s.y.to(y, liquid);
    this.main.s.r.to(pill.hh, liquid);
    this.after(90, () => this.main.s.hw.to(pill.hw, liquid));
    this.after(200, () => this.tint.to(1, fade));

    // The ends start as the box's own round ends, inside it, then trail it in and melt.
    const R = Math.min(H / 2 - 6, 44);
    this.ends.forEach((end, i) => {
      const dir = i ? 1 : -1;
      end.k = 30;
      end.snap({ x: x + dir * (W / 2 - R - 4), y: H / 2, hw: R, hh: R, r: R });
      // They hold for a beat while the middle drains, so the shrink passes through a dumbbell.
      this.after(110, () => {
        end.s.x.to(x + dir * (pill.hw - 26), trail);
        end.s.y.to(y, trail);
        for (const key of ["hw", "hh", "r"] as const) end.s[key].to(pill.hh + 6, trail);
      });
      this.after(420, () => {
        for (const key of ["hw", "hh", "r"] as const) end.s[key].to(4, melt);
      });
    });

    // Its marks bud inside it once it's nearly a pill.
    const check = this.node(
      "pointer-events-auto grid size-7 place-items-center rounded-full",
      icons.check,
    );
    const stop = this.node(
      "pointer-events-auto grid size-7 place-items-center rounded-full",
      icons.stop,
    );
    check.title = "Done";
    stop.title = "Stop";
    check.onclick = () => void this.voiceDone("");
    stop.onclick = () => void this.voiceCancel();
    for (const el of [check, stop])
      el.style.color = `rgb(${this.colors.pillInk
        .slice(0, 3)
        .map((v) => v * 255)
        .join(" ")})`;
    this.after(200, () => {
      this.buttons.forEach((b, i) =>
        b
          .snap({ x: x + (i ? 1 : -1) * (pill.hw - 20), y, hw: 0, hh: 0, r: 0 })
          .to({ hw: 14, hh: 14, r: 14 }, springs.wobble),
      );
    });
    const mid = (bars - 1) / 2;
    this.after(240, () => {
      this.listening = true;
      this.bars.forEach((bar, i) => {
        bar.k = 5;
        bar.snap({ x, y, hw: 1.3, hh: 0, r: 1.3 });
        this.after(Math.abs(i - mid) * 16, () =>
          bar.to({ x: x + (i - mid) * barGap, hh: 1.3 }, springs.wobble),
        );
      });
    });

    this.tickers.add((t) => {
      const m = this.main.s;
      // The melt narrows as the ends shrink, so the pill settles with no swelling at its ends.
      for (const end of this.ends) end.k = 6 + 24 * clamp((end.s.hw.value - 4) / 22);
      this.buttons.forEach((b, i) => {
        b.s.x.to(m.x.value + (i ? 1 : -1) * (m.hw.value - 20), springs.snap);
        b.s.y.to(m.y.value, springs.snap);
        const el = i ? stop : check;
        const scale = clamp(b.s.hw.value / 14, 0, 1.3);
        this.place(el, b.s.x.value, b.s.y.value, scale);
        el.style.opacity = String(clamp(scale * 1.4 - 0.2));
      });
      if (!this.listening) return;
      const level = speech(t);
      this.bars.forEach((bar, i) => {
        const bell = Math.exp(-(((i - mid) / (mid * 0.62)) ** 2));
        const jitter = 0.55 + 0.45 * Math.sin(t * 9.1 + i * 2.7) * Math.sin(t * 5.3 + i * 1.3);
        const amp = reducedMotion() ? 0.3 * bell : level * bell * jitter;
        bar.k = 5 - 3.6 * clamp(amp * 2);
        bar.s.hh.to(1.3 + amp * 12, springs.wobble);
        bar.s.x.to(m.x.value + (i - mid) * barGap * (m.hw.value / pill.hw), springs.snap);
        bar.s.y.to(m.y.value, springs.snap);
      });
    });
  }

  /** Grows the pill back into the box: its ends shoot out first and the body fills in behind. */
  private expandFromPill() {
    const { W, H } = this;
    const m = this.main.s;
    this.listening = false;
    this.ends.forEach((end, i) => {
      const dir = i ? 1 : -1;
      end.k = 40;
      end.snap({ x: m.x.value + dir * (m.hw.value - 18), y: m.y.value, hw: 18, hh: 18, r: 18 });
      end.to({ x: W / 2 + dir * (W / 2 - 40), y: H / 2 }, { stiffness: 260, damping: 19 });
      end.to({ hw: 26, hh: 26, r: 26 }, springs.wobble);
      this.after(300, () => end.to({ hw: 4, hh: 4, r: 4 }, melt));
    });
    this.after(30, () => m.hw.to(W / 2, liquid));
    this.after(60, () => {
      m.hh.to(H / 2, liquid);
      m.y.to(H / 2, liquid);
      m.r.to(16, liquid);
      m.x.to(W / 2, liquid);
    });
    this.tint.to(0, fade);
    // The waveform melts into one line, and the line drains away.
    const mid = (bars - 1) / 2;
    this.bars.forEach((bar, i) => {
      bar.k = 7;
      bar.to({ hh: 1.3, x: m.x.value + (i - mid) * 3 }, springs.body);
      this.after(140, () => bar.collapse(springs.body));
    });
    this.buttons.forEach((b) => this.after(40, () => b.collapse()));
  }

  /** Done: the check presses in, and the pill grows back into the box with the words spilling in. */
  async voiceDone(text: string) {
    const [check] = this.buttons;
    check.s.hw.kick(-140);
    check.s.hh.kick(-140);
    check.s.r.kick(-140);
    this.main.s.hw.kick(-60);
    await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : 160 / clock.scale));
    this.begin();
    this.mode = "free";
    this.clip = true;
    this.textShown = false;
    this.expandFromPill();
    if (text) insertText(this.form, text);
    // Measures once the editor has laid the words out.
    await new Promise((r) => requestAnimationFrame(r));
    const copy = text ? this.copyWords() : undefined;
    if (copy) {
      const center = this.W / 2;
      copy.spans.forEach((span, i) => {
        const w = copy.words[i]!;
        const from = center - (w.x + w.width / 2);
        springAnimate(
          span,
          (p) => ({
            transform: `translate(${(from * 0.22 * (1 - p)).toFixed(2)}px, ${(6 * (1 - p)).toFixed(2)}px)`,
            opacity: String(clamp(p * 1.4)),
          }),
          springs.drift,
          200 + i * 26,
        );
      });
      this.place(copy.group, copy.cx, copy.cy);
    }
    this.after(1000, () => {
      this.textShown = true;
      this.mode = "rest";
      this.hidden.to(0);
      if (copy) {
        copy.group.remove();
        this.nodes.delete(copy.group);
      }
      this.after(380, () => (this.clip = false));
    });
  }

  /** Stop: the pill shudders and opens back into the box, empty. */
  async voiceCancel() {
    const stop = this.buttons[1];
    stop.s.hw.kick(-140);
    stop.s.hh.kick(-140);
    this.main.s.x.kick(-260);
    await new Promise((r) => setTimeout(r, reducedMotion() ? 0 : 160 / clock.scale));
    this.begin();
    this.mode = "free";
    this.expandFromPill();
    this.after(700, () => this.release());
  }

  /** Send: the words gather into a drop that pulls the top edge up, pinches off, and rises. */
  send() {
    this.begin();
    const copy = this.copyWords();
    if (!copy) return;
    const { H, W } = this;
    this.textShown = false;
    clearEditor(this.form);
    this.mode = "free";
    const drop = this.drop;
    drop.layer = "body";
    drop.k = 30;
    const startHw = copy.width / 2 + 6;
    drop.snap({ x: copy.cx, y: copy.cy, hw: startHw, hh: copy.height / 2 + 2, r: 10 });
    // The words condense into a drop about a third the box's width as they rise.
    const endHw = Math.min(startHw, W * 0.2);
    drop.to({ hw: endHw, hh: 15, r: 15, x: W / 2 }, { stiffness: 150, damping: 15 });
    drop.s.y.to(-64, { stiffness: 130, damping: 14 });
    this.freeAlpha.snap(1);
    // The top edge gives a little under it; the neck itself comes from the melt.
    this.main.to({ y: H / 2 - 2, hh: H / 2 + 2 }, springs.wobble);
    let gone = false;
    this.tickers.add(() => {
      const d = drop.s;
      this.place(
        copy.group,
        d.x.value,
        d.y.value,
        clamp((d.hw.value - 12) / (startHw - 6), 0.2, 1),
      );
      const gap = this.main.s.y.value - this.main.s.hh.value - (d.y.value + d.hh.value);
      if (!gone && gap > drop.k) {
        // It's off: the body snaps back and jiggles, and the drop rounds and rises on its own.
        gone = true;
        drop.layer = "free";
        this.mode = "rest";
        this.main.s.y.kick(200);
        this.main.s.hh.kick(-160);
        drop.s.hh.kick(-80);
        drop.s.hw.kick(70);
        drop.s.y.to(-230, { stiffness: 40, damping: 9 });
        drop.to({ hw: 10, hh: 10, r: 10 }, { stiffness: 60, damping: 12 });
        this.freeAlpha.to(0, { stiffness: 50, damping: 14 });
        springAnimate(copy.group, (p) => ({ opacity: String(1 - p) }), {
          stiffness: 260,
          damping: 32,
        });
        this.after(450, () => {
          drop.collapse();
          this.textShown = true;
          textAreaOf(this.form)?.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            easing: "ease-out",
          });
        });
      }
    });
  }

  /**
   * Working: the body is calm but alive, a soft swell gliding along its foot as it breathes. The
   * foot, since the tabs sit on the top edge.
   */
  working() {
    this.begin();
    this.release();
    this.breath = 1;
    const { W } = this;
    this.bead.k = 26;
    this.bead.snap({ x: W * 0.2, y: this.H - 8, hw: 0, hh: 0, r: 0 });
    this.bead.to({ hw: 12, hh: 12, r: 12 }, springs.drift);
    let side = 1;
    let next = 0;
    this.tickers.add((t) => {
      if (t > next) {
        next = t + 2.6;
        side = -side;
        this.bead.s.x.to(W / 2 + side * W * 0.32, glide);
      }
      this.bead.s.y.to(this.main.s.y.value + this.main.s.hh.value - 7, springs.snap);
    });
  }

  /** Queue: while the agent works, the words bead off the top corner and dock on the Queued tab. */
  queue() {
    this.working();
    const copy = this.copyWords();
    if (!copy) return;
    const tab = document.querySelector<HTMLElement>('[title="Show the queued messages"]');
    const count = [...(tab?.querySelectorAll("span") ?? [])].find((s) =>
      /^\d+$/.test(s.textContent ?? ""),
    );
    const formRect = this.form.getBoundingClientRect();
    const target = (count ?? tab)?.getBoundingClientRect();
    this.textShown = false;
    clearEditor(this.form);
    const drop = this.drop;
    drop.layer = "body";
    drop.k = 30;
    drop.snap({ x: copy.cx, y: copy.cy, hw: copy.width / 2 + 6, hh: copy.height / 2 + 2, r: 10 });
    this.freeAlpha.snap(1);
    const tx = target ? target.left + target.width / 2 - formRect.left : this.W - 40;
    const ty = target ? target.top + target.height / 2 - formRect.top : -16;
    // Up over the tabs, across, then down onto the count, so it's seen against the transcript.
    const above = ty - 46;
    drop.s.y.to(above, { stiffness: 130, damping: 14 });
    drop.to(
      { hw: Math.min(copy.width / 2 + 6, 60), hh: 13, r: 13 },
      { stiffness: 120, damping: 14 },
    );
    this.after(260, () => drop.s.x.to(tx, { stiffness: 60, damping: 13 }));
    this.after(420, () => drop.to({ hw: 11, hh: 11, r: 11 }, { stiffness: 90, damping: 12 }));
    this.after(820, () => drop.s.y.to(ty, { stiffness: 140, damping: 12 }));
    this.main.to({ y: this.H / 2 - 6, hh: this.H / 2 + 6 }, springs.wobble);
    this.mode = "free";
    springAnimate(copy.group, (p) => ({ opacity: String(1 - p) }), { stiffness: 90, damping: 18 });
    const startHw = copy.width / 2 + 6;
    let gone = false;
    let docked = false;
    this.tickers.add(() => {
      const d = drop.s;
      this.place(copy.group, d.x.value, d.y.value, clamp(d.hw.value / startHw, 0.2, 1));
      const gap = this.main.s.y.value - this.main.s.hh.value - (d.y.value + d.hh.value);
      if (!gone && gap > drop.k) {
        gone = true;
        drop.layer = "free";
        this.mode = "rest";
        this.main.s.y.kick(200);
        this.main.s.hh.kick(-160);
      }
      if (gone && !docked && Math.hypot(d.x.value - tx, d.y.value - ty) < 5) {
        docked = true;
        drop.collapse(springs.snap);
        if (count) {
          this.badge ??= { el: count, text: count.textContent ?? "" };
          count.textContent = String(Number(count.textContent) + 1);
          springAnimate(count, (p) => ({ scale: String(1.45 - 0.45 * p) }), springs.wobble);
        }
        this.after(300, () => (this.textShown = true));
      }
    });
  }

  /** Approval: the body rises to hold the request, and its foot pinches into two choices. */
  approval(command: string) {
    this.begin();
    const { W, H } = this;
    this.mode = "free";
    this.clip = true;
    this.hidden.to(1);
    this.textShown = false;
    const lobeH = 34;
    const gap = 10;
    const request = 70;
    const bottomEdge = H - lobeH - gap;
    const topEdge = Math.min(0, bottomEdge - request) - 6;
    this.main.to(
      { y: (topEdge + bottomEdge) / 2, hh: (bottomEdge - topEdge) / 2, r: 16 },
      springs.body,
    );
    this.main.s.hh.kick(-120);
    this.lobes.forEach((lobe, i) => {
      const x = i ? (W * 3) / 4 - 1 : W / 4 + 1;
      lobe.k = 16;
      lobe.snap({ x, y: H - lobeH / 2 - 6, hw: W / 4 - 12, hh: lobeH / 2 - 4, r: 12 });
      lobe.to({ y: H - lobeH / 2, hh: lobeH / 2, r: lobeH / 2 }, springs.wobble);
    });
    const body = this.node(
      "flex flex-col gap-1.5 text-left",
      `<div class="flex items-center gap-1.5 text-meta text-faint-foreground">${icons.terminal.replace('width="16" height="16"', 'width="14" height="14"')}Run a command?</div><div class="font-mono text-body text-foreground">${command}</div>`,
    );
    body.style.width = `${W - 40}px`;
    const labels = (["Deny", "Allow"] as const).map((name, i) =>
      this.node(
        `pointer-events-auto flex items-center gap-2 text-body ${i ? "font-medium text-foreground" : "text-muted-foreground"}`,
        `${name}<kbd class="rounded-sm border border-border px-1 font-sans text-caption leading-4 text-faint-foreground">${i ? "↵" : "esc"}</kbd>`,
      ),
    );
    labels.forEach((el, i) => (el.onclick = () => this.decide(i === 1)));
    for (const el of [body, ...labels])
      springAnimate(el, (p) => ({ opacity: String(p) }), springs.drift, 160);
    this.tickers.add(() => {
      const m = this.main.s;
      this.place(body, W / 2, m.y.value - m.hh.value + 12 + 26);
      this.lobes.forEach((lobe, i) => this.place(labels[i]!, lobe.s.x.value, lobe.s.y.value));
    });
  }

  /** The chosen lobe is drawn back up into the body; the other drips away. */
  decide(allow: boolean) {
    const chosen = this.lobes[allow ? 1 : 0];
    const other = this.lobes[allow ? 0 : 1];
    chosen.s.hh.kick(-90);
    chosen.s.hw.kick(60);
    const nodes = [...this.nodes];
    this.after(140, () => {
      for (const el of nodes) this.removeNode(el);
      chosen.k = 22;
      chosen.to({ y: this.H / 2, hh: 6, hw: 40, r: 6 }, springs.wobble);
      other.to({ y: this.H + 4, hh: 0, hw: this.W / 10, r: 0 }, melt);
      this.release();
      this.main.s.hh.kick(120);
      this.after(260, () => chosen.collapse(springs.body));
    });
  }

  /** File drag: the body reaches toward the cursor, then gulps the file when it's dropped. */
  async drag(signal?: AbortSignal) {
    this.begin();
    this.release();
    const { W, H } = this;
    const cursor = this.node("", `<div class="relative">${icons.pointer}</div>`);
    const card = this.node(
      "flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-meta text-muted-foreground shadow-composer",
      `${icons.file.replace('width="16" height="16"', 'width="14" height="14"')}design-notes.md`,
    );
    const pos = new Blob({ x: W * 0.74, y: -240, hw: 0, hh: 0, r: 0 }, 0, "body", trail);
    const path: [number, number, number][] = [
      [0, W * 0.66, -120],
      [700, W * 0.6, -54],
      [1500, W * 0.55, -14],
      [2300, W * 0.5, H * 0.45],
    ];
    for (const [at, x, y] of path) this.after(at, () => pos.to({ x, y }, glideTo));
    springAnimate(cursor, (p) => ({ opacity: String(p) }), springs.drift);
    springAnimate(card, (p) => ({ opacity: String(p) }), springs.drift);
    this.reach.k = 40;
    this.reach.snap({ x: W * 0.7, y: 0, hw: 0, hh: 0, r: 0 });
    let over = false;
    this.tickers.add(() => {
      pos.advance(1 / 60);
      const cx = pos.s.x.value;
      const cy = pos.s.y.value;
      this.place(cursor, cx + 9, cy + 9);
      this.place(card, cx + 64, cy + 28);
      const m = this.mainBox();
      const ex = clamp(cx, m.x - m.hw + 16, m.x + m.hw - 16);
      const ey = clamp(cy, m.y - m.hh, m.y + m.hh);
      const inside = Math.abs(cx - m.x) < m.hw && Math.abs(cy - m.y) < m.hh && cy > m.y - m.hh + 4;
      const dist = Math.hypot(cx - ex, cy - ey);
      const reach = inside ? 0 : clamp(1 - dist / 190) ** 1.4;
      if (inside !== over) {
        over = inside;
        this.swell.to(inside ? 1 : 0, springs.wobble);
        this.focus.to(inside ? 1 : 0);
      }
      const radius = inside ? 0 : 2 + 17 * reach;
      const along = dist * 0.62 * reach;
      const dx = dist ? (cx - ex) / dist : 0;
      const dy = dist ? (cy - ey) / dist : -1;
      this.reach.to(
        { x: ex + dx * along, y: ey + dy * along, hw: radius, hh: radius, r: radius },
        springs.wobble,
      );
    });
    await new Promise((r) => setTimeout(r, reducedMotion() ? 600 : 3100));
    if (signal?.aborted) return;
    // The drop: the body gulps, and the file's card arrives in it as the composer adds it.
    this.reach.collapse(springs.snap);
    this.main.s.hh.kick(-180);
    this.main.s.hw.kick(120);
    this.swell.to(0, springs.wobble);
    this.removeNode(cursor);
    this.removeNode(card);
    this.tickers.clear();
    dropFiles(this.form, [
      new File(["# Design notes\n"], "design-notes.md", { type: "text/markdown" }),
    ]);
  }

  /** Error: one firm shake, a short squeeze, and the edge goes red for a moment. */
  error() {
    this.begin();
    this.release();
    const x = this.main.s.x;
    x.config = springs.snap;
    x.kick(-900);
    this.main.s.hw.kick(-160);
    this.danger.to(1, springs.snap);
    this.after(650, () => this.danger.to(0, fade));
    this.after(700, () => (x.config = springs.body));
  }
}

const glideTo: SpringConfig = { stiffness: 40, damping: 12 };
