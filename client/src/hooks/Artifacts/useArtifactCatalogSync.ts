import { useMemo } from 'react';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { useRestoreArtifactAppMutation } from '~/data-provider/ArtifactApps/mutations';
import { getArtifactSourceKey, toArtifactSyncRequest } from '~/utils/artifactCatalog';
import { useGetArtifactAppBySourceQuery } from '~/data-provider';
import useHasAccess from '~/hooks/Roles/useHasAccess';
import { useArtifactsContext } from '~/Providers';

export default function useArtifactCatalogSync(artifact: Artifact | null | undefined) {
  const { conversationId, isSubmitting } = useArtifactsContext();
  const canUse = useHasAccess({
    permissionType: PermissionTypes.ARTIFACTS,
    permission: Permissions.USE,
  });
  const sourceKey = useMemo(() => getArtifactSourceKey(artifact), [artifact]);
  const syncRequest = useMemo(
    () => (artifact && conversationId ? toArtifactSyncRequest(artifact, conversationId) : null),
    [artifact, conversationId],
  );
  const entryQuery = useGetArtifactAppBySourceQuery(conversationId, sourceKey, {
    enabled: canUse && !!syncRequest && !isSubmitting,
  });
  const restoreMutation = useRestoreArtifactAppMutation();
  const status = (entryQuery.error as { response?: { status?: number } } | null)?.response?.status;
  const isDeleted = status === 410;

  return {
    artifactEntry: isDeleted ? undefined : entryQuery.data?.app,
    isDeleted,
    restoreArtifact: syncRequest ? () => restoreMutation.mutateAsync(syncRequest) : undefined,
    isSyncing: !!syncRequest && (entryQuery.isLoading || restoreMutation.isLoading),
    sourceKey,
  };
}
