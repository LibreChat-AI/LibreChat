import type {
  PromptCatalogSyncDeps,
  PromptCatalogSyncResult,
  PromptCatalogSyncSource,
} from './promptCatalogSync';
import type { DistributedLock } from '~/cache/lock';
import { syncLangfusePromptCatalog } from './promptCatalogSync';

/** Process-lifetime dependencies: the shared lock, the prompt service and the logger. */
export interface LangfusePromptSyncRunnerDeps {
  lock: DistributedLock;
  promptService: PromptCatalogSyncDeps['promptService'];
  logger: PromptCatalogSyncDeps['logger'];
}

/** Per-request inputs: the source identity, a connection-bound page lister
 *  and the config-resolved lock lease and page cap. */
export interface LangfusePromptSyncRequest {
  source: PromptCatalogSyncSource;
  listPrompts: PromptCatalogSyncDeps['listPrompts'];
  lockLeaseMs: number;
  maxPages: number;
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

  return async function syncPromptCatalog({ source, listPrompts, lockLeaseMs, maxPages }) {
    const syncDeps: PromptCatalogSyncDeps = {
      listPrompts,
      promptService,
      lock,
      lockLeaseMs,
      maxPages,
      logger,
    };

    return syncLangfusePromptCatalog(source, syncDeps);
  };
}
