import type { ButtonHTMLAttributes, ReactNode } from "react";

import { icons } from "../icons";

export type ButtonVariant = "primary" | "quiet" | "outline" | "danger";
export type ButtonSize = "sm" | "md";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary font-medium text-primary-foreground enabled:hover:opacity-90",
  quiet: "text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground",
  outline: "border border-border text-foreground enabled:hover:bg-hover",
  danger: "bg-danger font-medium text-danger-foreground enabled:hover:opacity-90",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5",
  md: "h-8 px-3",
};

/**
 * A button's classes, for an element that looks like one but isn't a `Button`, such as a link or
 * a form's submit. Primary is the one action a view asks for, quiet the rest, outline a second
 * choice beside a primary, and danger an action that destroys something.
 */
export const buttonClass = (variant: ButtonVariant = "quiet", size: ButtonSize = "md") =>
  `inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-body whitespace-nowrap transition-[color,background-color,opacity] disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 ${sizes[size]} ${variants[variant]}`;

/**
 * A text button, with an optional leading icon among its children. `variant` defaults to quiet and
 * `size` to md (32px); sm (28px) goes in rows and cards. `className` adds to its classes.
 */
export function Button({
  variant,
  size,
  className = "",
  type = "button",
  ...props
}: { variant?: ButtonVariant; size?: ButtonSize } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={`${buttonClass(variant, size)} ${className}`} {...props} />;
}

/** An on/off switch named `label`. Inside a clickable row it toggles only itself. */
export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className="relative h-5 w-9 shrink-0 rounded-full bg-faint-foreground transition-colors outline-offset-2 aria-checked:bg-accent disabled:opacity-50"
    >
      <span
        aria-hidden
        className={`absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : ""}`}
      />
    </button>
  );
}

/**
 * A checkbox: a native one, drawn in the app's look. With `children` it's a label around the box
 * and that text; without, `label` names it.
 */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  children,
}: {
  label?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const box = (
    <span
      className={`relative grid size-4 shrink-0 place-items-center ${children ? "" : "has-disabled:opacity-50"}`}
    >
      <input
        type="checkbox"
        aria-label={children ? undefined : label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer size-4 appearance-none rounded-sm border border-faint-foreground/60 transition-colors outline-offset-2 checked:border-accent checked:bg-accent not-checked:enabled:hover:border-faint-foreground"
      />
      <icons.done
        aria-hidden
        strokeWidth={3}
        className="pointer-events-none absolute size-3 text-accent-foreground opacity-0 peer-checked:opacity-100"
      />
    </span>
  );
  if (!children) return box;
  return (
    <label className="flex items-center gap-2 text-body has-disabled:opacity-50">
      {box}
      {children}
    </label>
  );
}
