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

const STORAGE_KEY = 'librechat:clientLimits';

const parseLimits = (raw: unknown): TClientLimits => {
  const parsed = clientLimitsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
};

/** The first token refresh starts before the startup config arrives, so the last published
 * values are kept from the previous visit; a first visit uses the defaults. */
const readStored = (): TClientLimits => {
  if (typeof window === 'undefined') return {};
  try {
    return parseLimits(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return {};
  }
};

let resolved: TClientLimits = readStored();

/** Applies the limits published in the startup config; invalid values keep the defaults. */
export function setClientLimits(limits?: TClientLimits | null): void {
  resolved = parseLimits(limits);
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
  } catch {
    /* storage unavailable: the values apply for this page load only */
  }
}

export function getClientLimit(key: keyof TClientLimits): number {
  return resolved[key] ?? DEFAULT_CLIENT_LIMITS[key];
}
