import { z } from 'zod';

const timeoutMs = z.number().int().positive().max(3_600_000).optional();

/** Operator-tunable client request deadlines in milliseconds, set under `clientTimeouts`. */
export const clientTimeoutsSchema = z
  .object({
    refreshMs: timeoutMs,
    ttsMs: timeoutMs,
    sharepointMs: timeoutMs,
    cloudfrontMs: timeoutMs,
  })
  .strict();

export type TClientTimeouts = z.infer<typeof clientTimeoutsSchema>;

export const DEFAULT_CLIENT_TIMEOUTS: Required<TClientTimeouts> = {
  refreshMs: 30_000,
  ttsMs: 60_000,
  sharepointMs: 5 * 60_000,
  cloudfrontMs: 15_000,
};

let resolved: TClientTimeouts = {};

/** Applies the timeouts published in the startup config; invalid values keep the defaults. */
export function setClientTimeouts(timeouts?: TClientTimeouts | null): void {
  const parsed = clientTimeoutsSchema.safeParse(timeouts ?? {});
  resolved = parsed.success ? parsed.data : {};
}

export function getClientTimeout(key: keyof TClientTimeouts): number {
  return resolved[key] ?? DEFAULT_CLIENT_TIMEOUTS[key];
}
