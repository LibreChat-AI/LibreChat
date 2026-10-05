import { memo, useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import { TooltipAnchor } from '@librechat/client';
import type { TConversationPullRequest } from 'librechat-data-provider';
import { useConversationPullRequestQuery } from '~/data-provider';
import { useAgentsMapContext, useChatContext } from '~/Providers';
import { TONE_DOT_CLASS, presentPullRequest } from './status';
import { URLIcon } from '~/components/Endpoints/URLIcon';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';
import PullRequestCard from './Card';
import { cn } from '~/utils';

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

function summaryLabel(
  pr: TConversationPullRequest,
  localize: ReturnType<typeof useLocalize>,
): string {
  const view = presentPullRequest(pr);
  return [
    `${localize('com_ui_pull_request')} ${localize('com_ui_pr_label', { 0: pr.number })}: ${pr.title}`,
    localize('com_ui_pr_state', { 0: localize(view.stateKey) }),
    localize('com_ui_pr_checks', { 0: localize(view.checksKey) }),
  ].join(', ');
}

/**
 * Header control for the pull request a code conversation opened. It renders nothing until a
 * pull request is known: a conversation without one, a disabled feature and a failed first
 * lookup all leave the header exactly as it was, so the row never shifts.
 */
function PullRequestChip({ conversationId }: { conversationId: string }) {
  const localize = useLocalize();
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const popover = Ariakit.usePopoverStore({ placement: 'bottom-end' });
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const { data, isError, refetch } = useConversationPullRequestQuery(conversationId);
  const pullRequest = data?.pullRequest;

  if (pullRequest == null) return null;

  const view = presentPullRequest(pullRequest);
  const label = summaryLabel(pullRequest, localize);
  const dotClass = view.dotTone == null ? null : TONE_DOT_CLASS[view.dotTone];
  const agentId = conversation?.agent_id;
  const agent = agentId == null ? undefined : agentsMap?.[agentId];
  const avatar = agent?.avatar?.filepath ?? '';
  const hasAvatar = avatar !== '';

  return (
    <>
      <TooltipAnchor
        description={label}
        render={
          <Ariakit.PopoverDisclosure
            ref={disclosureRef}
            store={popover}
            aria-label={label}
            data-testid="header-pull-request-button"
            className="border-border-light bg-presentation text-text-primary hover:bg-surface-tertiary aria-expanded:bg-surface-tertiary inline-flex h-9 max-w-[14rem] min-w-0 flex-shrink items-center gap-1.5 rounded-xl border px-2 text-sm transition-all ease-in-out max-md:max-w-none max-md:px-2.5"
          >
            {hasAvatar && <AgentAvatar avatar={avatar} name={agent?.name} dotClass={dotClass} />}
            <span className="relative flex shrink-0 items-center">
              <PullRequestIcon icon={view.icon} tone={view.iconTone} className="size-4 shrink-0" />
              {!hasAvatar && dotClass != null && <CiDot dotClass={dotClass} />}
            </span>
            <span className="truncate max-md:hidden">{pullRequest.title}</span>
          </Ariakit.PopoverDisclosure>
        }
      />
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        finalFocus={disclosureRef}
        aria-label={localize('com_ui_pull_request')}
        className="border-border-medium bg-surface-secondary text-text-primary z-[200] w-80 max-w-[calc(100vw-2rem)] rounded-xl border shadow-lg focus:outline-none"
      >
        <PullRequestCard
          pullRequest={pullRequest}
          refreshFailed={isError}
          onRetry={() => void refetch()}
        />
      </Ariakit.Popover>
    </>
  );
}

export default memo(PullRequestChip);
