// The motion tokens (0092) for animations started from JS. CSS takes the same ones from
// index.css's @theme (`duration-fast`, `ease-out`, `var(--transition-duration-fast)`), and
// motion.test.ts keeps the two in step.

/** How long a motion takes, in ms: fast for small things (menus, tooltips, hovers, exits),
 * base for dialogs and panels, slow for what travels across the window (toasts, drawers). */
export const duration = { fast: 120, base: 180, slow: 240 } as const;

/** Out for what arrives, in for what leaves, in-out for what moves, spring for a small overshoot. */
export const easing = {
  out: "cubic-bezier(0.23, 1, 0.32, 1)",
  in: "cubic-bezier(0.55, 0, 1, 0.45)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

/** Whether motion is off, by Settings > Appearance or the OS (appearance.ts sets the class). */
export const reducedMotion = () => document.documentElement.classList.contains("reduce-motion");

/**
 * `el.animate`, at base and out unless `options` says otherwise, or nothing under reduced motion,
 * where the element just takes its end state. CSS animations stop on their own under reduced
 * motion (index.css); JS ones go through here.
 */
export function animate(
  el: Element,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  options: KeyframeAnimationOptions = {},
): Animation | undefined {
  if (reducedMotion() || typeof el.animate !== "function") return undefined;
  return el.animate(keyframes, { duration: duration.base, easing: easing.out, ...options });
}
