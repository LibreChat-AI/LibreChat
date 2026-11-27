/** A missing deadline is durable; an invalid or elapsed deadline is never active. */
export function isAgentEventRetentionActive(expiredAt: unknown, now: number = Date.now()): boolean {
  if (expiredAt == null) {
    return true;
  }
  const deadline =
    expiredAt instanceof Date ? expiredAt.getTime() : new Date(String(expiredAt)).getTime();
  return Number.isFinite(deadline) && deadline > now;
}
