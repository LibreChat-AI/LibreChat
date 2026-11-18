import { cn, Button, useLocalize } from '@librechat/client';
import type { ReactNode } from 'react';
import type { FollowedChat } from '../../react/follow';
import { useChatSurface } from '../../react/subagents/surface';
import { getMessageRowWidthClass } from '../messages/width';

/**
 * The start of what a followed conversation has read so far, when older rows exist: a control
 * that reads the page before it. A long conversation is read a page at a time, so this is how
 * the rest of it is reached; nothing is drawn once the first row is in.
 */
export default function EarlierMessages({
  followed,
}: {
  followed: Pick<
    FollowedChat,
    'hasEarlier' | 'isLoadingEarlier' | 'isEarlierError' | 'loadEarlier'
  >;
}): ReactNode {
  const localize = useLocalize();
  const { maximizeChatSpace } = useChatSurface();
  const { hasEarlier, isLoadingEarlier, isEarlierError, loadEarlier } = followed;
  if (!hasEarlier) {
    return null;
  }
  return (
    <div
      data-earlier-messages
      className={cn(
        'mx-auto flex min-w-0 flex-col items-center gap-2 px-4 pt-1 pb-2 text-sm',
        getMessageRowWidthClass({ fullWidth: maximizeChatSpace }),
      )}
    >
      {isEarlierError && (
        <p role="alert" className="text-text-secondary">
          {localize('com_ui_earlier_messages_error')}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={isLoadingEarlier}
        aria-busy={isLoadingEarlier || undefined}
        onClick={loadEarlier}
      >
        {isLoadingEarlier && localize('com_ui_loading')}
        {!isLoadingEarlier && isEarlierError && localize('com_ui_retry')}
        {!isLoadingEarlier && !isEarlierError && localize('com_ui_earlier_messages_show')}
      </Button>
    </div>
  );
}
