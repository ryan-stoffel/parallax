import type { WebContents } from "electron";

import type { DeviceStreamParams } from "../protocol/generated/protocol";
import type { Connection } from "./connection";
import { perWindow } from "./windows";

/** A window's device stream: the connection that relays it, and plxd's id for it there. */
type Opened = { connection: Connection; streamId: string };
/** Each window's device streams (PLX-886), by the id it gave each. */
const opened = new Map<WebContents, Map<string, Opened>>();

/**
 * Opens `sender`'s device stream `params.streamId` on `connection`, in place of any it had with
 * that id. What plxd relays goes only to `sender`, as `parallax:device` messages with its id.
 * plxd's id for it carries the window's, so two windows' ids never meet on one connection.
 * Resolves to an error for people, or undefined once it's open.
 */
export async function openDeviceStream(
  sender: WebContents,
  connection: Connection,
  params: DeviceStreamParams,
): Promise<string | undefined> {
  const own = windowStreams(sender);
  const id = params.streamId;
  closeDeviceStream(sender, id);
  const entry: Opened = { connection, streamId: `${sender.id}:${id}` };
  own.set(id, entry);
  const error = await connection.openDeviceStream(
    { ...params, streamId: entry.streamId },
    (message) => {
      if (message.type === "end" && own.get(id) === entry) own.delete(id);
      if (!sender.isDestroyed()) sender.send("parallax:device", id, message);
    },
  );
  if (error && own.get(id) === entry) own.delete(id);
  return error;
}

export function sendDeviceStream(sender: WebContents, id: string, data: Uint8Array | string) {
  const entry = opened.get(sender)?.get(id);
  entry?.connection.sendDeviceStream(entry.streamId, data);
}

export function closeDeviceStream(sender: WebContents, id: string): void {
  const entry = opened.get(sender)?.get(id);
  opened.get(sender)?.delete(id);
  entry?.connection.closeDeviceStream(entry.streamId);
}

/** A window's device streams, which close when it reloads or closes. */
const windowStreams = (sender: WebContents) =>
  perWindow(opened, sender, (own) => {
    for (const { connection, streamId } of own.values()) connection.closeDeviceStream(streamId);
    own.clear();
  });
