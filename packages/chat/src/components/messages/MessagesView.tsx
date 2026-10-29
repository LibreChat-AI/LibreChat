import { useState, useCallback, useEffect } from 'react';
import { Constants } from 'librechat-data-provider';
import { cn, useLocalize } from '@librechat/client';
import type {
  Dispatch,
  RefObject,
  ReactNode,
  MouseEvent,
  ReactElement,
  SetStateAction,
} from 'react';
import type { TMessage } from 'librechat-data-provider';
import {
  RowMountProvider,
  useProgressiveRowMount,
} from '../../react/messages/useProgressiveRowMount';
import useScrollbarGutter from '../../react/messages/useScrollbarGutter';
import { useMessagesHost } from '../../react/messages/host';
import { useChatContext } from '../../react/chat/context';
import { useIsSubmitting } from '../../react/submission';
import { useMessagePartsHost } from '../../react/host';

/** What the thread slot renders the conversation from. */
export type MessagesThreadProps = {
  messagesTree?: TMessage[];
  messages?: TMessage[] | null;
  /** The conversation that owns the rendered tree. */
  conversationId?: string | null;
  currentEditId: string | number | null;
  setCurrentEditId: Dispatch<SetStateAction<string | number | null>>;
};

/** What the scroll-to-bottom slot needs to watch the end marker and scroll to it. */
export type MessagesScrollButtonProps = {
  conversationId: string;
  enabled: boolean;
  maximizeChatSpace: boolean;
  scrollableRef: RefObject<HTMLDivElement>;
  messagesEndRef: RefObject<HTMLDivElement>;
  scrollHandler: (event: MouseEvent<HTMLButtonElement>) => void;
  onNearBottomChange: (isNearBottom: boolean) => void;
};

export type MessagesViewProps = {
  messagesTree?: TMessage[] | null;
  messages?: TMessage[] | null;
  /** The viewer's preference for the scroll-to-bottom control. */
  showScrollButton: boolean;
  /** The viewer's chat-width preference. */
  maximizeChatSpace: boolean;
  /** Renders the conversation's rows. */
  renderThread: (props: MessagesThreadProps) => ReactNode;
  /** Renders the turn the reader just sent, ahead of its reply, at the thread's tail. */
  renderPendingTurn?: (props: {
    scrollableRef: RefObject<HTMLDivElement>;
    messages?: TMessage[] | null;
    maximizeChatSpace: boolean;
  }) => ReactNode;
  /** Renders the steers waiting on the conversation's run, after the last row. */
  renderPendingSteers?: (props: {
    conversationId: string;
    index: number;
    fullWidth: boolean;
  }) => ReactNode;
  /** Renders the scroll-to-bottom control. */
  renderScrollButton?: (props: MessagesScrollButtonProps) => ReactNode;
  /** Renders the in-thread navigation rail. */
  renderNav?: (props: {
    conversationId?: string | null;
    scrollableRef: RefObject<HTMLDivElement>;
  }) => ReactNode;
};

/**
 * The message list: the scroll container, the rendered thread with its progressive mount
 * window, the pending tail, and the end marker the scroll and seen reporting watch. The rows,
 * the pending pieces, the scroll control and the navigation rail arrive as slots.
 */
