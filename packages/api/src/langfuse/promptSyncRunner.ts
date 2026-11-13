import type {
  PromptCatalogSyncDeps,
  PromptCatalogSyncResult,
  PromptCatalogSyncSource,
  PromptCatalogProductTracker,
} from './promptCatalogSync';
import type { DistributedLock } from '~/cache/lock';
import { syncLangfusePromptCatalog } from './promptCatalogSync';

/** Process-lifetime dependencies: the shared lock, the prompt service and the logger. */
export interface LangfusePromptSyncRunnerDeps {
  lock: DistributedLock;
  promptService: PromptCatalogSyncDeps['promptService'];
  logger: PromptCatalogSyncDeps['logger'];
  trackProductFact?: PromptCatalogProductTracker;
}

/** Per-request inputs: the source identity, a connection-bound page lister
 *  and the config-resolved lock lease and page cap. */
export interface LangfusePromptSyncRequest {
  source: PromptCatalogSyncSource;
  listPrompts: PromptCatalogSyncDeps['listPrompts'];
  lockLeaseMs: number;
  maxPages: number;
  trackProductFact?: PromptCatalogProductTracker;
}

export type LangfusePromptSyncRunner = (
  request: LangfusePromptSyncRequest,
) => Promise<PromptCatalogSyncResult>;

/** Binds the storage-agnostic `syncLangfusePromptCatalog` to the process-lifetime lock,
 *  prompt service and logger, so a request supplies only the source and the
 *  connection-bound page lister. */
export function createLangfusePromptSyncRunner(
  deps: LangfusePromptSyncRunnerDeps,
): LangfusePromptSyncRunner {
  const { lock, promptService, logger } = deps;

  return async function syncPromptCatalog({
    source,
    listPrompts,
    lockLeaseMs,
    maxPages,
    trackProductFact = deps.trackProductFact,
  }) {
    const syncDeps: PromptCatalogSyncDeps = {
      listPrompts,
      promptService,
      lock,
      lockLeaseMs,
      maxPages,
      logger,
      ...(trackProductFact ? { trackProductFact } : {}),
    };

    return syncLangfusePromptCatalog(source, syncDeps);
  };
}
