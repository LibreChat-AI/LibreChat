import { z } from 'zod';
import type { ProductTrackingContext } from 'librechat-data-provider';

const recordSchema = z.strictObject({
  sessionId: z.uuid(),
  startedAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
});

type SessionRecord = z.infer<typeof recordSchema>;
type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;
type SessionOptions = {
  key: string;
  idleTimeoutMs: number;
  storage?: SessionStorage;
  now: () => number;
  createId: () => string;
  /** Serializes session creation and expiry across tabs when supported. */
  exclusive?: <T>(work: () => T) => Promise<T>;
};

/** A session contains activity timestamps only. It never receives interaction contents. */
export function createProductSession(options: SessionOptions) {
  let memory: SessionRecord | undefined;
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;

  const read = (): SessionRecord | undefined => {
    try {
      const raw = options.storage?.getItem(options.key);
      if (raw) {
        const parsed = recordSchema.safeParse(JSON.parse(raw));
        if (parsed.success && parsed.data.lastActivityAt >= parsed.data.startedAt) {
          memory = parsed.data;
        }
      }
    } catch {
      // Storage restrictions must not prevent product actions.
    }
    return memory;
  };

  const write = (record: SessionRecord) => {
    memory = record;
    try {
      options.storage?.setItem(options.key, JSON.stringify(record));
    } catch {
      // Keep a tab-local session when persistent browser storage is unavailable.
    }
  };

  /** Explicit sends must not wait for another tab's lock. */
  const activityNow = (): ProductTrackingContext | undefined => {
    if (stopped) return undefined;
    const now = options.now();
    const previous = read();
    const active =
      previous &&
      now >= previous.lastActivityAt &&
      now - previous.lastActivityAt < options.idleTimeoutMs;
    const record = active
      ? { ...previous, lastActivityAt: Math.max(previous.lastActivityAt, now) }
      : { sessionId: options.createId(), startedAt: now, lastActivityAt: now };
    write(record);
    return { sessionId: record.sessionId };
  };

  const activity = async (): Promise<ProductTrackingContext | undefined> => {
    let context: ProductTrackingContext | undefined;
    const update = () => {
      context = activityNow();
    };
    const next = tail.then(async () => {
      if (options.exclusive) {
        try {
          await options.exclusive(update);
        } catch {
          update();
        }
      } else {
        update();
      }
    });
    tail = next.catch(() => {});
    await next;
    return context;
  };

  return {
    activity,
    activityNow,
    snapshot: read,
    peek(): ProductTrackingContext | undefined {
      const record = read();
      const now = options.now();
      if (
        !record ||
        now < record.lastActivityAt ||
        now - record.lastActivityAt >= options.idleTimeoutMs
      ) {
        return undefined;
      }
      return { sessionId: record.sessionId };
    },
    stop() {
      stopped = true;
    },
  };
}
