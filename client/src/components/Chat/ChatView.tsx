import { memo, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useForm } from 'react-hook-form';
import { Spinner } from '@librechat/client';
import { useParams } from 'react-router-dom';
import { Constants, buildTree } from 'librechat-data-provider';
import type { TChatProject } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import {
  useScrollbarGutterSeed,
  useAddedResponse,
  useResumeOnLoad,
  useAdaptiveSSE,
  useChatHelpers,
  useQueueDrain,
  useQueuedTurnReveal,
  useLocalize,
} from '~/hooks';
import {
  ChatContext,
  AddedChatContext,
  ChatFormProvider,
  useFileMapContext,
  ComposerRestoreProvider,
} from '~/Providers';
import ApprovalProvider from './Messages/Content/ApprovalContext';
import ConversationStarters from './Input/ConversationStarters';
import { pendingApprovalActionFamily } from './approval/state';
import { composerLiftFamily } from './Input/Composer/state';
import { showComposerTipsAtom } from '~/store/composerTips';
import { useGetMessagesByConvoId } from '~/data-provider';
import Footer, { useConfiguredFooter } from './Footer';
import { AskAnswerHostProvider } from './ask/state';
import MessagesView from './Messages/MessagesView';
import Presentation from './Presentation';
import ChatForm from './Input/ChatForm';
import { TraceSurface } from './Trace';
import Landing from './Landing';
import Header from './Header';
import { cn } from '~/utils';
import store from '~/store';

function LoadingSpinner() {
  return (
    <div className="relative flex-1 overflow-hidden overflow-y-auto">
      <div className="relative flex h-full items-center justify-center">
        <Spinner className="text-text-primary" />
      </div>
    </div>
  );
}

