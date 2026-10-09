import { Spinner } from '@librechat/client';
import { History, AlertCircle, UserX } from 'lucide-react';
import type { VersionContext } from './types';
import VersionItem from './VersionItem';
import { useLocalize } from '~/hooks';

type VersionContentProps = {
  selectedAgentId: string;
  isLoading: boolean;
  error: unknown;
  versionContext: VersionContext;
  onRestore: (index: number) => void;
};

function EmptyState({
  icon,
  title,
  tone = 'default',
}: {
  icon: React.ReactNode;
  title: string;
  tone?: 'default' | 'danger';
}) {
  const iconWrapBase = 'mb-3 flex h-12 w-12 items-center justify-center rounded-full border';
  const iconWrapTone =
    tone === 'danger'
      ? 'border-status-error-border bg-status-error-subtle text-text-destructive'
      : 'border-border-light bg-surface-secondary text-text-secondary';
  const textTone = tone === 'danger' ? 'text-text-destructive' : 'text-text-secondary';

  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <div className={`${iconWrapBase} ${iconWrapTone}`} aria-hidden="true">
        {icon}
      </div>
      <p className={`max-w-xs text-sm ${textTone}`}>{title}</p>
    </div>
  );
}

function VersionListSkeleton() {
  return (
    <ul aria-hidden="true" className="flex flex-col">
      {[0, 1, 2].map((i) => (
        <li key={i} className="relative flex items-stretch">
          <div className="relative flex w-6 shrink-0 justify-center">
            {i < 2 && <div className="absolute -bottom-3 top-0 w-px bg-border-light" />}
            <div className="relative z-10 mt-4 size-5 shrink-0 rounded-full border-2 border-border-light bg-surface-secondary" />
          </div>
          <div className="mb-2 ml-2 flex flex-1 flex-col gap-2 rounded-xl border border-border-light bg-transparent p-3">
            <div className="h-3 w-24 animate-pulse rounded bg-surface-secondary" />
            <div className="h-3 w-40 animate-pulse rounded bg-surface-secondary" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function VersionContent({
  selectedAgentId,
  isLoading,
  error,
  versionContext,
  onRestore,
}: VersionContentProps) {
  const { versions, versionIds } = versionContext;
  const localize = useLocalize();

  if (!selectedAgentId) {
    return (
      <EmptyState
        icon={<UserX className="h-5 w-5" />}
        title={localize('com_ui_agent_version_no_agent')}
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-center py-2" role="status" aria-live="polite">
          <Spinner className="h-5 w-5" />
          <span className="sr-only">{localize('com_ui_loading')}</span>
        </div>
        <VersionListSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon={<AlertCircle className="h-5 w-5" />}
        title={localize('com_ui_agent_version_error')}
        tone="danger"
      />
    );
  }

  if (versionIds.length > 0) {
    return (
      <ul aria-label={localize('com_ui_agent_version_history')} className="flex flex-col">
        {versionIds.map(({ id, version, isActive }) => (
          <VersionItem
            key={id}
            version={version}
            index={id}
            isActive={isActive}
            versionsLength={versions.length}
            onRestore={onRestore}
          />
        ))}
      </ul>
    );
  }

  return (
    <EmptyState
      icon={<History className="h-5 w-5" />}
      title={localize('com_ui_agent_version_empty')}
    />
  );
}
