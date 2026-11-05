import { ChevronDown, ChevronUp, Plus, Trash2, type LucideIcon } from "lucide-react";
import { forwardRef, useState, type FormEvent } from "react";

import type { DeviceHost } from "../../preload/bridge";
import { isRelay, type RouteEdit } from "../../preload/routeList";
import { field, quietButton } from "./parts";

/** A small icon button, as a Connect device's row has for its menu. */
function RouteButton({
  icon: Icon,
  label,
  type = "button",
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
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
 * arrows, and an address to add. Only an added route has a remove button: the computer reports its
 * own again, and the relay is the route that works from anywhere.
 */
export const RoutesDialog = forwardRef<
  HTMLDialogElement,
  {
    device: Pick<DeviceHost, "id" | "name" | "routes" | "addedRoutes" | "route">;
    connected: boolean;
  }
>(function RoutesDialog({ device, connected }, ref) {
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
    <dialog
      ref={ref}
      aria-label={`Routes to ${device.name}`}
      className="m-auto w-[30rem] rounded-xl border border-border bg-surface text-foreground shadow-composer backdrop:bg-black/50"
    >
      <div className="px-5 pt-4 pb-4">
        <h2 className="text-reading font-semibold">Routes to {device.name}</h2>
        <p className="mt-1.5 text-body text-muted-foreground">
          Tried in this order. Until you move one, direct routes start together and Parallax Relay
          200 ms later. Saved on this device.
        </p>
        <ul className="mt-3 rounded-lg border border-border">
          {routes.map((route, i) => {
            const relay = isRelay(route);
            const name = relay ? "Parallax Relay" : route;
            const added = device.addedRoutes?.includes(route);
            return (
              <li
                key={route}
                data-route={route}
                className="flex items-center gap-1 border-border py-1.5 pr-1.5 pl-3 not-last:border-b"
              >
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-body ${relay ? "" : "font-mono"}`}>{name}</p>
                  {(added || (connected && device.route === route)) && (
                    <p className="text-meta text-faint-foreground">
                      {[added && "Added", connected && device.route === route && "Connected"]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                </div>
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
                {added && (
                  <RouteButton
                    icon={Trash2}
                    label={`Remove ${name}`}
                    onClick={() => void edit({ remove: route })}
                  />
                )}
              </li>
            );
          })}
        </ul>
        <form onSubmit={(event) => void add(event)} className="mt-3 flex items-center gap-1">
          <input
            aria-label="Address"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="studio.example.com:7400"
            spellCheck={false}
            className={`${field} mt-0 font-mono`}
          />
          <RouteButton icon={Plus} label="Add route" type="submit" />
        </form>
        {error && (
          <p role="alert" className="mt-1.5 text-body text-danger">
            {error}
          </p>
        )}
        <p className="mt-2 text-meta text-faint-foreground">
          A DNS name or address of this computer, with a port if it isn't 7341. It must present this
          computer's key before anything is sent. plxd only accepts connections from private
          networks, so a port forward from the internet won't connect.
        </p>
        <form method="dialog" className="mt-3 flex justify-end">
          <button type="submit" className={quietButton}>
            Done
          </button>
        </form>
      </div>
    </dialog>
  );
});
