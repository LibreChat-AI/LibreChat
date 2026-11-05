import { hasVerifiedReports } from 'librechat-data-provider';
import type { TNearAIVerificationReport } from 'librechat-data-provider';
import { reportCheckedAt } from './report';

type Entry = {
  identity: string;
  expiresAt: number;
  pending: Promise<TNearAIVerificationReport[]>;
};

/** Display evidence only: this cache never replaces Chat's SDK preflight. */
export function createReportCache() {
  const entries = new Map<string, Entry>();
  return (
    options: { identity: string; scope?: 'gateway'; ttl: number; max: number; refresh: boolean },
    load: () => Promise<TNearAIVerificationReport[]>,
  ): Promise<TNearAIVerificationReport[]> => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now || (options.refresh && entry.identity === options.identity)) {
        entries.delete(key);
      }
    }
    const key = JSON.stringify([options.identity, options.scope, options.ttl]);
    const cached = entries.get(key);
    if (cached) return cached.pending;

    const pending: Promise<TNearAIVerificationReport[]> = Promise.resolve()
      .then(load)
      .then((reports) => {
        // A superseded request must never restore old success after a fresh failure.
        const current = entries.get(key);
        if (current?.pending === pending) {
          current.expiresAt = Date.parse(reportCheckedAt(reports)) + options.ttl;
          if (!hasVerifiedReports(reports) || current.expiresAt <= Date.now()) entries.delete(key);
        }
        return reports;
      })
      .catch((error: unknown) => {
        if (entries.get(key)?.pending === pending) entries.delete(key);
        throw error;
      });
    const entry: Entry = { identity: options.identity, expiresAt: Infinity, pending };
    entries.set(key, entry);
    while (entries.size > options.max) {
      const oldest = entries.keys().next().value;
      if (oldest == null) break;
      entries.delete(oldest);
    }
    return pending;
  };
}
