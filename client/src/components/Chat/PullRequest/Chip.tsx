import { memo } from 'react';
import * as Ariakit from '@ariakit/react';
import { useConversationPullRequestQuery } from '~/data-provider';
import { useAgentsMapContext, useChatContext } from '~/Providers';
import { TONE_DOT_CLASS, presentPullRequest } from './status';
import { URLIcon } from '~/components/Endpoints/URLIcon';
import { summarizePullRequest } from './summary';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';
import PullRequestCard from './Card';
import { cn } from '~/utils';

/** Slides in from the chip's side, left to right, and fades; reduced motion only fades. */
const cardClass = cn(
  'border-border-light bg-surface-secondary text-text-primary z-[200] w-80 max-w-[calc(100vw-2rem)] rounded-xl border shadow-lg focus:outline-none',
  'origin-left -translate-x-3 opacity-0 transition duration-200 ease-out',
  'data-[enter]:translate-x-0 data-[enter]:opacity-100',
  'data-[leave]:-translate-x-3 data-[leave]:opacity-0',
  'motion-reduce:translate-x-0 motion-reduce:transition-opacity',
);

function CiDot({ dotClass }: { dotClass: string }) {
  return (
    <span
      data-testid="pull-request-ci-dot"
      className={cn(
        'ring-presentation absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2',
        dotClass,
      )}
    />
  );
}

/** The agent's picture with the CI dot on its corner. */
function AgentAvatar({
  avatar,
  name,
  dotClass,
}: {
  avatar: string;
  name?: string | null;
  dotClass: string | null;
}) {
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
      <URLIcon
        iconURL={avatar}
        altName={name}
        className="size-6 overflow-hidden rounded-md"
        containerStyle={{ width: 24, height: 24 }}
      />
      {dotClass != null && <CiDot dotClass={dotClass} />}
    </span>
  );
}

/**
 * Desktop header control for the pull request a code conversation opened. It renders nothing
 * until a pull request is known: a conversation without one, a disabled feature and a failed
 * first lookup all leave the header exactly as it was, so the row never shifts. The details
 * open to the right of the chip on hover or keyboard focus and slide in from the left. The card
 * holds a link, so it is an Ariakit hovercard: it stays open while the pointer or focus is
 * inside it, and Tab moves from the chip into it.
 */
function PullRequestChip({ conversationId }: { conversationId: string }) {
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const hovercard = Ariakit.useHovercardStore({
    placement: 'right-start',
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
  const agentId = conversation?.agent_id;
  const agent = agentId == null ? undefined : agentsMap?.[agentId];
  const avatar = agent?.avatar?.filepath ?? '';
  const hasAvatar = avatar !== '';

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
            {hasAvatar && <AgentAvatar avatar={avatar} name={agent?.name} dotClass={dotClass} />}
            <span className="relative flex shrink-0 items-center">
              <PullRequestIcon icon={view.icon} tone={view.iconTone} className="size-4 shrink-0" />
              {!hasAvatar && dotClass != null && <CiDot dotClass={dotClass} />}
            </span>
            <span className="truncate">{pullRequest.title}</span>
          </Ariakit.Button>
        }
      />
      <Ariakit.Hovercard
        gutter={8}
        portal
        unmountOnHide
        autoFocusOnShow={false}
        aria-label={localize('com_ui_pull_request')}
        className={cardClass}
      >
        <PullRequestCard
          pullRequest={pullRequest}
          refreshFailed={isError}
          onRetry={() => void refetch()}
        />
      </Ariakit.Hovercard>
    </Ariakit.HovercardProvider>
  );
}

export default memo(PullRequestChip);
