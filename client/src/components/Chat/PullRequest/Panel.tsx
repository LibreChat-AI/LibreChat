import * as Ariakit from '@ariakit/react';
import type { TConversationPullRequest } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import PullRequestCard from './Card';
import { cn } from '~/utils';

/** Slides in from the anchor's side, left to right, and fades; reduced motion only fades. */
export const panelClass = cn(
  'border-border-light bg-surface-secondary text-text-primary z-[200] w-80 max-w-[calc(100vw-2rem)] rounded-xl border shadow-lg focus:outline-none',
  'origin-left -translate-x-3 opacity-0 transition duration-200 ease-out',
  'data-[enter]:translate-x-0 data-[enter]:opacity-100',
  'data-[leave]:-translate-x-3 data-[leave]:opacity-0',
  'motion-reduce:translate-x-0 motion-reduce:transition-opacity',
);

/**
 * The card as a hovercard beside its anchor. It is portaled, and a portal's events still bubble
 * to the React tree that rendered it, so anything that sits inside a clickable row stops them
 * here: a click on the card must not open the row it hangs from.
 */
export default function PullRequestPanel({
  store,
  pullRequest,
  refreshFailed,
  onRetry,
}: {
  store: Ariakit.HovercardStore;
  pullRequest: TConversationPullRequest;
  refreshFailed: boolean;
  onRetry: () => void;
}) {
  const localize = useLocalize();
  const panelElement = Ariakit.useStoreState(store, 'contentElement');
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();

  return (
    <Ariakit.Hovercard
      store={store}
      gutter={8}
      portal
      unmountOnHide
      autoFocusOnShow={false}
      aria-label={localize('com_ui_pull_request')}
      className={panelClass}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onKeyDown={stop}
    >
      <PullRequestCard
        pullRequest={pullRequest}
        refreshFailed={refreshFailed}
        onRetry={onRetry}
        portalElement={panelElement}
      />
    </Ariakit.Hovercard>
  );
}
