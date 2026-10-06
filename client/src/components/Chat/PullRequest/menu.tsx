import { useRef, useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import type { ReactNode } from 'react';
import type * as t from '~/common';
import { useConversationPullRequestQuery } from '~/data-provider';
import { summarizePullRequest } from './summary';
import { presentPullRequest } from './status';
import { useLocalize } from '~/hooks';
import PullRequestIcon from './Icon';
import PullRequestCard from './Card';

export type PullRequestMenu = {
  /** Absent until a pull request is known, so the menu is unchanged for every other chat. */
  item?: t.MenuItemProps;
  /** Rendered by the surface that owns the menu, next to its trigger. */
  dialog: ReactNode;
};

/**
 * The pull request as an overflow-menu entry for the small-screen header, where there is no
 * room for the chip. The entry opens the same card in a dialog, so both surfaces read from one
 * query and one presentation. An empty `conversationId` leaves the query disabled.
 */
export default function usePullRequestMenu(conversationId: string): PullRequestMenu {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { data, isError, refetch } = useConversationPullRequestQuery(conversationId);
  const pullRequest = data?.pullRequest;

  if (pullRequest == null) return { dialog: null };

  const view = presentPullRequest(pullRequest);
  return {
    item: {
      id: 'header-pull-request',
      label: localize('com_ui_pr_label', { 0: pullRequest.number }),
      ariaLabel: summarizePullRequest(pullRequest, localize),
      icon: <PullRequestIcon icon={view.icon} tone={view.iconTone} />,
      onClick: () => setOpen(true),
      /** NOTE: THE FOLLOWING PROPS ARE REQUIRED FOR MENU ITEMS THAT OPEN DIALOGS */
      hideOnClick: false,
      ref: triggerRef,
      render: (props) => <button {...props} data-testid="pull-request-menu-item" />,
    },
    dialog: (
      <OGDialog open={open} onOpenChange={setOpen} triggerRef={triggerRef}>
        <OGDialogContent className="w-11/12 max-w-md">
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_ui_pull_request')}</OGDialogTitle>
          </OGDialogHeader>
          <PullRequestCard
            pullRequest={pullRequest}
            refreshFailed={isError}
            onRetry={() => void refetch()}
          />
        </OGDialogContent>
      </OGDialog>
    ),
  };
}
