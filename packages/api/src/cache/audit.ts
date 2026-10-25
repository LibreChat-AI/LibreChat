interface AuditableStore {
  opts?: { namespace?: string; ttl?: number; store?: { size?: number; entries?: unknown } };
}

interface AuditLogger {
  info: (message: string) => void;
}

const toMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

/**
 * Logs per-namespace entry counts and TTL only. Cache values and keys can hold
 * tokens, challenges, message content, or user identifiers, so neither is ever output.
 * Statistics are part of the message because the console formatter drops log metadata.
 */
export function auditCacheStores(stores: AuditableStore[], logger: AuditLogger): void {
  logger.info('[Cache] Starting audit');
  for (const store of stores) {
    if (!store?.opts?.store?.entries) {
      continue;
    }
    const { namespace, ttl, store: entries } = store.opts;
    logger.info(`[Cache] ${namespace} entries: count=${entries.size}, ttl=${ttl}ms`);
  }
}

export function formatMemoryUsage(memory: NodeJS.MemoryUsage, totalCacheEntries: number): string {
  return (
    `[Cache] Memory usage: heapUsed=${toMB(memory.heapUsed)}, heapTotal=${toMB(memory.heapTotal)}, ` +
    `rss=${toMB(memory.rss)}, external=${toMB(memory.external)}, totalCacheEntries=${totalCacheEntries}`
  );
}
