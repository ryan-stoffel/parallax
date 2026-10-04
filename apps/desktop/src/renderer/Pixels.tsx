/**
 * A 3 by 3 dot matrix for tasks about to start: a plus for one, and a dot a task for a list, up to
 * nine. In currentColor, with the rest of the grid faint.
 */
export function PixelStack({ count }: { count: number }) {
  const plus = [1, 3, 4, 5, 7];
  const lit = (i: number) => (count > 1 ? i < Math.min(count, 9) : plus.includes(i));
  return (
    <span aria-hidden className="grid size-3.5 shrink-0 grid-cols-3 gap-[1.5px] p-px">
      {Array.from({ length: 9 }, (_, i) => (
        <span
          key={i}
          className={`rounded-[1px] bg-current transition-opacity duration-150 ${lit(i) ? "opacity-100" : "opacity-20"}`}
        />
      ))}
    </span>
  );
}
