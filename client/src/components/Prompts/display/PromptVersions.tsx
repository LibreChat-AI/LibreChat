import React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { TooltipAnchor } from '@librechat/client';
import { Zap, Circle, CheckCircle2 } from 'lucide-react';
import type { TPrompt, TPromptGroup } from 'librechat-data-provider';
import { useLocalize, useClockFormat } from '~/hooks';
import { cn } from '~/utils';

const VersionBadge = ({
  type,
  tooltip,
  label,
}: {
  type: 'latest' | 'production';
  tooltip: string;
  label: string;
}) => {
  const isProduction = type === 'production';

  return (
    <TooltipAnchor
      description={tooltip}
      side="left"
      render={
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
            isProduction
              ? 'bg-status-success-subtle text-status-success'
              : 'bg-status-info-subtle text-status-info',
          )}
        >
          {isProduction ? (
            <>
              <span className="slow-pulse size-1.5 rounded-full bg-status-success" />
              <span>{label}</span>
            </>
          ) : (
            <>
              <Zap className="size-3" aria-hidden="true" />
              <span>{label}</span>
            </>
          )}
        </span>
      }
    />
  );
};

const getTimelineConnectorClasses = (isSelected: boolean, isProduction: boolean) => {
  if (isSelected) {
    return 'border-status-success-strong bg-status-success-strong text-text-on-status';
  }
  if (isProduction) {
    return 'border-status-success-border bg-transparent text-status-success';
  }
  return 'border-border-medium bg-transparent text-text-secondary';
};

const VersionCard = ({
  prompt,
  index,
  isSelected,
  totalVersions,
  onClick,
  isLatest,
  isProduction,
}: {
  prompt: TPrompt;
  index: number;
  isSelected: boolean;
  totalVersions: number;
  onClick: () => void;
  isLatest: boolean;
  isProduction: boolean;
}) => {
  const localize = useLocalize();
  const hour12 = useClockFormat();
  const versionNumber = totalVersions - index;

  return (
    <li className="relative flex items-stretch" aria-current={isSelected ? 'true' : undefined}>
      {/* Timeline connector */}
      <div className="relative flex w-6 shrink-0 justify-center">
        {/* Vertical line - extends through mb-2 gap + mt-3 to reach next circle */}
        {index < totalVersions - 1 && (
          <div className="absolute -bottom-5 top-0 w-0.5 bg-border-light" />
        )}
        {/* Circle marker - mt-3 aligns with card title (card has p-3) */}
        <div
          className={cn(
            'relative z-10 mt-3 flex size-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors',
            getTimelineConnectorClasses(isSelected, isProduction),
          )}
        >
          {isSelected ? (
            <CheckCircle2 className="size-3" aria-hidden="true" />
          ) : (
            <Circle className="size-2" fill="currentColor" aria-hidden="true" />
          )}
        </div>
      </div>

      {/* Card content */}
      <button
        type="button"
        className={cn(
          'group mb-2 ml-2 flex flex-1 flex-col rounded-lg border p-3 text-left',
          isSelected
            ? 'border-status-success-border bg-status-success-subtle'
            : 'border-border-medium bg-transparent hover:border-border-heavy hover:bg-surface-hover',
        )}
        onClick={onClick}
        aria-label={localize('com_ui_version_var', { 0: `${versionNumber}` })}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'text-sm font-semibold',
              isSelected ? 'text-status-success' : 'text-text-primary',
            )}
          >
            {localize('com_ui_version_var', { 0: versionNumber })}
          </span>
          <div className="flex items-center gap-1">
            {isProduction && (
              <VersionBadge
                type="production"
                tooltip={localize('com_ui_currently_production')}
                label={localize('com_ui_live')}
              />
            )}
            {isLatest && !isProduction && (
              <VersionBadge
                type="latest"
                tooltip={localize('com_ui_latest_version')}
                label={localize('com_ui_latest')}
              />
            )}
          </div>
        </div>

        <time
          className="mt-1 text-xs text-text-secondary"
          dateTime={prompt.createdAt}
          title={new Date(prompt.createdAt).toLocaleString(undefined, { hour12 })}
        >
          {formatDistanceToNow(new Date(prompt.createdAt), { addSuffix: true })}
        </time>
      </button>
    </li>
  );
};

const PromptVersions = ({
  prompts,
  group,
  selectionIndex,
  setSelectionIndex,
}: {
  prompts: TPrompt[];
  group?: TPromptGroup;
  selectionIndex: number;
  setSelectionIndex: React.Dispatch<React.SetStateAction<number>>;
}) => {
  const localize = useLocalize();
  return (
    <ul className="flex flex-col" aria-label={localize('com_ui_versions')}>
      {prompts.map((prompt: TPrompt, index: number) => {
        const isLatest = index === 0;
        const isProduction = prompt._id === group?.productionId;

        return (
          <VersionCard
            key={prompt._id}
            prompt={prompt}
            index={index}
            isSelected={index === selectionIndex}
            totalVersions={prompts.length}
            onClick={() => setSelectionIndex(index)}
            isLatest={isLatest}
            isProduction={isProduction}
          />
        );
      })}
    </ul>
  );
};

export default PromptVersions;
