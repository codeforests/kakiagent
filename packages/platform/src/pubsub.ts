import { Redis } from 'iovalkey';

/**
 * Valkey pub/sub channel names (ADR-017). Every key is tenant-prefixed (ADR-005).
 * Pub/sub only notifies: the event is already committed to Postgres, and clients that
 * miss a notification resume from the database by sequence number.
 */
export const channels = {
  conversation: (tenantId: string, conversationId: string) =>
    `t:${tenantId}:conv:${conversationId}`,
  inbox: (tenantId: string) => `t:${tenantId}:inbox`,
};

export interface Publisher {
  publish(channel: string, event: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface Subscriber {
  subscribe(channel: string, onEvent: (event: unknown) => void): Promise<() => Promise<void>>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createPublisher(url: string): Publisher {
  const client = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2 });
  return {
    async publish(channel, event) {
      await client.publish(channel, JSON.stringify(event));
    },
    async close() {
      await client.quit();
    },
  };
}

/** One connection per process; channels are reference-counted across listeners. */
export function createSubscriber(url: string): Subscriber {
  const sub = new Redis(url, { lazyConnect: false });
  const cmd = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 1 });
  const listeners = new Map<string, Set<(event: unknown) => void>>();

  sub.on('message', (channel: string, payload: string) => {
    const set = listeners.get(channel);
    if (!set) return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    for (const fn of set) fn(event);
  });

  return {
    async subscribe(channel, onEvent) {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
        await sub.subscribe(channel);
      }
      set.add(onEvent);
      return async () => {
        const current = listeners.get(channel);
        if (!current) return;
        current.delete(onEvent);
        if (current.size === 0) {
          listeners.delete(channel);
          await sub.unsubscribe(channel);
        }
      };
    },
    async ping() {
      return (await cmd.ping()) === 'PONG';
    },
    async close() {
      sub.disconnect();
      cmd.disconnect();
    },
  };
}
