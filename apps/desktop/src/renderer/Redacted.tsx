import { useEffect, useRef, useState } from "react";

const EMAIL = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/**
 * `value` with every character but `@`, `.`, `-`, and `_` swapped for one picked from `value`
 * itself, so the same email always gets the same placeholder of its shape, as T3 Code's
 * `redactedPlaceholder`.
 */
export function redactedPlaceholder(value: string): string {
  let state = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    state ^= value.charCodeAt(i);
    state = Math.imul(state, 0x01000193);
  }
  const next = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b);
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35);
    return ALPHABET[Math.abs(state) % ALPHABET.length]!;
  };
  return Array.from(value, (c) => ("@.-_".includes(c) ? c : next())).join("");
}

/** `text` for a plain-text place, such as an `aria-label`: its emails as "hidden email". */
export const withoutEmails = (text: string) => text.replace(new RegExp(EMAIL, "g"), "hidden email");

/**
 * `text` with each email in it blurred until hovered (PLX-1067), and the rest as it is. It keeps
 * the font and size around it, so `{label}` becomes `<Redacted text={label} />`.
 */
export function Redacted({ text }: { text: string }) {
  return <>{text.split(EMAIL).map((part, i) => (i % 2 ? <Email key={i} value={part} /> : part))}</>;
}

// What a keyboard reaches instead of an email inside it, such as a row's button.
const focusable =
  "a[href],button,input,select,textarea,summary,[tabindex],[role^='menuitem'],[role='tab'],[role='option']";

/**
 * One email as a placeholder of its shape under a blur, with the real address in the DOM only
 * while the pointer is over it or a keyboard has focused it or the control it's in. Screen readers
 * hear "Email hidden" until then.
 */
function Email({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // On its own, outside any control, it takes focus itself.
  const [alone, setAlone] = useState(false);
  useEffect(() => {
    const self = ref.current!;
    const host = self.parentElement?.closest<HTMLElement>(focusable) ?? self;
    setAlone(host === self);
    // Only keyboard focus: a click focuses a row too, and shouldn't leave its email showing.
    const focus = () => setFocused(host.matches(":focus-visible"));
    const blur = () => setFocused(false);
    host.addEventListener("focus", focus);
    host.addEventListener("blur", blur);
    if (document.activeElement === host) focus();
    return () => {
      host.removeEventListener("focus", focus);
      host.removeEventListener("blur", blur);
    };
  }, []);
  const shown = hovered || focused;
  return (
    <span
      ref={ref}
      tabIndex={alone ? 0 : undefined}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      className={`rounded-sm transition-[filter,color] duration-150 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none ${shown ? "" : "text-muted-foreground blur-xs select-none"}`}
    >
      {shown ? (
        value
      ) : (
        <>
          <span aria-hidden>{redactedPlaceholder(value)}</span>
          <span className="sr-only">Email hidden, hover or focus to show</span>
        </>
      )}
    </span>
  );
}
