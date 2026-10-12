import { expect, test } from "vitest";

import { Outbox, type Outgoing, type Sent } from "./outbox";

const message = (id: string): Outgoing => ({ id, threadId: "t", text: id, steer: false });

test("messages wait offline, go in order once connected, and a refused one leaves", async () => {
  let online = false;
  const tried: string[] = [];
  const saved: string[][] = [];
  const refused: string[] = [];
  const outbox = new Outbox(
    [message("a")],
    async (m): Promise<Sent> => {
      if (!online) return "offline";
      tried.push(m.id);
      return m.id === "b" ? { error: { code: -32602, message: "too long" } } : "sent";
    },
    (messages) => saved.push(messages.map((m) => m.id)),
    (m) => refused.push(m.id),
  );
  outbox.add(message("b"));
  outbox.add(message("c"));
  await outbox.drain();
  expect(outbox.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
  expect(saved.at(-1)).toEqual(["a", "b", "c"]);

  online = true;
  await outbox.drain();
  expect(tried).toEqual(["a", "b", "c"]);
  expect(refused).toEqual(["b"]);
  expect(outbox.messages).toEqual([]);
  expect(saved.at(-1)).toEqual([]);
});
