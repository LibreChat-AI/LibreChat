import { memo, useEffect } from 'react';
import * as Ariakit from '@ariakit/react';
import { Button } from '@librechat/client';
import { TriangleAlert } from 'lucide-react';
import type React from 'react';
import { useRowPullRequestQuery } from '~/data-provider/PullRequest';
import { TONE_DOT_CLASS, presentPullRequest } from './status';
import PullRequestPanel, { panelClass } from './Panel';
import { summarizePullRequest } from './summary';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';
import { cn } from '~/utils';
import CiDot from './CiDot';

/** The row's own surface at each state, so the dot's ring blends into it. */
const RING_SELECTED = 'ring-surface-nav-selected';
const RING_IDLE = 'ring-surface-sidebar group-hover:ring-surface-nav-hover';

/**
 * The pull request a conversation opened, as a mark in its sidebar row: the state icon with the
 * CI dot on its corner. It renders nothing until a pull request is known, so a row without one
 * is exactly what it was. The row's title stays the conversation's own title; this only adds
 * the icon. The mark is a button beside the row's own, so Tab reaches it: focusing it opens the
 * card, which holds the GitHub link, and activating it must not also open the row.
 */
function PullRequestRowMark({
  conversationId,
  labelId,
  selected,
  onDescribed,
}: {
  conversationId: string;
  /** The id the row lists in `aria-describedby`, so a screen reader hears what the colors say. */
  labelId: string;
  selected: boolean;
  /** Tells the row whether `labelId` is in the page, so it never points at text that is not. */
  onDescribed?: (described: boolean) => void;
}) {
  const localize = useLocalize();
  const store = Ariakit.useHovercardStore({
    placement: 'right-start',
    showTimeout: 100,
    hideTimeout: 150,
  });
  const open = Ariakit.useStoreState(store, 'open');
  const { data, isError, refetch } = useRowPullRequestQuery(conversationId);
  const pullRequest = data?.pullRequest;
  const described = pullRequest != null || isError;

  useEffect(() => {
    onDescribed?.(described);
    return () => onDescribed?.(false);
  }, [described, onDescribed]);

  /* A first lookup that failed is not the same as a chat with no pull request: say so, and
     offer a retry, instead of leaving the row looking like there is nothing to find. */
  if (pullRequest == null && isError) {
    const failed = localize('com_ui_pr_load_failed');
    return (
      <Ariakit.HovercardProvider store={store}>
        <Ariakit.HovercardAnchor
          render={<Ariakit.Button />}
          aria-label={failed}
          aria-expanded={open}
          data-testid="convo-pull-request-failed"
          onFocus={() => store.show()}
          onClick={(event: React.MouseEvent) => {
            event.stopPropagation();
            store.show();
          }}
          onKeyDown={(event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
          }}
          className="focus-visible:ring-text-primary text-status-warning relative mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm outline-hidden focus-visible:ring-2"
        >
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
        </Ariakit.HovercardAnchor>
        <span id={labelId} className="sr-only">
          {failed}
        </span>
        <Ariakit.Hovercard
          store={store}
          gutter={8}
          portal
          unmountOnHide
          autoFocusOnShow={false}
          aria-label={localize('com_ui_pull_request')}
          className={cn(panelClass, 'w-auto')}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div role="status" className="text-status-warning flex items-center gap-2 p-3 text-xs">
            <span>{failed}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
              {localize('com_ui_retry')}
            </Button>
          </div>
        </Ariakit.Hovercard>
      </Ariakit.HovercardProvider>
    );
  }

  if (pullRequest == null) return null;

  const view = presentPullRequest(pullRequest);
  const dotClass = view.dotTone == null ? null : TONE_DOT_CLASS[view.dotTone];
  const summary = summarizePullRequest(pullRequest, localize);

  return (
    <Ariakit.HovercardProvider store={store}>
      <Ariakit.HovercardAnchor
        render={<Ariakit.Button />}
        aria-label={summary}
        aria-expanded={open}
        data-testid="convo-pull-request"
        onFocus={() => store.show()}
        onClick={(event: React.MouseEvent) => {
          /* The row itself opens the conversation on click; this opens the card instead. */
          event.stopPropagation();
          store.show();
        }}
        onKeyDown={(event: React.KeyboardEvent) => {
          /* Enter and Space belong to this button, not to the row's own shortcuts. */
          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
        }}
        className={cn(
          'focus-visible:ring-text-primary relative mr-1 flex size-4 shrink-0 items-center justify-center rounded-sm outline-hidden focus-visible:ring-2',
        )}
      >
        <PullRequestIcon icon={view.icon} tone={view.iconTone} className="size-4 shrink-0" />
        {dotClass != null && (
          <CiDot dotClass={dotClass} ringClassName={selected ? RING_SELECTED : RING_IDLE} />
        )}
      </Ariakit.HovercardAnchor>
      <span id={labelId} className="sr-only">
        {summary}
      </span>
      <PullRequestPanel
        store={store}
        pullRequest={pullRequest}
        refreshFailed={isError}
        onRetry={() => void refetch()}
      />
    </Ariakit.HovercardProvider>
  );
}

export default memo(PullRequestRowMark);
