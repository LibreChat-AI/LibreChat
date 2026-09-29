import { useState } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useScreenshot, useMessageScrolling, useScrollbarGutter, useLocalize } from '~/hooks';
import { MessagesViewProvider, useChatContext, useFileMapContext } from '~/Providers';
import { RowMountProvider, useProgressiveRowMount } from '~/hooks/Messages';
import { useChatSurface } from '~/components/Chat/Subagents/surface';
import useThreadRows from '~/hooks/Messages/useThreadRows';
import { steerOverlayHeightFamily } from '~/store/steer';
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

  const { index, latestMessageDepth } = useChatContext();
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const { showScrollButton, maximizeChatSpace } = useChatSurface();
  const autoScroll = useAtomValue(autoScrollAtom);
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

  /** The in-flight steer overlay floats above the composer over the bottom of
   *  the thread (see `InFlightSteers`); reserve an equal band here so the
   *  newest message rests above it and older ones scroll behind. */
  const overlayConversationId = conversationId ?? Constants.NEW_CONVO;
  const steerOverlayHeight = useAtomValue(steerOverlayHeightFamily(overlayConversationId));

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
            <div
              ref={contentRef}
              className="flex flex-col pb-9 pt-14"
              style={
                steerOverlayHeight > 0
                  ? { paddingBottom: `calc(2.25rem + ${steerOverlayHeight}px)` }
                  : undefined
              }
            >
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
              <div
                id="messages-end"
                className="group h-0 w-full flex-shrink-0"
                ref={messagesEndRef}
              />
            </div>
          </div>

          <ScrollButton
            conversationId={overlayConversationId}
            enabled={showScrollButton}
            maximizeChatSpace={maximizeChatSpace}
            scrollableRef={scrollableRef}
            messagesEndRef={messagesEndRef}
            scrollHandler={handleSmoothToRef}
            onNearBottomChange={handleNearBottomChange}
            overlayHeight={steerOverlayHeight}
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
