import { useState, useCallback, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  useLocalize,
  useScreenshot,
  useScrollbarGutter,
  useMessageScrolling,
  useConversationSeen,
} from '~/hooks';
import { MessagesViewProvider, useChatContext, useFileMapContext } from '~/Providers';
import { RowMountProvider, useProgressiveRowMount } from '~/hooks/Messages';
import { useChatSurface } from '~/components/Chat/Subagents/surface';
import useThreadRows from '~/hooks/Messages/useThreadRows';
import PendingSteers from './Content/Parts/PendingSteers';
import { autoScrollAtom } from '~/store/autoScroll';
import { FLAT_THREAD, ThreadList } from './Thread';
import { fontSizeAtom } from '~/store/fontSize';
import MultiMessage from './MultiMessage';
import ScrollButton from './ScrollButton';
import PendingTurn from './PendingTurn';
import MessageNav from './MessageNav';
import { cn } from '~/utils';
import store from '~/store';

function MessagesViewContent({
  messagesTree: _messagesTree,
  messages,
}: {
  messagesTree?: TMessage[] | null;
  messages?: TMessage[] | null;
}) {
  const localize = useLocalize();
  const fontSize = useAtomValue(fontSizeAtom);
  const { screenshotTargetRef } = useScreenshot();
  const [currentEditId, setCurrentEditId] = useState<number | string | null>(-1);

  const {
    conversation,
    contentRef,
    scrollableRef,
    messagesEndRef,
    handleSmoothToRef,
    debouncedHandleScroll,
    handleNearBottomChange,
  } = useMessageScrolling(_messagesTree);

  useScrollbarGutter(scrollableRef);

  const { conversationId } = conversation ?? {};
  const fileMap = useFileMapContext();
  const threadRows = useThreadRows(FLAT_THREAD ? messages : null, conversationId, fileMap);
  const { index, latestMessageId, latestMessageDepth } = useChatContext();
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const { showScrollButton, maximizeChatSpace } = useChatSurface();
  const autoScroll = useAtomValue(autoScrollAtom);

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
   *  callback so intersection flips keep re-rendering only `ScrollButton`. */
  const reportNearBottom = useConversationSeen(
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

  /** Re-arm from the conversation that owns the RENDERED tree: the Recoil
   *  conversation id lags the route during warm-cache navigation, and keying
   *  off it would first mount the new tree unwindowed, then narrow it after
   *  the fact — visibly unmounting rows the user is already reading. */
  const treeConversationId = _messagesTree?.[0]?.conversationId ?? conversationId;
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
  }, [latestMessageId, measureNearBottom, mountWindow, reportNearBottom, _messagesTree]);

  /* The redesign renders pending steers inside the streaming reply rather than
     as a stack floating over the bottom of the thread, so there is no band to
     reserve here and nothing publishes an overlay height. Composer panels that
     do float (an answer popover, a tool-approval review) are handled by
     ScrollButton through `composerOverlayCountFamily`. */
  const overlayConversationId = conversationId ?? Constants.NEW_CONVO;
  return (
    <>
      <div className="relative flex-1 overflow-hidden overflow-y-auto">
        <div className="relative h-full">
          <div
            className="scrollbar-gutter-stable"
            onScroll={debouncedHandleScroll}
            ref={scrollableRef}
            style={{
              height: '100%',
              overflowY: 'auto',
              width: '100%',
              /** The mount hook pins the anchor row itself (document-space
               *  measurement); native scroll anchoring reacting to the same
               *  insertions would double-correct. */
              overflowAnchor: mountWindow != null ? 'none' : undefined,
            }}
          >
            <div ref={contentRef} className="flex flex-col pb-9 pt-14">
              {(_messagesTree && _messagesTree.length == 0) || _messagesTree === null ? (
                <div
                  className={cn(
                    'flex w-full items-center justify-center p-3 text-text-secondary',
                    fontSize,
                  )}
                >
                  {localize('com_ui_nothing_found')}
                </div>
              ) : (
                <>
                  <div ref={screenshotTargetRef} data-testid="screenshot-target">
                    <RowMountProvider mountWindow={mountWindow}>
                      {FLAT_THREAD && threadRows ? (
                        <ThreadList
                          rows={threadRows}
                          setCurrentEditId={setCurrentEditId}
                          currentEditId={currentEditId ?? null}
                        />
                      ) : (
                        <MultiMessage
                          messagesTree={_messagesTree}
                          messageId={conversationId ?? null}
                          setCurrentEditId={setCurrentEditId}
                          currentEditId={currentEditId ?? null}
                        />
                      )}
                    </RowMountProvider>
                  </div>
                  <PendingTurn
                    scrollableRef={scrollableRef}
                    messages={messages}
                    maximizeChatSpace={maximizeChatSpace}
                  />
                </>
              )}
              {/** The pending surface is renderer-independent: both ThreadList
               * and MultiMessage end at this shared thread tail. Keeping its
               * mount here also preserves recovery controls when the message
               * tree is temporarily empty during navigation or delivery.
               *
               * It keys off the RENDERED tree for the same reason the mount
               * window does: during warm-cache navigation the Recoil
               * conversation id still names the source chat, and its Cancel
               * and Escalate actions would mutate that run while sitting at
               * the destination thread's tail. */}
              {treeConversationId != null && <PendingSteers conversationId={treeConversationId} />}
              <div id="messages-end" className="group h-0 w-full shrink-0" ref={messagesEndRef} />
            </div>
          </div>

          <ScrollButton
            conversationId={overlayConversationId}
            enabled={showScrollButton}
            maximizeChatSpace={maximizeChatSpace}
            scrollableRef={scrollableRef}
            messagesEndRef={messagesEndRef}
            scrollHandler={handleSmoothToRef}
            onNearBottomChange={handleNearBottom}
          />

          <MessageNav scrollableRef={scrollableRef} />
        </div>
      </div>
    </>
  );
}

export default function MessagesView({
  messagesTree,
  messages,
}: {
  messagesTree?: TMessage[] | null;
  messages?: TMessage[] | null;
}) {
  return (
    <MessagesViewProvider>
      <MessagesViewContent messagesTree={messagesTree} messages={messages} />
    </MessagesViewProvider>
  );
}
