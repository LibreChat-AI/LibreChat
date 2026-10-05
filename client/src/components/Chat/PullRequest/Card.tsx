import { memo } from 'react';
import { Button, GithubIcon, TooltipAnchor } from '@librechat/client';
import type { TConversationPullRequest } from 'librechat-data-provider';
import { TONE_BADGE_CLASS, presentPullRequest } from './status';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';
import { cn } from '~/utils';

const badgeClass = 'rounded-md border px-2 py-0.5 text-xs font-medium';

type CardProps = {
  pullRequest: TConversationPullRequest;
  /** A refresh failed; the last known pull request stays visible with a way to retry. */
  refreshFailed?: boolean;
  onRetry?: () => void;
};

function PullRequestCard({ pullRequest, refreshFailed = false, onRetry }: CardProps) {
  const localize = useLocalize();
  const view = presentPullRequest(pullRequest);
  const openLabel = localize('com_ui_pr_open_in_github');

  return (
    <div className="flex flex-col gap-3 p-3" data-testid="pull-request-card">
      <div className="flex items-center gap-2">
        <PullRequestIcon icon={view.icon} tone={view.iconTone} className="size-4 shrink-0" />
        <span className="text-text-primary text-sm font-medium">
          {localize('com_ui_pr_label', { 0: pullRequest.number })}
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-xs font-medium">
          <span
            className="text-status-success"
            aria-label={localize('com_ui_pr_additions', { 0: pullRequest.additions })}
          >
            +{pullRequest.additions}
          </span>
          <span
            className="text-status-error"
            aria-label={localize('com_ui_pr_deletions', { 0: pullRequest.deletions })}
          >
            -{pullRequest.deletions}
          </span>
        </span>
        <TooltipAnchor
          description={openLabel}
          render={
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openLabel}
              data-testid="pull-request-github-link"
              className="text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:ring-text-primary flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden focus-visible:ring-2"
            >
              <GithubIcon />
            </a>
          }
        />
      </div>
      <p className="text-text-primary line-clamp-3 text-sm break-words">{pullRequest.title}</p>
      <div className="flex flex-wrap gap-2">
        <span className={cn(badgeClass, TONE_BADGE_CLASS[view.stateTone])}>
          {localize('com_ui_pr_state', { 0: localize(view.stateKey) })}
        </span>
        <span className={cn(badgeClass, TONE_BADGE_CLASS[view.checksTone])}>
          {localize('com_ui_pr_checks', { 0: localize(view.checksKey) })}
        </span>
      </div>
      {refreshFailed && (
        <div role="status" className="text-status-warning flex items-center gap-2 text-xs">
          <span>{localize('com_ui_pr_refresh_failed')}</span>
          {onRetry != null && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {localize('com_ui_retry')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(PullRequestCard);
