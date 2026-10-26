import { ArrowUpRight, Bell } from "lucide-react";
import { useEffect } from "react";

import { locale } from "./locale";
import { clearLog, icons, markLogSeen, useNotificationLog, type Logged } from "./notifications";
import { age } from "./Sidebar";

const link =
  "inline-flex items-center gap-0.5 text-body text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground";

/**
 * The Notifications page, in place of the main pane (PLX-1015): every notice this session
 * showed, newest first, each with its time and action. Everything in it is seen while it's open.
 */
export function NotificationsPage() {
  const { list, unseen } = useNotificationLog();
  useEffect(() => {
    if (unseen) markLogSeen();
  }, [unseen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {list.length === 0 ? (
        <div className="grid flex-1 place-items-center">
          <div className="flex flex-col items-center gap-1 text-center">
            <Bell aria-hidden className="mb-2 size-6 text-faint-foreground" />
            <h2 className="text-reading font-medium">No notifications yet</h2>
            <p className="text-body text-faint-foreground">
              What Parallax tells you this session, such as a thread finishing, shows up here.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="mx-auto flex w-full max-w-3xl items-center px-6 pt-4">
            <span className="flex-1 text-body text-faint-foreground">
              {list.length === 1 ? "1 notification" : `${list.length} notifications`}
            </span>
            <button
              type="button"
              onClick={clearLog}
              className="rounded-md px-2 py-1 text-body text-muted-foreground hover:bg-hover hover:text-foreground"
            >
              Clear all
            </button>
          </div>
          <ul
            aria-label="Notifications"
            className="mx-auto mt-2 w-full max-w-3xl min-h-0 flex-1 overflow-y-auto px-4 pb-4"
          >
            {list.map((n) => (
              <Row key={n.id} notice={n} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Row({ notice }: { notice: Logged }) {
  const { tone, title, body, action, at } = notice;
  return (
    <li className="flex gap-2.5 rounded-lg px-2 py-2">
      <span className="mt-0.5">{icons[tone]}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-body">
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          <time
            dateTime={at}
            title={new Date(at).toLocaleString(locale())}
            className="shrink-0 text-meta text-faint-foreground"
          >
            {age(at)}
          </time>
        </span>
        {body && (
          <span className="mt-0.5 line-clamp-3 block text-body break-words text-muted-foreground">
            {body}
          </span>
        )}
        {action && (
          <span className="mt-0.5 block">
            {"href" in action ? (
              <a href={action.href} className={link}>
                {action.label}
                <ArrowUpRight className="size-3" />
              </a>
            ) : (
              <button type="button" className={link} onClick={action.run}>
                {action.label}
              </button>
            )}
          </span>
        )}
      </span>
    </li>
  );
}