export default function MessagesView({
  messagesTree,
  messages,
  showScrollButton,
  maximizeChatSpace,
  renderThread,
  renderPendingTurn,
  renderPendingSteers,
  renderScrollButton,
  renderNav,
}: MessagesViewProps): ReactElement {
  const localize = useLocalize();
  const host = useMessagesHost();
  const fontSize = useMessagePartsHost().useFontSize();
  const screenshotTargetRef = host.useScreenshotTarget();
  const [currentEditId, setCurrentEditId] = useState<string | number | null>(-1);

  const {
    conversationId,
    contentRef,
    scrollableRef,
    messagesEndRef,
    handleSmoothToRef,
    debouncedHandleScroll,
    handleNearBottomChange,
  } = host.useScrolling(messagesTree);

  useScrollbarGutter(scrollableRef);

  const { index, latestMessageId, latestMessageDepth, messagesKey } = useChatContext();
  /** Re-arm from the conversation that owns the RENDERED tree: the app's conversation id lags
   *  the route during warm-cache navigation, and keying off it would first mount the new tree
   *  unwindowed, then narrow it after the fact, visibly unmounting rows the user is already
   *  reading. An empty tree has no message to name its owner, so the route's key stands in. */
  const treeConversationId = messagesTree?.[0]?.conversationId ?? (messagesKey || conversationId);
  const isSubmitting = useIsSubmitting(index);
  const autoScroll = host.useAutoScroll();

  /** Direct measurement for the one trigger the observer cannot serve: after a messages
   *  revalidation commits, the end marker may sit where no threshold was crossed, so no
   *  report comes; the seen hook re-measures the committed tree instead. Mirrors the
   *  observer's near-bottom meaning: the end marker inside the scrollable viewport. */
  const measureNearBottom = useCallback(() => {
    const end = messagesEndRef.current;
    const scrollable = scrollableRef.current;
    if (!end || !scrollable) {
      return null;
    }
    return end.getBoundingClientRect().top <= scrollable.getBoundingClientRect().bottom + 1;
  }, [messagesEndRef, scrollableRef]);

  /** MessageRow owns the durable DOM id. Scoping the lookup to this content root prevents a stale
   * row in another mounted surface from proving a hidden sibling branch visible. A body child is
   * required because progressive mounting can expose the row shell before its body commits. */
  const isResponseRendered = useCallback(
    (messageId: string) => {
      const content = contentRef.current;
      const row = document.getElementById(messageId);
      if (!content || !row || !content.contains(row)) {
        return false;
      }
      const body = row.querySelector('[data-testid="message-body"]');
      return (
        body != null && (body.childElementCount > 0 || (body.textContent?.trim().length ?? 0) > 0)
      );
    },
    [contentRef],
  );

  /** Piggybacks the messages-end observer rather than adding a second one, and stays a plain
   *  callback so intersection flips keep re-rendering only the scroll control. */
  const reportNearBottom = host.useConversationSeen(
    conversationId ?? undefined,
    isSubmitting,
    measureNearBottom,
    isResponseRendered,
  );
  const handleNearBottom = useCallback(
    (isNearBottom: boolean) => {
      handleNearBottomChange(isNearBottom);
      reportNearBottom(isNearBottom);
    },
    [handleNearBottomChange, reportNearBottom],
  );

  const mountWindow = useProgressiveRowMount({
    tailDepth: latestMessageDepth,
    anchorBottom: autoScroll || isSubmitting,
    isSubmitting,
    conversationId: treeConversationId,
    scrollableRef,
  });
  useEffect(() => {
    const isNearBottom = measureNearBottom();
    if (isNearBottom != null) {
      reportNearBottom(isNearBottom);
    }
  }, [latestMessageId, measureNearBottom, mountWindow, reportNearBottom, messagesTree]);

  /* Pending steers render inside the streaming reply rather than as a stack floating over the
     bottom of the thread, so there is no band to reserve here and nothing publishes an overlay
     height. Composer panels that do float (an answer popover, a tool-approval review) are
     handled by the scroll control through `composerOverlayCountFamily`. */
  const overlayConversationId = conversationId ?? Constants.NEW_CONVO;
  return (
    <div className="relative flex-1 overflow-hidden overflow-y-auto">
      <div className="relative h-full">
        {/* The mount hook pins the anchor row itself (document-space measurement); native
            scroll anchoring reacting to the same insertions would double-correct. */}
        <div
          className={cn(
            'h-full w-full scrollbar-gutter-stable overflow-y-auto',
            mountWindow != null && '[overflow-anchor:none]',
          )}
          onScroll={debouncedHandleScroll}
          ref={scrollableRef}
        >
          <div ref={contentRef} className="flex flex-col pt-14 pb-9">
            {messagesTree === null || messagesTree?.length === 0 ? (
              <div
                className={cn(
                  'text-text-secondary flex w-full items-center justify-center p-3',
                  fontSize,
                )}
              >
                {localize('com_ui_nothing_found')}
              </div>
            ) : (
              <>
                <div
                  key={treeConversationId}
                  ref={screenshotTargetRef}
                  data-conversation-id={treeConversationId}
                  data-testid="screenshot-target"
                >
                  <RowMountProvider mountWindow={mountWindow}>
                    {renderThread({
                      messagesTree,
                      messages,
                      conversationId: treeConversationId,
                      currentEditId,
                      setCurrentEditId,
                    })}
                  </RowMountProvider>
                </div>
                {renderPendingTurn?.({ scrollableRef, messages, maximizeChatSpace })}
              </>
            )}
            {/** The pending surface is renderer-independent: every thread renderer ends at
             * this shared tail. Keeping its mount here also preserves recovery controls when
             * the tree is temporarily empty during navigation or delivery.
             *
             * It keys off the RENDERED tree for the same reason the mount window does: during
             * warm-cache navigation the app's conversation id still names the source chat, and
             * its Cancel and Escalate actions would mutate that run while sitting at the
             * destination thread's tail. */}
            {treeConversationId != null &&
              renderPendingSteers?.({
                conversationId: treeConversationId,
                index,
                fullWidth: maximizeChatSpace,
              })}
            <div id="messages-end" className="group h-0 w-full shrink-0" ref={messagesEndRef} />
          </div>
        </div>

        {renderScrollButton?.({
          conversationId: overlayConversationId,
          enabled: showScrollButton,
          maximizeChatSpace,
          scrollableRef,
          messagesEndRef,
          scrollHandler: handleSmoothToRef,
          onNearBottomChange: handleNearBottom,
        })}

        {renderNav?.({ conversationId: treeConversationId, scrollableRef })}
      </div>
    </div>
  );
}
