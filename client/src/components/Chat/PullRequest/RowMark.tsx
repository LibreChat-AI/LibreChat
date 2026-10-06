import { memo } from 'react';
import * as Ariakit from '@ariakit/react';
import { useRowPullRequestQuery } from '~/data-provider/PullRequest';
import { TONE_DOT_CLASS, presentPullRequest } from './status';
import { summarizePullRequest } from './summary';
import PullRequestPanel from './Panel';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';
import { cn } from '~/utils';
import CiDot from './CiDot';

/** The row's own surface at each state, so the dot's ring blends into it. */
const RING_SELECTED = 'ring-surface-nav-selected';
const RING_IDLE = 'ring-surface-primary-alt group-hover:ring-surface-nav-hover';

/**
 * The pull request a conversation opened, as a mark in its sidebar row: the state icon with the
 * CI dot on its corner. It renders nothing until a pull request is known, so a row without one
 * is exactly what it was. The row's title stays the conversation's own title; this only adds
 * the icon. The mark is not focusable, because it sits inside the row's button: the row names
 * the pull request through `labelId`, and the header chip is the keyboard route to the card.
 */
function PullRequestRowMark({
  conversationId,
  labelId,
  selected,
}: {
  conversationId: string;
  /** The id the row lists in `aria-describedby`, so a screen reader hears what the colors say. */
  labelId: string;
  selected: boolean;
}) {
  const localize = useLocalize();
  const store = Ariakit.useHovercardStore({
    placement: 'right-start',
    showTimeout: 100,
    hideTimeout: 150,
  });
  const { data, isError, refetch } = useRowPullRequestQuery(conversationId);
  const pullRequest = data?.pullRequest;

  if (pullRequest == null) return null;

  const view = presentPullRequest(pullRequest);
  const dotClass = view.dotTone == null ? null : TONE_DOT_CLASS[view.dotTone];

  return (
    <Ariakit.HovercardProvider store={store}>
      <Ariakit.HovercardAnchor
        render={<span data-testid="convo-pull-request" />}
        className={cn('relative flex size-4 shrink-0 items-center justify-center')}
      >
        <PullRequestIcon icon={view.icon} tone={view.iconTone} className="size-4 shrink-0" />
        {dotClass != null && (
          <CiDot dotClass={dotClass} ringClassName={selected ? RING_SELECTED : RING_IDLE} />
        )}
      </Ariakit.HovercardAnchor>
      <span id={labelId} className="sr-only">
        {summarizePullRequest(pullRequest, localize)}
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
