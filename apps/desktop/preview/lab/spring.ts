// A damped spring for the liquid composer (PLX-1206). Every shape value in the lab is one of these:
// retargeting keeps the velocity it has, so a new state takes over mid-flight from where the body is.

import { reducedMotion } from "../../src/renderer/motion";

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
}

/**
 * The proposed spring tokens. Damping ratio ζ = damping / (2·√(stiffness·mass)).
 * - body: the box's own shape. ζ 0.67, about 6% overshoot, settles in about 0.35 s.
 * - wobble: droplets, buds, and edges that should visibly jiggle. ζ 0.4, about 25% overshoot.
 * - snap: presses and the error shake. Fast, ζ 0.35.
 * - drift: content that follows the body, slower and with no visible overshoot. ζ 0.85.
 */
export const springs = {
  body: { stiffness: 380, damping: 26 },
  wobble: { stiffness: 520, damping: 18 },
  snap: { stiffness: 1100, damping: 23 },
  drift: { stiffness: 170, damping: 22 },
} satisfies Record<string, SpringConfig>;

const step = 1 / 240;

/** Slows every lab motion down, for stepping through a morph frame by frame. */
export const clock = { scale: 1 };

export class Spring {
  velocity = 0;
  target: number;

  constructor(
    public value: number,
    public config: SpringConfig = springs.body,
  ) {
    this.target = value;
  }

  /** Heads for `target`, keeping the current velocity. Under reduced motion, jumps there. */
  to(target: number, config?: SpringConfig) {
    this.target = target;
    if (config) this.config = config;
    if (reducedMotion()) this.snap(target);
    return this;
  }

  /** Puts the spring at `value`, at rest. */
  snap(value: number) {
    this.value = this.target = value;
    this.velocity = 0;
    return this;
  }

  /** Adds `velocity`, in units per second, as a push. */
  kick(velocity: number) {
    if (!reducedMotion()) this.velocity += velocity;
    return this;
  }

  /** Advances `dt` seconds, in fixed substeps so stiff springs stay stable. */
  advance(dt: number) {
    const { stiffness, damping, mass = 1 } = this.config;
    for (let left = dt; left > 1e-6; left -= step) {
      const h = Math.min(step, left);
      const force = -stiffness * (this.value - this.target) - damping * this.velocity;
      this.velocity += (force / mass) * h;
      this.value += this.velocity * h;
    }
  }

  get resting() {
    return Math.abs(this.value - this.target) < 0.01 && Math.abs(this.velocity) < 0.01;
  }
}

/** A spring from 0 to 1 sampled at 60 fps, so WAAPI keyframes can play it on the compositor. */
export function springCurve(config: SpringConfig, velocity = 0) {
  const spring = new Spring(0, config);
  spring.target = 1;
  spring.velocity = velocity;
  const samples = [0];
  for (let i = 0; i < 240 && !spring.resting; i++) {
    spring.advance(1 / 60);
    samples.push(spring.value);
  }
  samples[samples.length - 1] = 1;
  return samples;
}

/** Plays `frame(progress)` on `el` along a spring, or jumps to the end under reduced motion. */
export function springAnimate(
  el: Element,
  frame: (progress: number) => Keyframe,
  config: SpringConfig = springs.body,
  delay = 0,
) {
  const curve = reducedMotion() ? [0, 1] : springCurve(config);
  return el.animate(curve.map(frame), {
    duration: reducedMotion() ? 180 : (curve.length * 1000) / 60 / clock.scale,
    delay: reducedMotion() ? 0 : delay / clock.scale,
    easing: "linear",
    fill: "both",
  });
}