function ChatView({ index = 0, project }: { index?: number; project?: TChatProject }) {
  const { conversationId } = useParams();
  const localize = useLocalize();
  const rootSubmission = useRecoilValue(store.submissionByIndex(index));
  const isSubmitting = useRecoilValue(store.isSubmittingFamily(index));
  const saveDrafts = useRecoilValue(store.saveDrafts);
  const showComposerTips = useAtomValue(showComposerTipsAtom);
  const enterToSend = useRecoilValue(store.enterToSend);
  const autoSendText = useRecoilValue(store.autoSendText);
  const speechSettingsInitialized = useRecoilValue(store.speechSettingsInitialized);
  const centerFormOnLanding = useRecoilValue(store.centerFormOnLanding);
  const pendingAction = useAtomValue(
    pendingApprovalActionFamily(conversationId ?? Constants.NEW_CONVO),
  );

  /** The welcome screen reserves the message column's scrollbar band before any
   *  column exists to measure it (see the column's class list below). */
  useScrollbarGutterSeed();

  /** A conversation carries a footer only for configured content, and the
   *  composer's clearance has to account for the bar when it does — including
   *  before the config answers, so a cold load does not jump. */
  const configuredFooter = useConfiguredFooter();

  /** Room an open composer popover needs below the composer; see the atom. */
  const composerLift = useAtomValue(composerLiftFamily(index));

  const methods = useForm<ChatFormValues>({
    defaultValues: { text: '' },
  });

  const fileMap = useFileMapContext();

  const {
    data: messages = null,
    isLoading,
    isFetching,
  } = useGetMessagesByConvoId(
    conversationId ?? '',
    {
      enabled: !!conversationId && conversationId !== Constants.SEARCH,
      /** Refetch stale caches on mount: navigation invalidates (not removes)
       * messages now, so a warm conversation renders instantly from cache and
       * reconciles in the background instead of unmounting into a spinner. */
      refetchOnMount: true,
    },
    { isStreaming: isSubmitting },
  );
  const messagesTree = useMemo(() => {
    const dataTree = buildTree({ messages, fileMap });
    return dataTree?.length === 0 ? null : (dataTree ?? null);
  }, [messages, fileMap]);

  const chatHelpers = useChatHelpers(index, conversationId);
  const addedChatHelpers = useAddedResponse();

  const activeConversation =
    chatHelpers.conversation?.conversationId === conversationId
      ? chatHelpers.conversation
      : undefined;
  const activeSubagentThread = activeConversation?.subagentThread;

  useAdaptiveSSE(rootSubmission, chatHelpers, false, index);

  // Auto-resume if navigating back to conversation with active job.
  // Wait for messages to load AND the warm-cache background revalidation to
  // settle: a stale invalidated cache mounts with isLoading false while the
  // refetch is in flight, and resume must not build from (or race) it.
  useResumeOnLoad(conversationId, chatHelpers.getMessages, index, !isLoading && !isFetching);

  // Show a server-owned queued follow-up as the next user turn as soon as its
  // predecessor completes, ahead of the receipt and active-job polls.
  const revealQueuedTurn = useQueuedTurnReveal(conversationId, index);

  // Auto-send queued follow-up messages once a run finishes cleanly.
  useQueueDrain(index, conversationId, chatHelpers.ask, revealQueuedTurn);

  let content: JSX.Element | null | undefined;
  const isLandingPage =
    (!messagesTree || messagesTree.length === 0) &&
    (conversationId === Constants.NEW_CONVO || !conversationId);

  /** A footer bar renders beneath the composer on the welcome screen always, and
   *  in a conversation when the deployment configured one. The shell already
   *  carried that answer, so this is the same value before and after the config
   *  resolves. */
  const footerBelow = isLandingPage || configuredFooter;
  const isNavigating = (!messagesTree || messagesTree.length === 0) && conversationId != null;
  const isProjectLandingPage = isLandingPage && project != null;

  if (isLoading && conversationId !== Constants.NEW_CONVO) {
    content = <LoadingSpinner />;
  } else if ((isLoading || isNavigating) && !isLandingPage) {
    content = <LoadingSpinner />;
  } else if (!isLandingPage) {
    content = <MessagesView messagesTree={messagesTree} messages={messages} />;
  } else {
    content = <Landing centerFormOnLanding={centerFormOnLanding} />;
  }

  const chatFormPlaceholder =
    isProjectLandingPage && project
      ? localize('com_ui_new_chat_in_project', { name: project.name })
      : undefined;

  // Recoil conversation can lag the route during navigation; only announce a
  // title that belongs to the conversation currently in the URL.
  const conversationTitle =
    chatHelpers.conversation?.conversationId === conversationId
      ? chatHelpers.conversation?.title?.trim()
      : undefined;
  const pageHeading =
    isLandingPage || !conversationTitle ? localize('com_ui_new_chat') : conversationTitle;
  const parentConversationId = activeSubagentThread?.parentConversationId;
  /** Durable child threads are an execution record owned by their parent agent.
   * Human continuation is a separate future fork/promotion flow, never an
   * in-place mutation of this canonical child transcript. */
  const isSubagentThreadReadOnly = activeSubagentThread != null;

  return (
    <AskAnswerHostProvider saveDrafts={saveDrafts}>
      <ChatFormProvider {...methods}>
        <ComposerRestoreProvider>
          <ChatContext.Provider value={chatHelpers}>
            <AddedChatContext.Provider value={addedChatHelpers}>
              <ApprovalProvider pendingAction={pendingAction}>
                <Presentation>
                  <TraceSurface conversationId={conversationId}>
                    <h1 className="sr-only">{pageHeading}</h1>
                    {/* Marks the header's controls as this pane's, so a pane-scoped
                        shortcut pressed from them acts here, not on the first pane. */}
                    <div data-chat-pane-portal={index} className="contents">
                      <Header
                        parentConversationId={parentConversationId}
                        readOnly={isSubagentThreadReadOnly}
                      />
                    </div>
                    <>
                      <div
                        data-chat-pane={index}
                        style={
                          isLandingPage && composerLift > 0
                            ? { transform: `translateY(-${composerLift}px)` }
                            : undefined
                        }
                        className={cn(
                          'flex flex-col',
                          isLandingPage
                            ? /* The gutter is reserved once per state, wherever the
                               centring happens. A conversation centres the composer
                               inside the band below, against a message column that
                               holds the scrollbar band back; the landing page centres
                               this whole column instead, greeting and composer
                               together, so it holds the same band back here. Without
                               it the composer lands 4px right of where a conversation
                               puts it and slides sideways on the way in. */
                              'scrollbar-gutter-spacer flex-1 items-center justify-end sm:justify-center'
                            : 'h-full overflow-y-auto',
                        )}
                      >
                        {content}
                        {/* Named + opaque so a view transition (the ask_user_question
                        popover ⇄ chat-card morph) paints the whole composer band
                        over the travelling card instead of letting it show
                        through below the composer. The background matches the
                        page, so normal rendering is unchanged. */}
                        <div
                          className={cn(
                            'bg-surface-primary-alt w-full [view-transition-name:chat-form]',
                            !isLandingPage && 'scrollbar-gutter-spacer',
                            isLandingPage && 'max-w-3xl transition-all duration-200 xl:max-w-4xl',
                          )}
                        >
                          {isLandingPage && <ConversationStarters />}
                          {isSubagentThreadReadOnly ? (
                            <div
                              className="text-text-secondary mx-auto w-full max-w-3xl px-4 py-3 text-center text-sm xl:max-w-4xl"
                              role="note"
                            >
                              {localize('com_ui_subagent_thread_read_only')}
                            </div>
                          ) : (
                            <ChatForm
                              index={index}
                              placeholder={chatFormPlaceholder}
                              project={isProjectLandingPage ? project : undefined}
                              isLandingPage={isLandingPage}
                              showComposerTips={showComposerTips}
                              enterToSend={enterToSend}
                              autoSendText={autoSendText}
                              speechSettingsInitialized={speechSettingsInitialized}
                              footerBelow={footerBelow}
                              centerFormOnLanding={centerFormOnLanding}
                            />
                          )}
                          {/* The generic disclaimer and the policy links are the
                              welcome screen's; a deployment's own footer stays
                              with the conversation that always showed it. */}
                          {!isLandingPage && configuredFooter && <Footer configuredOnly />}
                        </div>
                      </div>
                      {isLandingPage && <Footer />}
                    </>
                  </TraceSurface>
                </Presentation>
              </ApprovalProvider>
            </AddedChatContext.Provider>
          </ChatContext.Provider>
        </ComposerRestoreProvider>
      </ChatFormProvider>
    </AskAnswerHostProvider>
  );
}

export default memo(ChatView);
