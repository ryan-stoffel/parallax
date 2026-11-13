import { t } from "i18next";
import { GripVertical, Plus, X, type LucideIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type LiHTMLAttributes,
  type ReactNode,
} from "react";

import type { DeviceHost } from "../../preload/bridge";
import { isRelay, type RouteEdit } from "../../preload/routeList";
import { badge } from "./connectionParts";
import { primaryButton, quietButton, rowField } from "./parts";

// A computer's routes, as its opened card in Settings > Computers lists them (PLX-1492).

/**
 * What kind of route `route` is, for people: Parallax Connect, a Tailscale address (its 100.64/10 or
 * fd7a:115c:a1e0::/48 range, or a ts.net name), an address on a private network, or any other, which
 * is only Direct.
 */
export function routeKind(route: string): string {
  if (isRelay(route)) return "Parallax Connect";
  const host = route.replace(/^\[|\](:\d+)?$/g, "").replace(/:\d+$/, "");
  if (
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^fd7a:115c:a1e0:/i.test(host) ||
    host.endsWith(".ts.net")
  )
    return "Tailscale";
  const local =
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.)/.test(host) ||
    /^(f[cd]|fe80)/i.test(host) ||
    host === "localhost" ||
    host.endsWith(".local");
  return local ? t("Same network") : t("Direct");
}

/**
 * One route on one line: `handle` first, its kind, its address, what's true of it as small marks,
 * then `children`, its buttons. `rowProps` makes it a place to drop a dragged route.
 */
function RouteRow({
  route,
  kind,
  address,
  notes,
  handle,
  dragged,
  rowProps,
  children,
}: {
  route: string;
  kind: string;
  address?: string;
  notes?: (string | false | undefined)[];
  handle?: ReactNode;
  /** It's the one being dragged. */
  dragged?: boolean;
  rowProps?: Pick<
    LiHTMLAttributes<HTMLLIElement>,
    "draggable" | "onDragStart" | "onDragOver" | "onDrop" | "onDragEnd"
  >;
  children?: ReactNode;
}) {
  const marks = (notes ?? []).filter((n): n is string => !!n);
  return (
    <li
      data-route={route}
      {...rowProps}
      className={`group/route flex min-h-10 items-center gap-2 border-border/40 py-1.5 not-last:border-b ${dragged ? "opacity-40" : ""}`}
    >
      {handle}
      {/* Kind, address and marks wrap as whole parts on a narrow card. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="text-body">{kind}</span>
        {address && (
          <span className="min-w-0 font-mono text-meta [overflow-wrap:anywhere] text-muted-foreground">
            {/* On a narrow card it breaks before its port, not inside a number. */}
            {address.slice(0, address.lastIndexOf(":"))}
            <wbr />
            {address.slice(address.lastIndexOf(":"))}
          </span>
        )}
        {marks.map((m) => (
          <span key={m} className={`${badge} ml-auto text-muted-foreground`}>
            {m}
          </span>
        ))}
      </div>
      {children}
    </li>
  );
}

/** Routes nothing here changes: a paired computer's addresses, a Tailscale device's, an SSH host's. */
export function FixedRoutes({
  name,
  routes,
}: {
  name: string;
  routes: { kind: string; address?: string; connected?: boolean }[];
}) {
  if (!routes.length) return null;
  return (
    <ul aria-label={t("Routes to {{name}}", { name })}>
      {routes.map((r) => (
        <RouteRow
          key={`${r.kind} ${r.address}`}
          route={r.address ?? r.kind}
          kind={r.kind}
          {...(r.address && { address: r.address })}
          notes={[r.connected && t("Connected")]}
        />
      ))}
    </ul>
  );
}

/** A small icon button on a route's row. */
function RouteButton({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-hover hover:text-foreground [&_svg]:size-4"
    >
      <Icon aria-hidden />
    </button>
  );
}

/** `list` with `route` moved to where `over` is. */
const moved = (list: string[], route: string, over: string) => {
  const rest = list.filter((r) => r !== route);
  rest.splice(list.indexOf(over), 0, route);
  return rest;
};

/**
 * An account computer's routes in this app (0091), tried top to bottom. Each is dragged by its
 * handle to a new place, or moved with the arrow keys while its handle has focus; either saves as
 * the one-step moves `editRoutes` takes. Add route takes an address of its own. Any route but
 * Parallax Connect, which works from anywhere, can be removed: an added one is forgotten, and one
 * the computer reports is hidden on this device until Reset routes in its card's menu, or Add route
 * with the same address.
 */
