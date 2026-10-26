import { clientTimeoutsSchema } from 'librechat-data-provider';
import type { TClientTimeouts } from 'librechat-data-provider';

/** Publishes the operator's client request deadlines; invalid input is dropped so defaults apply. */
export function getClientTimeouts(raw?: unknown): TClientTimeouts | undefined {
  if (raw == null) return undefined;
  const parsed = clientTimeoutsSchema.safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}
