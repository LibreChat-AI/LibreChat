import { z } from 'zod';

const timeoutMs = z.number().int().positive().max(3_600_000).optional();

/** Operator-tunable client limits: request deadlines in milliseconds and upload concurrency. */
export const clientLimitsSchema = z
  .object({
    refreshMs: timeoutMs,
    ttsMs: timeoutMs,
    sharepointMs: timeoutMs,
    cloudfrontMs: timeoutMs,
    uploadConcurrency: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export type TClientLimits = z.infer<typeof clientLimitsSchema>;

export const DEFAULT_CLIENT_LIMITS: Required<TClientLimits> = {
  refreshMs: 30_000,
  ttsMs: 60_000,
  sharepointMs: 5 * 60_000,
  cloudfrontMs: 15_000,
  uploadConcurrency: 3,
};

let resolved: TClientLimits = {};

/** Applies the limits published in the startup config; invalid values keep the defaults. */
export function setClientLimits(limits?: TClientLimits | null): void {
  const parsed = clientLimitsSchema.safeParse(limits ?? {});
  resolved = parsed.success ? parsed.data : {};
}

export function getClientLimit(key: keyof TClientLimits): number {
  return resolved[key] ?? DEFAULT_CLIENT_LIMITS[key];
}
