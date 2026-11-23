import qrcode from "qrcode-generator";
import { useMemo } from "react";

/** A QR code's quiet zone, in modules, as the standard asks. */
const QUIET = 4;

/** `value`'s QR code as its side in modules and one SVG path of its dark ones. */
export function qrPath(value: string): { size: number; path: string } {
  const code = qrcode(0, "M");
  code.addData(value);
  code.make();
  const size = code.getModuleCount();
  let path = "";
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++)
      if (code.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`;
  return { size, path };
}

/**
 * `value` as a QR code named `label`: black on a white tile in both themes, so a phone's camera
 * reads it on a dark window too.
 */
export function QrCode({
  value,
  label,
  className = "",
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { size, path } = useMemo(() => qrPath(value), [value]);
  const side = size + QUIET * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-QUIET} ${-QUIET} ${side} ${side}`}
      shapeRendering="crispEdges"
      className={`rounded-lg bg-white ${className}`}
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