export function AccountRoutes({
  device,
  connected,
}: {
  device: Pick<DeviceHost, "id" | "name" | "routes" | "addedRoutes" | "route" | "routesChanged">;
  connected: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  // The route being dragged and where it is now, from a press on its handle until the drop is saved.
  const [drag, setDrag] = useState<{
    route: string;
    order: string[];
    started?: boolean;
    saving?: boolean;
  }>();
  // What the last keyboard move did, read out.
  const [said, setSaid] = useState("");
  // The handle to keep focus on once a keyboard move has re-rendered the list.
  const focusing = useRef<string>(undefined);
  const handles = useRef(new Map<string, HTMLButtonElement>());
  const routes = device.routes ?? [];
  const shown = drag?.order ?? routes;
  const nameOf = (route: string) => (isRelay(route) ? "Parallax Connect" : route);
  useEffect(() => {
    if (focusing.current) handles.current.get(focusing.current)?.focus();
  });
  const edit = async (change: RouteEdit) => {
    const why = await window.parallax.editRoutes(device.id, change);
    setError(why);
    return why;
  };
  // Moves `route` from where it is to `to`, one step at a time, stopping at a step that fails.
  const moveTo = async (route: string, to: number) => {
    const from = routes.indexOf(route);
    const by = to > from ? 1 : -1;
    for (let at = from; at !== to; at += by) if (await edit({ move: route, by })) return false;
    return true;
  };
  const onKey = (event: KeyboardEvent, route: string, at: number) => {
    const by = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    if (!by) return;
    event.preventDefault();
    const to = at + by;
    if (to < 0 || to >= routes.length) return;
    focusing.current = route;
    void moveTo(route, to).then((done) => {
      if (done)
        setSaid(
          t("{{name}} moved to {{position}} of {{total}}.", {
            name: nameOf(route),
            position: to + 1,
            total: routes.length,
          }),
        );
    });
  };
  const dragProps = (route: string) => ({
    // Only the handle starts a drag, so an address can still be selected.
    draggable: drag?.route === route,
    onDragStart: (event: DragEvent) => {
      setDrag((d) => d && { ...d, started: true });
      event.dataTransfer?.setData("text/plain", route);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (event: DragEvent) => {
      if (!drag) return;
      event.preventDefault();
      if (route !== drag.route) setDrag({ ...drag, order: moved(drag.order, drag.route, route) });
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      if (!drag) return;
      setDrag({ ...drag, saving: true });
      void moveTo(drag.route, drag.order.indexOf(drag.route)).finally(() => setDrag(undefined));
    },
    // Dropped anywhere else, it goes back.
    onDragEnd: () => setDrag((d) => (d?.saving ? d : undefined)),
  });
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!(await edit({ add: typed }))) setTyped("");
  };
  return (
    <>
      <ul aria-label={t("Routes to {{name}}", { name: device.name })}>
        {shown.map((route, i) => {
          const name = nameOf(route);
          const added = device.addedRoutes?.includes(route);
          return (
            <RouteRow
              key={route}
              route={route}
              kind={routeKind(route)}
              {...(!isRelay(route) && { address: route })}
              notes={[added && t("Added"), connected && device.route === route && t("Connected")]}
              dragged={drag?.route === route}
              rowProps={dragProps(route)}
              handle={
                <button
                  type="button"
                  ref={(el) => {
                    if (el) handles.current.set(route, el);
                    else handles.current.delete(route);
                  }}
                  aria-label={t("Move {{name}}", { name })}
                  aria-description={t("Drag, or press the up and down arrow keys.")}
                  title={t("Drag to reorder")}
                  onPointerDown={() => setDrag({ route, order: routes })}
                  onPointerUp={() => setDrag((d) => (d?.started ? d : undefined))}
                  onKeyDown={(event) => onKey(event, route, i)}
                  // Moving its row blurs it with nowhere to go. Focus going elsewhere ends the hold.
                  onBlur={(event) => {
                    if (event.relatedTarget) focusing.current = undefined;
                  }}
                  className="-ml-1.5 grid h-7 w-5 shrink-0 cursor-grab place-items-center rounded-md text-faint-foreground hover:bg-hover hover:text-foreground active:cursor-grabbing [&_svg]:size-4"
                >
                  <GripVertical aria-hidden />
                </button>
              }
            >
              {isRelay(route) ? (
                // Keeps the marks in one column with the rows that have Remove.
                <span aria-hidden className="size-7 shrink-0" />
              ) : (
                <RouteButton
                  icon={X}
                  label={t("Remove {{name}}", { name })}
                  onClick={() => void edit({ remove: route })}
                />
              )}
            </RouteRow>
          );
        })}
      </ul>
      <p role="status" className="sr-only">
        {said}
      </p>
      {adding ? (
        <form
          onSubmit={(event) => void add(event)}
          className="mt-2 flex flex-wrap items-center gap-2"
        >
          <input
            aria-label={t("Address")}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="studio.example.com:7400"
            spellCheck={false}
            autoFocus
            className={`${rowField} font-mono`}
          />
          <button type="submit" className={primaryButton}>
            {t("Add")}
          </button>
          <button
            type="button"
            className={quietButton}
            onClick={() => {
              setAdding(false);
              setTyped("");
              setError(undefined);
            }}
          >
            {t("Cancel")}
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${quietButton} mt-1 -ml-2.5 flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <Plus aria-hidden />
          {t("Add route")}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-body text-danger">
          {error}
        </p>
      )}
      <p className="mt-2 text-meta text-faint-foreground">
        {adding
          ? t(
              "A DNS name or address of this computer, with a port if it isn't 7341. It must present this computer's key before anything is sent. plxd only accepts connections from private networks, so a port forward from the internet won't connect.",
            )
          : device.routesChanged
            ? t(
                "Tried top to bottom. Saved on this device. Reset routes, in this computer's menu, undoes your changes.",
              )
            : t("Tried top to bottom. Saved on this device.")}
      </p>
    </>
  );
}
