import { z } from 'zod';
import type { ProductTrackingContext } from 'librechat-data-provider';

const recordSchema = z.strictObject({
  sessionId: z.uuid(),
  startedAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  /** The last activity timestamp that a tab reported. Shared so that only one tab reports it. */
  lastReportedActivityAt: z.number().int().nonnegative().optional(),
});

/** Prefix of the shared session keys. Logout removes them with the other account state. */
export const PRODUCT_SESSION_KEY_PREFIX = 'lc-product-session:';
/** Reports resolve to one activity interval, so marking activity more often adds only I/O. */
export const ACTIVITY_THROTTLE_MS = 5000;

export type SessionRecord = z.infer<typeof recordSchema>;
type SessionStorage = Pick<Storage, 'getItem' | 'setItem'>;
type SessionOptions = {
  key: string;
  idleTimeoutMs: number;
  storage?: SessionStorage;
  now: () => number;
  createId: () => string;
  /** Serializes session updates and activity reports across tabs when supported. */
  exclusive?: <T>(work: () => T) => Promise<T>;
};

/** A session contains activity timestamps only. It never receives interaction contents. */
export function createProductSession(options: SessionOptions) {
  let memory: SessionRecord | undefined;
  let tail: Promise<void> = Promise.resolve();
  let stopped = false;
  /** After the first failed write, stored records are older than memory and are not read. */
  let storage = options.storage;

  const read = (): SessionRecord | undefined => {
    try {
      const raw = storage?.getItem(options.key);
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
      storage?.setItem(options.key, JSON.stringify(record));
    } catch {
      // Keep a tab-local session when persistent browser storage is unavailable.
      storage = undefined;
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

  /** Runs after earlier work in this tab, and inside the cross-tab lock when one exists. */
  const serialized = (work: () => void): Promise<void> => {
    const next = tail.then(async () => {
      if (options.exclusive) {
        try {
          await options.exclusive(work);
        } catch {
          work();
        }
      } else {
        work();
      }
    });
    tail = next.catch(() => {});
    return next;
  };

  const activity = async (): Promise<ProductTrackingContext | undefined> => {
    let context: ProductTrackingContext | undefined;
    await serialized(() => {
      context = activityNow();
    });
    return context;
  };

  /**
   * Passes the record to `emit` when its latest activity is not reported yet, and marks it
   * reported in the same locked update. Only one tab reports each activity timestamp.
   */
  const report = (emit: (record: SessionRecord) => void): Promise<void> =>
    serialized(() => {
      const record = read();
      if (!record || record.lastReportedActivityAt === record.lastActivityAt) return;
      write({ ...record, lastReportedActivityAt: record.lastActivityAt });
      emit(record);
    });

  return {
    activity,
    activityNow,
    report,
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
