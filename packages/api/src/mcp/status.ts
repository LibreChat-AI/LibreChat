const failedResults = new WeakSet<object>();

/** Preserve the protocol status outside untrusted content and provider payloads. */
export function markMCPToolResultError<T extends object>(result: T, failed: boolean): T {
  if (failed) failedResults.add(result);
  return result;
}

export function isMCPToolResultError(result: object): boolean {
  return failedResults.has(result);
}
