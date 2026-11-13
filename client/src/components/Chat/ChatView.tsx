import { memo, useEffect, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { Constants } from 'librechat-data-provider';
import { ChatScreen, QueuedTurnPortalProvider } from '@librechat/chat/components';
import {
  submissionByIndex,
  ChatSessionProvider,
  useScrollbarGutterSeed,
  AskAnswerHostProvider,
  ComposerRestoreProvider,
  pendingApprovalActionFamily,
} from '@librechat/chat/react';
import type { TChatProject, TMessage } from 'librechat-data-provider';
import type { ChatFormValues } from '~/common';
import { AddedChatContext, ChatFormProvider, useChatContext, useFileMapContext } from '~/Providers';
import { AssistantsMapContext, useAssistantsMapContext } from '~/Providers/AssistantsMapContext';
import { AgentsMapContext, useAgentsMapContext } from '~/Providers/AgentsMapContext';
import Footer, { useLandingFooter, useConfiguredFooter } from './Footer';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import ApprovalProvider from './Messages/Content/ApprovalContext';
import { preloadMessages, renderMessages } from './Messages/load';
import ConversationStarters from './Input/ConversationStarters';
import ProjectBadge from '~/components/Projects/ProjectBadge';
import { OwnerTextProvider } from './Messages/PrivateText';
import { TargetContext } from '~/Providers/TargetContext';
import useTarget from '~/hooks/Chat/target';
import { useAddedResponse } from '~/hooks';
import Presentation from './Presentation';
import ChatForm from './Input/ChatForm';
import { TraceSurface } from './Trace';
import Lia from '~/components/Lia';
import Landing from './Landing';
import Header from './Header';
import store from '~/store';

type ChatViewProps = {
  index?: number;
  project?: TChatProject;
  /** The route is loading another conversation, or failed to. */
  routePending?: boolean;
  historyReady?: boolean;
};

/**
 * The generic disclaimer and the policy links are the welcome screen's, where the deployment
 * places them; a deployment's own footer stays with the conversation that always showed it.
 */
function renderFooter(placement: 'full' | 'composer' | 'band') {
  if (placement === 'band') {
    return <Footer configuredOnly />;
  }
  if (placement === 'composer') {
    return (
      <Footer className="text-text-muted hidden flex-wrap items-center justify-center gap-2 px-2 pb-2 text-center text-xs sm:flex" />
    );
  }
  return <Footer />;
}

function warmMessages() {
  preloadMessages().catch(() => undefined);
}

function ChatViewPane({
  index = 0,
  project,
  routePending = false,
  conversationId,
  messages,
  isLoading,
}: ChatViewProps & {
  conversationId?: string;
  messages: TMessage[] | null;
  isLoading: boolean;
}) {
  const rootSubmission = useAtomValue(submissionByIndex(index));
  const { saveDrafts } = useChatSettings();
  const enterToSend = useRecoilValue(store.enterToSend);
  const autoSendText = useRecoilValue(store.autoSendText);
  const speechSettingsInitialized = useRecoilValue(store.speechSettingsInitialized);
  const centerFormOnLanding = useRecoilValue(store.centerFormOnLanding);
  const pendingAction = useAtomValue(
    pendingApprovalActionFamily(conversationId ?? Constants.NEW_CONVO),
  );

  /** A routed conversation shows its messages as soon as they arrive, so the list's code
   *  loads alongside them instead of after. */
  const routedConversation = conversationId != null && conversationId !== Constants.NEW_CONVO;
  useEffect(() => {
    if (routedConversation) {
      preloadMessages().catch(() => undefined);
    }
  }, [routedConversation]);

  /** The welcome screen reserves the message column's scrollbar band before any
   *  column exists to measure it (see the column classes in `ChatPane`). */
  useScrollbarGutterSeed();

  /** A conversation carries a footer only for configured content, and the
   *  composer's clearance has to account for the bar when it does, including
   *  before the config answers, so a cold load does not jump. */
  const configuredFooter = useConfiguredFooter();
  const landingFooter = useLandingFooter();

  const methods = useForm<ChatFormValues>({
    defaultValues: { text: '' },
  });

  const fileMap = useFileMapContext();
  const chat = useChatContext();
  const target = useTarget(chat.conversation, chat.setConversation);
  const agentsMap = useAgentsMapContext();
  const assistantsMap = useAssistantsMapContext();
  const selectedAgents = useMemo(
    () => (target.agent ? { ...agentsMap, [target.agent.id]: target.agent } : agentsMap),
    [agentsMap, target.agent],
  );
  const selectedAssistants = useMemo(
    () =>
      target.assistant && chat.conversation?.endpoint
        ? {
            ...assistantsMap,
            [chat.conversation.endpoint]: {
              ...assistantsMap?.[chat.conversation.endpoint],
              [target.assistant.id]: target.assistant,
            },
          }
        : assistantsMap,
    [assistantsMap, target.assistant, chat.conversation?.endpoint],
  );
  const addedChatHelpers = useAddedResponse();
  const addedTarget = useTarget(addedChatHelpers.conversation, addedChatHelpers.setConversation);
  const readiness = useMemo(
    () => ({
      ready: target.ready && (addedChatHelpers.conversation == null || addedTarget.ready),
      pending: target.pending || (addedChatHelpers.conversation != null && addedTarget.pending),
      failed: target.failed || (addedChatHelpers.conversation != null && addedTarget.failed),
      retry: () => {
        target.retry();
        if (addedChatHelpers.conversation) addedTarget.retry();
      },
    }),
    [target, addedTarget, addedChatHelpers.conversation],
  );

  return (
    <TargetContext.Provider value={readiness}>
      <AgentsMapContext.Provider value={selectedAgents}>
        <AssistantsMapContext.Provider value={selectedAssistants}>
          <AskAnswerHostProvider saveDrafts={saveDrafts}>
            <ChatFormProvider {...methods}>
              <ComposerRestoreProvider>
                <QueuedTurnPortalProvider>
                  <AddedChatContext.Provider value={addedChatHelpers}>
                    <ApprovalProvider pendingAction={pendingAction}>
                      <Presentation routePending={routePending}>
                        <TraceSurface conversationId={conversationId}>
                          <ChatScreen
                            index={index}
                            conversationId={conversationId}
                            messages={messages}
                            fileMap={fileMap}
                            isLoading={isLoading}
                            project={project}
                            landingFooter={landingFooter}
                            configuredFooter={configuredFooter}
                            renderHeader={({ parentConversationId, readOnly }) => (
                              <Header
                                parentConversationId={parentConversationId}
                                readOnly={readOnly}
                              />
                            )}
                            renderBadge={(projectId) => <ProjectBadge projectId={projectId} />}
                            renderMessages={renderMessages}
                            landing={<Landing centerFormOnLanding={centerFormOnLanding} />}
                            renderColumn={(column) => (
                              <OwnerTextProvider
                                messages={messages}
                                conversationId={conversationId}
                                isSubmitting={chat.isSubmitting}
                              >
                                {column}
                              </OwnerTextProvider>
                            )}
                            starters={<ConversationStarters />}
                            renderComposer={({ isLanding, footerBelow, project, placeholder }) => (
                              /* Typing a first message is the cue that the list is next. */
                              <div className="contents" onFocusCapture={warmMessages}>
                                <ChatForm
                                  index={index}
                                  routePending={routePending}
                                  placeholder={placeholder}
                                  project={project}
                                  isLandingPage={isLanding}
                                  enterToSend={enterToSend}
                                  autoSendText={autoSendText}
                                  speechSettingsInitialized={speechSettingsInitialized}
                                  footerBelow={footerBelow}
                                  centerFormOnLanding={centerFormOnLanding}
                                />
                              </div>
                            )}
                            renderFooter={renderFooter}
                            renderMascot={(bandRef, landing) => (
                              <Lia
                                bandRef={bandRef}
                                landing={landing}
                                submission={rootSubmission}
                              />
                            )}
                          />
                        </TraceSurface>
                      </Presentation>
                    </ApprovalProvider>
                  </AddedChatContext.Provider>
                </QueuedTurnPortalProvider>
              </ComposerRestoreProvider>
            </ChatFormProvider>
          </AskAnswerHostProvider>
        </AssistantsMapContext.Provider>
      </AgentsMapContext.Provider>
    </TargetContext.Provider>
  );
}

function ChatView(props: ChatViewProps) {
  const { index = 0, historyReady = true } = props;
  const { conversationId } = useParams();

  return (
    <ChatSessionProvider index={index} conversationId={conversationId} historyReady={historyReady}>
      {({ messages, isLoading }) => (
        <ChatViewPane
          {...props}
          conversationId={conversationId}
          messages={messages}
          isLoading={isLoading}
        />
      )}
    </ChatSessionProvider>
  );
}

export default memo(ChatView);
