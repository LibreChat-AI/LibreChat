import { useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ARTIFACT_APPS_CONFIG,
  Permissions,
  PermissionTypes,
  QueryKeys,
  dataService,
} from 'librechat-data-provider';
import type { TArtifactAppWithVersion } from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import {
  completeArtifactSync,
  getCurrentArtifactSyncEntry,
  listArtifactSyncQueue,
  recordArtifactSyncBaseline,
  rescheduleArtifactSync,
  subscribeToArtifactSyncQueue,
} from './queue';
import { useGetStartupConfig } from '~/data-provider';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { useAuthContext } from '~/hooks';
import { logger } from '~/utils';

interface SyncHttpError {
  response?: { status?: number };
}

function shouldDiscardSyncError(error: unknown): boolean {
  const status = (error as SyncHttpError | null)?.response?.status;
  return (
    status === 400 ||
    status === 403 ||
    status === 409 ||
    status === 410 ||
    status === 413 ||
    status === 422
  );
}

/**
 * Recovers a baseline that failed to resolve when the entry was enqueued. Only ever runs for an
 * entry that has no baseline yet — one that already has one is sent unchanged, never re-derived,
 * so a concurrent update can't make stale content look like it were based on a newer version.
 */
async function resolveBasedOnVersionNumber(
  queryClient: QueryClient,
  conversationId: string,
  sourceKey: string,
  legacySourceKey?: string,
): Promise<number> {
  try {
    const resolved = await queryClient.fetchQuery<TArtifactAppWithVersion>(
      [QueryKeys.artifactApp, 'source', conversationId, sourceKey],
      () => dataService.getArtifactAppBySource(conversationId, sourceKey),
      { retry: false },
    );
    return resolved.app.latestVersionNumber;
  } catch (error) {
    if ((error as SyncHttpError | null)?.response?.status !== 404) {
      throw error;
    }
  }
  if (!legacySourceKey) {
    return 0;
  }
  try {
    const resolved = await queryClient.fetchQuery<TArtifactAppWithVersion>(
      [QueryKeys.artifactApp, 'source', conversationId, legacySourceKey],
      () => dataService.getArtifactAppBySource(conversationId, legacySourceKey),
      { retry: false },
    );
    return resolved.app.latestVersionNumber;
  } catch (error) {
    if ((error as SyncHttpError | null)?.response?.status === 404) {
      return 0;
    }
    throw error;
  }
}

