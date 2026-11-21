import type { StoredBaseConfig } from './promptSync';
import type { ServerRequest } from '~/types';
import { trackRequestProductFact } from '~/tracking/request';
import { readStoredLangfuse } from './promptSync';

type TrackedBaseConfig = StoredBaseConfig & { isActive?: boolean };

/** The Langfuse state that requests use. A missing or inactive Base document has none. */
function getEffectiveLangfuseState(
  config: TrackedBaseConfig | null,
  promptSyncAvailable: boolean,
): { configured: boolean; enabled: boolean; promptSyncEnabled: boolean } {
  const stored = config?.isActive === false ? undefined : readStoredLangfuse(config);
  const configured = Boolean(stored?.publicKey && stored?.secretKey);
  return {
    configured,
    enabled: configured && stored?.enabled === true,
    promptSyncEnabled: promptSyncAvailable && stored?.promptSync?.enabled === true,
  };
}

/**
 * Records the Langfuse facts for a confirmed Base write. Each fact is recorded only when
 * the effective state before the write differs from the state after it.
 */
export function trackLangfuseTransition(
  req: Pick<ServerRequest, 'productTracker' | 'productTracking' | 'productTrackingContext'>,
  previous: TrackedBaseConfig | null,
  current: TrackedBaseConfig | null,
  promptSyncAvailable: boolean,
): void {
  const before = getEffectiveLangfuseState(previous, promptSyncAvailable);
  const after = getEffectiveLangfuseState(current, promptSyncAvailable);
  if (before.configured !== after.configured || before.enabled !== after.enabled) {
    trackRequestProductFact(req, {
      name: 'librechat.langfuse.connection.updated',
      configured: after.configured,
      enabled: after.enabled,
    });
  }
  if (before.promptSyncEnabled !== after.promptSyncEnabled) {
    trackRequestProductFact(req, {
      name: 'librechat.langfuse.promptSync.updated',
      enabled: after.promptSyncEnabled,
    });
  }
}
