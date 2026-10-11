// Messages waiting to reach plxd, as T3 Code's mobile outbox keeps them: every message goes
// through here, is kept until plxd takes it, and waits while the phone is offline, sent in order
// once it connects. Each carries the id plxd's dispatch is idempotent on (0052, 0059), so a send
// whose answer was lost goes again safely.

import type { RpcError } from "../../desktop/src/preload/bridge";

export interface Outgoing {
  /** The message's id, which is its `turnId` and its dispatch's `commandId`. */
  id: string;
  threadId: string;
  text: string;
  steer: boolean;
}

/** What one try did: plxd took it, the phone isn't connected, or plxd refused it. */
export type Sent = "sent" | "offline" | { error: RpcError };

export class Outbox {
  private draining = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    public messages: Outgoing[],
    private readonly send: (message: Outgoing) => Promise<Sent>,
    private readonly save: (messages: Outgoing[]) => void,
    /** Hears a message plxd refused, which leaves the outbox. */
    private readonly refused: (message: Outgoing, error: RpcError) => void,
  ) {}

  add(message: Outgoing): void {
    this.set([...this.messages, message]);
    void this.drain();
  }

  /** Sends what waits, oldest first, until the outbox is empty or the phone is offline. */
  async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.messages[0]; next; next = this.messages[0]) {
        const sent = await this.send(next);
        if (sent === "offline") return;
        this.set(this.messages.filter((m) => m !== next));
        if (sent !== "sent") this.refused(next, sent.error);
      }
    } finally {
      this.draining = false;
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(messages: Outgoing[]): void {
    this.messages = messages;
    this.save(messages);
    for (const listener of this.listeners) listener();
  }
}
