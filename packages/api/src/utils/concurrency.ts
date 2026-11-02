import type { AppConfig } from '@librechat/data-schemas';

/** Bounds on parallel per-request lookups, used when `concurrency` omits a key. */
export const DEFAULT_LOOKUP_CONCURRENCY = {
  connectedAgentLoads: 4,
  mcpCatalogLookups: 4,
  skillNameLookups: 8,
  skillFileInspections: 4,
  resumeAgentLoads: 4,
} as const;

export type LookupConcurrency = keyof typeof DEFAULT_LOOKUP_CONCURRENCY;

/** The `librechat.yaml` `concurrency` value for `key`, else its default. */
export function getLookupConcurrency(
  appConfig: Pick<AppConfig, 'concurrency'> | null | undefined,
  key: LookupConcurrency,
): number {
  return appConfig?.concurrency?.[key] ?? DEFAULT_LOOKUP_CONCURRENCY[key];
}