/** Flushes the persistent registration queue for the signed-in user across route changes. */
export default function ArtifactSyncWorker() {
  const { user } = useAuthContext();
  const ownerId = user?.id;
  const queryClient = useQueryClient();
  const { data: startupConfig } = useGetStartupConfig();
  const retryBaseDelayMs =
    startupConfig?.artifactApps?.clientSyncRetryBaseDelayMs ??
    DEFAULT_ARTIFACT_APPS_CONFIG.clientSyncRetryBaseDelayMs;
  const retryMaxDelayMs =
    startupConfig?.artifactApps?.clientSyncRetryMaxDelayMs ??
    DEFAULT_ARTIFACT_APPS_CONFIG.clientSyncRetryMaxDelayMs;
  const canCreate = useHasAccess({
    permissionType: PermissionTypes.ARTIFACTS,
    permission: Permissions.CREATE,
  });
  const flushingRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const activeOwnerRef = useRef(ownerId);
  const canCreateRef = useRef(canCreate);
  activeOwnerRef.current = ownerId;
  canCreateRef.current = canCreate;

  const flush = useCallback(async () => {
    if (!ownerId || !canCreate) {
      return null;
    }
    if (flushingRef.current) {
      return Math.min(retryBaseDelayMs, 100);
    }
    flushingRef.current = true;
    const generation = lifecycleGenerationRef.current;
    let catalogChanged = false;
    const sessionIsActive = () =>
      lifecycleGenerationRef.current === generation &&
      activeOwnerRef.current === ownerId &&
      canCreateRef.current === true;
    try {
      const entries = (await listArtifactSyncQueue(ownerId)).sort(
        (left, right) => left.nextAttemptAt - right.nextAttemptAt,
      );
      for (const entry of entries) {
        if (!sessionIsActive()) {
          return null;
        }
        if (entry.nextAttemptAt > Date.now()) {
          continue;
        }
        const current = getCurrentArtifactSyncEntry(entry.id);
        if (!current || current.signature !== entry.signature) {
          // Another tab already completed, replaced, or removed this snapshot since the
          // batch was read; the fresh entry (if any) will be picked up on its own schedule.
          continue;
        }
        try {
          // entry.request carries the baseline observed when this snapshot was captured
          // (ArtifactCatalogRegistrar.tsx) and is sent unchanged — re-deriving it here from the
          // server's current state would describe what's current now, not what this (possibly
          // older, still-queued) content was actually written against. A still-missing baseline
          // means that first observation failed; resolve and lock it in now, before ever sending,
          // rather than send an unchecked write.
          let requestToSend = entry.request;
          if (entry.request.basedOnVersionNumber == null) {
            const basedOnVersionNumber = await resolveBasedOnVersionNumber(
              queryClient,
              entry.request.source.conversationId,
              entry.request.source.sourceKey,
              entry.request.source.legacySourceKey,
            );
            if (!sessionIsActive()) {
              return null;
            }
            const baselineRecorded = await recordArtifactSyncBaseline(
              entry.id,
              entry.signature,
              basedOnVersionNumber,
            );
            if (!baselineRecorded) {
              continue;
            }
            const currentAfterBaseline = getCurrentArtifactSyncEntry(entry.id);
            if (!currentAfterBaseline || currentAfterBaseline.signature !== entry.signature) {
              continue;
            }
            requestToSend = { ...entry.request, basedOnVersionNumber };
          }
          const result = await dataService.syncArtifactApp(requestToSend);
          if (!sessionIsActive()) {
            return null;
          }
          queryClient.setQueryData(
            [
              QueryKeys.artifactApp,
              'source',
              entry.request.source.conversationId,
              entry.request.source.sourceKey,
            ],
            result,
          );
          await completeArtifactSync(entry.id, entry.signature);
          catalogChanged = true;
        } catch (error) {
          if (!sessionIsActive()) {
            return null;
          }
          if (!shouldDiscardSyncError(error)) {
            const delay = Math.min(
              retryBaseDelayMs * 2 ** Math.min(entry.failures, 5),
              retryMaxDelayMs,
            );
            await rescheduleArtifactSync(entry.id, entry.signature, delay);
          } else {
            await completeArtifactSync(entry.id, entry.signature);
          }
          logger.error('artifacts', 'Failed to sync artifact with catalog', error);
        }
      }
      if (catalogChanged && sessionIsActive()) {
        await queryClient.invalidateQueries({
          queryKey: [QueryKeys.artifactApps],
          refetchType: 'all',
        });
        if (!sessionIsActive()) {
          queryClient.removeQueries({ queryKey: [QueryKeys.artifactApps] });
          return null;
        }
      }
      if (!sessionIsActive()) {
        return null;
      }
      const remaining = await listArtifactSyncQueue(ownerId);
      return remaining.length > 0
        ? Math.max(0, Math.min(...remaining.map((entry) => entry.nextAttemptAt)) - Date.now())
        : null;
    } finally {
      flushingRef.current = false;
    }
  }, [canCreate, ownerId, queryClient, retryBaseDelayMs, retryMaxDelayMs]);

  useEffect(() => {
    const lifecycleGeneration = ++lifecycleGenerationRef.current;
    let disposed = false;
    let timer: number | null = null;
    const schedule = (delay: number) => {
      if (disposed) {
        return;
      }
      if (timer != null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => void run(), delay);
    };
    async function run() {
      timer = null;
      try {
        const nextDelay = await flush();
        if (!disposed && nextDelay != null) {
          schedule(nextDelay);
        }
      } catch (error) {
        logger.error('artifacts', 'Artifact synchronization worker failed', error);
        schedule(retryBaseDelayMs);
      }
    }
    const unsubscribe = subscribeToArtifactSyncQueue(() => schedule(0));
    void run();
    return () => {
      disposed = true;
      if (lifecycleGenerationRef.current === lifecycleGeneration) {
        lifecycleGenerationRef.current += 1;
      }
      unsubscribe();
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };
  }, [flush, retryBaseDelayMs]);

  return null;
}
