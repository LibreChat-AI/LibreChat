import { clientLimitsSchema } from 'librechat-data-provider';
import type { TClientLimits } from 'librechat-data-provider';

/** Publishes the operator's client request deadlines; invalid input is dropped so defaults apply. */
export function getClientLimits(raw?: unknown): TClientLimits | undefined {
  if (raw == null) return undefined;
  const parsed = clientLimitsSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}
