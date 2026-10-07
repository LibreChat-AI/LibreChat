import { memo } from 'react';
import * as Ariakit from '@ariakit/react';
import { useConversationPullRequestQuery } from '~/data-provider';
import { TONE_DOT_CLASS, presentPullRequest } from './status';
import PullRequestPanel, { panelBelowClass } from './Panel';
import { summarizePullRequest } from './summary';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';
import CiDot from './CiDot';

/**
 * Desktop header control for the pull request a code conversation opened. It renders nothing
 * until a pull request is known: a conversation without one, a disabled feature and a failed
 * first lookup all leave the header exactly as it was, so the row never shifts. The details
 * open below the chip on hover or keyboard focus and slide down. The card
 * holds a link, so it is an Ariakit hovercard: it stays open while the pointer or focus is
 * inside it, and Tab moves from the chip into it.
 */
function PullRequestChip({ conversationId }: { conversationId: string }) {
  const localize = useLocalize();
  const hovercard = Ariakit.useHovercardStore({
    placement: 'bottom-start',
    showTimeout: 100,
    hideTimeout: 150,
  });
  const open = Ariakit.useStoreState(hovercard, 'open');
  const { data, isError, refetch } = useConversationPullRequestQuery(conversationId);
  const pullRequest = data?.pullRequest;

  if (pullRequest == null) return null;

  const view = presentPullRequest(pullRequest);
  const label = summarizePullRequest(pullRequest, localize);
  const dotClass = view.dotTone == null ? null : TONE_DOT_CLASS[view.dotTone];

  return (
    <Ariakit.HovercardProvider store={hovercard}>
      <Ariakit.HovercardAnchor
        render={
          <Ariakit.Button
            aria-label={label}
            aria-expanded={open}
            data-testid="header-pull-request-button"
            onFocus={() => hovercard.show()}
            className="border-border-light bg-presentation text-text-primary hover:bg-surface-tertiary aria-expanded:bg-surface-tertiary inline-flex h-9 max-w-[14rem] min-w-0 flex-shrink items-center gap-1.5 rounded-xl border px-2 text-sm transition-all ease-in-out"
          >
            <span className="relative flex shrink-0 items-center">
              <PullRequestIcon icon={view.icon} tone={view.iconTone} className="size-4 shrink-0" />
              {dotClass != null && <CiDot dotClass={dotClass} />}
            </span>
            <span className="truncate">{pullRequest.title}</span>
          </Ariakit.Button>
        }
      />
      <PullRequestPanel
        store={hovercard}
        className={panelBelowClass}
        pullRequest={pullRequest}
        refreshFailed={isError}
        onRetry={() => void refetch()}
      />
    </Ariakit.HovercardProvider>
  );
}

export default memo(PullRequestChip);
