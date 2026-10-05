import { Button } from '@librechat/client';
import { useParams, useNavigate } from 'react-router-dom';
import type { TArtifactVersion } from 'librechat-data-provider';
import {
  useGetArtifactAppQuery,
  useGetArtifactAppVersionQuery,
  useListArtifactAppVersionsQuery,
} from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';
import ArtifactAppShareDialog from './Share';
import AppRenderer from './AppRenderer';

function errorStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

function StateMessage({
  message,
  onRetry,
  isRetrying = false,
}: {
  message: string;
  onRetry?: () => void;
  isRetrying?: boolean;
}) {
  const localize = useLocalize();

  return (
    <div
      role="alert"
      className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center text-text-secondary"
    >
      <p className="max-w-md text-lg">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" disabled={isRetrying} onClick={onRetry}>
          {isRetrying ? localize('com_ui_artifact_app_loading') : localize('com_ui_retry')}
        </Button>
      )}
    </div>
  );
}

export default function StandaloneAppView() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { artifactAppId, versionId } = useParams<{
    artifactAppId: string;
    versionId?: string;
  }>();

  const appQuery = useGetArtifactAppQuery(artifactAppId);
  const app = appQuery.data?.app;
  const includedVersion = appQuery.data?.version;
  const selectedVersionId = versionId ?? app?.activeVersionId;
  const includedVersionSelected = includedVersion?.artifactVersionId === selectedVersionId;
  const versionQuery = useGetArtifactAppVersionQuery(artifactAppId, selectedVersionId, {
    enabled: !!selectedVersionId && !includedVersionSelected,
  });
  const versionsQuery = useListArtifactAppVersionsQuery(artifactAppId);

  if (appQuery.isLoading) {
    return <StateMessage message={localize('com_ui_artifact_app_loading')} />;
  }

  if (appQuery.isError) {
    const status = errorStatus(appQuery.error);
    if (status === 403) {
      return <StateMessage message={localize('com_ui_artifact_app_forbidden')} />;
    }
    if (status === 404) {
      return <StateMessage message={localize('com_ui_artifact_app_not_found')} />;
    }
    return (
      <StateMessage
        message={localize('com_ui_artifact_app_load_error')}
        onRetry={() => void appQuery.refetch()}
        isRetrying={appQuery.isFetching}
      />
    );
  }

  if (selectedVersionId && !includedVersionSelected && versionQuery.isLoading) {
    return <StateMessage message={localize('com_ui_artifact_app_loading')} />;
  }

  if (selectedVersionId && !includedVersionSelected && versionQuery.isError) {
    const status = errorStatus(versionQuery.error);
    if (status === 403) {
      return <StateMessage message={localize('com_ui_artifact_app_forbidden')} />;
    }
    if (status === 404) {
      return <StateMessage message={localize('com_ui_artifact_app_not_found')} />;
    }
    return (
      <StateMessage
        message={localize('com_ui_artifact_app_version_load_error')}
        onRetry={() => void versionQuery.refetch()}
        isRetrying={versionQuery.isFetching}
      />
    );
  }

  if (!app) {
    return <StateMessage message={localize('com_ui_artifact_app_not_found')} />;
  }

  if (app.status === 'suspended') {
    return <StateMessage message={localize('com_ui_artifact_app_suspended')} />;
  }
  if (app.status === 'archived') {
    return <StateMessage message={localize('com_ui_artifact_app_archived')} />;
  }

  const version: TArtifactVersion | null | undefined = includedVersionSelected
    ? includedVersion
    : versionQuery.data;
  const versions = versionsQuery.data?.pages.flatMap((page) => page.versions) ?? [];
  const versionOptions =
    !version ||
    versions.some((candidate) => candidate.artifactVersionId === version.artifactVersionId)
      ? versions
      : [version, ...versions];

  return (
    <div className="flex h-screen w-full flex-col bg-surface-primary">
      <header className="flex items-center justify-between gap-4 border-b border-border-light px-6 py-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-text-primary">{app.title}</h1>
          {app.description != null && app.description.length > 0 && (
            <p className="truncate text-sm text-text-secondary">{app.description}</p>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <ArtifactAppShareDialog
            app={app}
            buttonClassName="border-0 bg-transparent hover:bg-surface-hover"
          />
          {versionOptions.length > 0 && (
            <nav
              aria-label={localize('com_ui_artifact_app_version')}
              className="flex items-center gap-2"
            >
              <select
                aria-label={localize('com_ui_artifact_app_version')}
                className="rounded border border-border-medium bg-surface-secondary px-2 py-1 text-sm text-text-primary"
                value={version?.artifactVersionId ?? ''}
                onChange={(e) => navigate(`/apps/${app.artifactAppId}/version/${e.target.value}`)}
              >
                {versionOptions.map((v) => (
                  <option key={v.artifactVersionId} value={v.artifactVersionId}>
                    {`v${v.versionNumber}`}
                  </option>
                ))}
              </select>
              {versionsQuery.hasNextPage && !versionsQuery.isError && (
                <button
                  type="button"
                  className="rounded border border-border-medium bg-surface-secondary px-2 py-1 text-sm text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={versionsQuery.isFetchingNextPage}
                  onClick={() => versionsQuery.fetchNextPage()}
                >
                  {versionsQuery.isFetchingNextPage
                    ? localize('com_ui_artifact_app_loading')
                    : localize('com_ui_load_more')}
                </button>
              )}
            </nav>
          )}
        </div>
      </header>
      {versionsQuery.isError && (
        <div
          role="alert"
          className="flex flex-shrink-0 items-center justify-center gap-3 border-b border-border-light bg-surface-secondary px-4 py-2 text-sm text-text-secondary"
        >
          <span>{localize('com_ui_artifact_app_history_load_error')}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={versionsQuery.isFetching}
            onClick={() => void versionsQuery.refetch()}
          >
            {versionsQuery.isFetching
              ? localize('com_ui_artifact_app_loading')
              : localize('com_ui_retry')}
          </Button>
        </div>
      )}
      <main className="min-h-0 flex-1">
        {version ? (
          <AppRenderer title={app.title} version={version} />
        ) : (
          <StateMessage message={localize('com_ui_artifact_app_no_version')} />
        )}
      </main>
    </div>
  );
}
