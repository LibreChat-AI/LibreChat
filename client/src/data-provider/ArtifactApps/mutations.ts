import { QueryKeys, dataService } from 'librechat-data-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  TArtifactApp,
  TArtifactVersion,
  TArtifactAppWithVersion,
  TPublishArtifactAppRequest,
  TSyncArtifactAppRequest,
  TSyncArtifactAppResponse,
  TUpdateArtifactAppRequest,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

export const usePublishArtifactAppMutation = (): UseMutationResult<
  TArtifactAppWithVersion,
  Error,
  TPublishArtifactAppRequest
> => {
  const queryClient = useQueryClient();
  return useMutation((payload) => dataService.publishArtifactApp(payload), {
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.artifactApps]);
    },
  });
};

export const useSyncArtifactAppMutation = (): UseMutationResult<
  TSyncArtifactAppResponse,
  Error,
  TSyncArtifactAppRequest
> => {
  const queryClient = useQueryClient();
  return useMutation((payload) => dataService.syncArtifactApp(payload), {
    onSuccess: (data, payload) => {
      queryClient.setQueryData(
        [QueryKeys.artifactApp, 'source', payload.source.conversationId, payload.source.sourceKey],
        data,
      );
      queryClient.invalidateQueries([QueryKeys.artifactApps]);
    },
  });
};

export const useRestoreArtifactAppMutation = (): UseMutationResult<
  TSyncArtifactAppResponse,
  Error,
  TSyncArtifactAppRequest
> => {
  const queryClient = useQueryClient();
  return useMutation((payload) => dataService.restoreArtifactApp(payload), {
    onSuccess: (data, payload) => {
      queryClient.setQueryData(
        [QueryKeys.artifactApp, 'source', payload.source.conversationId, payload.source.sourceKey],
        data,
      );
      queryClient.invalidateQueries([QueryKeys.artifactApps]);
    },
  });
};

export const useUpdateArtifactAppMutation = (): UseMutationResult<
  TArtifactApp,
  Error,
  { artifactAppId: string; payload: TUpdateArtifactAppRequest }
> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ artifactAppId, payload }) => dataService.updateArtifactApp(artifactAppId, payload),
    {
      onSuccess: (_data, { artifactAppId }) => {
        queryClient.invalidateQueries([QueryKeys.artifactApps]);
        queryClient.invalidateQueries([QueryKeys.artifactApp, artifactAppId]);
      },
    },
  );
};

export const useDeleteArtifactAppMutation = (): UseMutationResult<
  { success: boolean },
  Error,
  string
> => {
  const queryClient = useQueryClient();
  return useMutation((artifactAppId) => dataService.deleteArtifactApp(artifactAppId), {
    onSuccess: () => {
      queryClient.removeQueries([QueryKeys.artifactApp]);
      queryClient.invalidateQueries([QueryKeys.artifactApps]);
    },
  });
};

export const useReleaseArtifactVersionMutation = (): UseMutationResult<
  TArtifactVersion,
  Error,
  { artifactAppId: string; versionId: string }
> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ artifactAppId, versionId }) =>
      dataService.releaseArtifactAppVersion(artifactAppId, versionId),
    {
      onSuccess: (_data, { artifactAppId }) => {
        queryClient.invalidateQueries([QueryKeys.artifactAppVersions, artifactAppId]);
      },
    },
  );
};

export const useActivateArtifactVersionMutation = (): UseMutationResult<
  TArtifactApp,
  Error,
  { artifactAppId: string; versionId: string }
> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ artifactAppId, versionId }) =>
      dataService.activateArtifactAppVersion(artifactAppId, versionId),
    {
      onSuccess: (_data, { artifactAppId }) => {
        queryClient.invalidateQueries([QueryKeys.artifactApp, artifactAppId]);
        queryClient.invalidateQueries([QueryKeys.artifactAppVersions, artifactAppId]);
      },
    },
  );
};

export const useWithdrawArtifactVersionMutation = (): UseMutationResult<
  TArtifactVersion,
  Error,
  { artifactAppId: string; versionId: string }
> => {
  const queryClient = useQueryClient();
  return useMutation(
    ({ artifactAppId, versionId }) =>
      dataService.withdrawArtifactAppVersion(artifactAppId, versionId),
    {
      onSuccess: (_data, { artifactAppId }) => {
        queryClient.invalidateQueries([QueryKeys.artifactApps]);
        queryClient.invalidateQueries([QueryKeys.artifactApp]);
        queryClient.invalidateQueries([QueryKeys.artifactAppVersions, artifactAppId]);
      },
    },
  );
};
