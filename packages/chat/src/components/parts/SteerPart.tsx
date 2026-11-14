import { memo, useMemo, useState, useEffect } from 'react';
import { cn, useLocalize } from '@librechat/client';
import type { TMessage } from 'librechat-data-provider';
import type { NamedExoticComponent } from 'react';
import type { SteerReceiptState } from '../composer/steering/Receipt';
import MessageTimestamp from '../messages/MessageTimestamp';
import SteerReceipt from '../composer/steering/Receipt';
import { useMessagePartsHost } from '../../react/host';
import CollapsibleText from '../CollapsibleText';
import MessageFiles from '../messages/Files';
import MessageQuotes from './MessageQuotes';

export interface SteerPartProps {
  steer: string;
  hasMore?: boolean;
  onExpand?: () => void;
  files?: TMessage['files'];
  /** Quoted excerpts steered with the message; rendered as the same reference
   *  blocks a user bubble shows for `message.quotes`. */
  quotes?: string[];
  /** Anchors the part for the message-nav rail (`#steer-<id>` rib target). */
  steerId?: string;
  createdAt?: number;
  /** The owning response is still generating: the receipt keeps its amber
   *  steering identity while it is the live thing at the end, then settles
   *  to timestamp gray (always settled on reload, share, and search). */
  isSubmitting?: boolean;
  /** Pending renderer state must never claim server application early. */
  receiptState?: SteerReceiptState | null;
}

/**
 * A mid-run steering message rendered as a standard user message inside the
 * assistant response, with the same compact surface and text presentation as any
 * user turn, placed where the words enter the run so the visible order equals
 * what the next turn replays (`ContentTypes.STEER` splits back into a
 * HumanMessage server-side). Only the server-applied part renders here, at its
 * authoritative index; a steer still in flight lives in the composer's chip
 * stack. Renders identically live, on reload, and in shared/search views.
 */
const SteerPart: NamedExoticComponent<SteerPartProps> = memo(function SteerPart({
  steer,
  files,
  quotes,
  steerId,
  createdAt,
  isSubmitting = false,
  receiptState = 'applied',
  hasMore = false,
  onExpand,
}: SteerPartProps) {
  const localize = useLocalize();
  const { useUser, useShare, renderMarkdown, useUserTextPreferences, useLiveAppliedSteer } =
    useMessagePartsHost();
  const user = useUser();
  const { isSharedConvo } = useShare();
  const { usernameDisplay, enableUserMsgMarkdown, collapseLongUserMessages } =
    useUserTextPreferences();

  /** The share surface must never label the SHARER's steers with the
   *  viewer's identity; always the generic user label there. */
  const label = useMemo(() => {
    if (isSharedConvo === true || !usernameDisplay) {
      return localize('com_user_message');
    }
    return (user?.name ?? '') || user?.username || localize('com_user_message');
  }, [isSharedConvo, usernameDisplay, user?.name, user?.username, localize]);
  const timestamp = useMemo(
    () => (createdAt != null ? new Date(createdAt).toISOString() : null),
    [createdAt],
  );
  useEffect(() => {
    if (hasMore && !collapseLongUserMessages) onExpand?.();
  }, [hasMore, collapseLongUserMessages, onExpand]);
  /** The receipt draw-in plays exactly once, at the live chip→inline hand-off:
   *  the applied handler stamps the id as it commits the part, the render that
   *  first sees each identity captures it, and the effect consumes it so a
   *  remount (conversation revisit, reload, share view) renders the settled
   *  checks without motion. Captured per IDENTITY, not per mount — a content
   *  slot can be overwritten with a different steer (`applySteerPart` permits
   *  replacement at an index) while React reuses this component — and every
   *  identity consumes its id whether it animated or not, so nothing lingers.
   *  The membership selector scopes the subscription to THIS id — stamping or
   *  consuming one steer never re-renders the other mounted parts. */
  const [isLiveApplied, consumeLiveApplied] = useLiveAppliedSteer(steerId ?? '');
  const [captured, setCaptured] = useState<{ id: string | undefined; animate: boolean }>({
    id: steerId,
    animate: isLiveApplied,
  });
  if (captured.id !== steerId) {
    setCaptured({ id: steerId, animate: isLiveApplied });
  }
  const animateIn = captured.id === steerId && captured.animate;
  useEffect(() => {
    if (steerId == null || steerId.length === 0) {
      return;
    }
    consumeLiveApplied(steerId);
  }, [steerId, consumeLiveApplied]);

  if (typeof steer !== 'string' || steer.length === 0) {
    return null;
  }

  return (
    <div
      id={steerId ? `steer-${steerId}` : undefined}
      data-steer-render
      className="group relative my-5 flex w-full justify-end"
      data-testid="steer-part"
    >
      <div className="user-turn relative flex w-fit max-w-[90%] min-w-0 flex-col items-end sm:max-w-[85%]">
        <h2 className="sr-only">{label}</h2>
        {(files?.length ?? 0) > 0 && (
          <div
            data-testid="message-attachments"
            className="flex max-w-full flex-col items-end gap-3 pb-2"
          >
            <MessageFiles files={files} />
          </div>
        )}
        <div className="rounded-theme-surface rounded-ee-theme-control bg-surface-user-message px-theme-normal flex max-w-full flex-col items-start gap-2 py-2.5">
          <MessageQuotes quotes={quotes} />
          <CollapsibleText
            enabled={collapseLongUserMessages || hasMore}
            hasMore={hasMore}
            onExpand={onExpand}
          >
            <div
              className={cn(
                'markdown prose message-content light w-full break-words',
                !enableUserMsgMarkdown && 'whitespace-pre-wrap',
                'text-text-primary',
              )}
            >
              {enableUserMsgMarkdown
                ? renderMarkdown({ content: steer, variant: 'lite', isLatestMessage: false })
                : steer}
            </div>
          </CollapsibleText>
        </div>
        {/* The receipt trails the timestamp so the always-visible checks sit
         *  flush under the bubble's bottom-right corner. Leading them would
         *  park them wherever the hover-revealed time happens to end, and that
         *  width changes as the relative string ticks. */}
        <div className="text-text-secondary mt-1 flex min-h-8 items-center justify-end gap-2">
          <MessageTimestamp value={timestamp} className="ms-0" />
          {receiptState != null && (
            <SteerReceipt state={receiptState} live={isSubmitting} animateIn={animateIn} />
          )}
        </div>
      </div>
    </div>
  );
});

export default SteerPart;
