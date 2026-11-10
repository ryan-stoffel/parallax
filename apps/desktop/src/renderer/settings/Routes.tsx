import { ChevronDown, ChevronUp, Plus, Trash2, type LucideIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";

import type { DeviceHost } from "../../preload/bridge";
import { isRelay, type RouteEdit } from "../../preload/routeList";
import { primaryButton, quietButton, rowField } from "./parts";

// A computer's routes, as its opened card in Settings > Computers lists them (PLX-1492).

/**
 * What kind of route `route` is, for people: Parallax Relay, a Tailscale address (its 100.64/10 or
 * fd7a:115c:a1e0::/48 range, or a ts.net name), an address on a private network, or any other, which
 * is only Direct.
 */
export function routeKind(route: string): string {
  if (isRelay(route)) return "Parallax Relay";
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
  return local ? "Same network" : "Direct";
}

/** One route: its kind, then its address and what's true of it, with `children`, its buttons. */
function RouteRow({
  route,
  kind,
  address,
  notes,
  children,
}: {
  route: string;
  kind: string;
  address?: string;
  notes?: (string | false | undefined)[];
  children?: ReactNode;
}) {
  const said = (notes ?? []).filter(Boolean).join(" · ");
  return (
    <li data-route={route} className="flex min-h-10 items-center gap-1 py-1">
      <div className="min-w-0 flex-1">
        <p className="text-body">{kind}</p>
        {(address || said) && (
          <p className="text-meta text-muted-foreground">
            {address && <span className="font-mono break-all">{address}</span>}
            {address && said && " · "}
            {said}
          </p>
        )}
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
    <ul aria-label={`Routes to ${name}`}>
      {routes.map((r) => (
        <RouteRow
          key={`${r.kind} ${r.address}`}
          route={r.address ?? r.kind}
          kind={r.kind}
          {...(r.address && { address: r.address })}
          notes={[r.connected && "Connected"]}
        />
      ))}
    </ul>
  );
}

/** A small icon button on a route's row. */
function RouteButton({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground enabled:hover:bg-hover enabled:hover:text-foreground disabled:opacity-30 [&_svg]:size-4"
    >
      <Icon aria-hidden />
    </button>
  );
}

/**
 * An account computer's routes in this app (0091): how they're tried, best first, moved with
 * arrows, and Add route for an address of its own. Only an added route has a remove button: the
 * computer reports its own again, and the relay is the route that works from anywhere.
 */
export function AccountRoutes({
  device,
  connected,
}: {
  device: Pick<DeviceHost, "id" | "name" | "routes" | "addedRoutes" | "route">;
  connected: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string>();
  const routes = device.routes ?? [];
  const edit = async (change: RouteEdit) => {
    const why = await window.parallax.editRoutes(device.id, change);
    setError(why);
    return why;
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!(await edit({ add: typed }))) setTyped("");
  };
  return (
    <>
      <ul aria-label={`Routes to ${device.name}`}>
        {routes.map((route, i) => {
          const relay = isRelay(route);
          const name = relay ? "Parallax Relay" : route;
          const added = device.addedRoutes?.includes(route);
          return (
            <RouteRow
              key={route}
              route={route}
              kind={routeKind(route)}
              {...(!relay && { address: route })}
              notes={[added && "Added", connected && device.route === route && "Connected"]}
            >
              <RouteButton
                icon={ChevronUp}
                label={`Move ${name} up`}
                disabled={i === 0}
                onClick={() => void edit({ move: route, by: -1 })}
              />
              <RouteButton
                icon={ChevronDown}
                label={`Move ${name} down`}
                disabled={i === routes.length - 1}
                onClick={() => void edit({ move: route, by: 1 })}
              />
              {added ? (
                <RouteButton
                  icon={Trash2}
                  label={`Remove ${name}`}
                  onClick={() => void edit({ remove: route })}
                />
              ) : (
                // Keeps every row's arrows in one column, while a row has Remove.
                !!device.addedRoutes?.length && <span aria-hidden className="size-7 shrink-0" />
              )}
            </RouteRow>
          );
        })}
      </ul>
      {adding ? (
        <form
          onSubmit={(event) => void add(event)}
          className="mt-1 flex flex-wrap items-center gap-2"
        >
          <input
            aria-label="Address"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="studio.example.com:7400"
            spellCheck={false}
            autoFocus
            className={`${rowField} font-mono`}
          />
          <button type="submit" className={primaryButton}>
            Add
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
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`${quietButton} mt-1 -ml-2.5 flex items-center gap-1 [&_svg]:size-3.5`}
        >
          <Plus aria-hidden />
          Add route
        </button>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-body text-danger">
          {error}
        </p>
      )}
      <p className="mt-2 text-meta text-faint-foreground">
        {adding
          ? "A DNS name or address of this computer, with a port if it isn't 7341. It must present this computer's key before anything is sent. plxd only accepts connections from private networks, so a port forward from the internet won't connect."
          : "Tried in this order. Until you move one, direct routes start together and Parallax Relay 200 ms later. Saved on this device."}
      </p>
    </>
  );
}
