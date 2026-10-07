import { memo } from 'react';
import { Button, Chip, GithubIcon, TooltipAnchor } from '@librechat/client';
import type { TConversationPullRequest } from 'librechat-data-provider';
import { presentPullRequest } from './status';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';

type CardProps = {
  pullRequest: TConversationPullRequest;
  /** A refresh failed; the last known pull request stays visible with a way to retry. */
  refreshFailed?: boolean;
  onRetry?: () => void;
  /** The layer the card lives in, so its tooltip is not painted behind it. */
  portalElement?: HTMLElement | null;
};

function PullRequestCard({
  pullRequest,
  refreshFailed = false,
  onRetry,
  portalElement,
}: CardProps) {
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
          portalElement={portalElement}
          render={
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={openLabel}
              data-testid="pull-request-github-link"
              className="text-text-secondary hover:text-text-primary focus-visible:ring-text-primary flex size-7 shrink-0 items-center justify-center rounded-md outline-hidden focus-visible:ring-2 [&_svg]:size-4"
            >
              <GithubIcon />
            </a>
          }
        />
      </div>
      <p className="text-text-primary line-clamp-3 text-sm break-words">{pullRequest.title}</p>
      <div className="flex flex-wrap gap-2">
        <Chip tone={view.stateTone} shape="theme" data-testid="pull-request-state-badge">
          {localize('com_ui_pr_state', { 0: localize(view.stateKey) })}
        </Chip>
        <Chip tone={view.checksTone} shape="theme" data-testid="pull-request-checks-badge">
          {localize('com_ui_pr_checks', { 0: localize(view.checksKey) })}
        </Chip>
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
