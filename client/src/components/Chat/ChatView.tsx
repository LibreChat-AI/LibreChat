import { memo } from 'react';
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
import Footer, { useLandingFooter, useConfiguredFooter } from './Footer';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import ApprovalProvider from './Messages/Content/ApprovalContext';
import ConversationStarters from './Input/ConversationStarters';
import ProjectBadge from '~/components/Projects/ProjectBadge';
import { OwnerTextProvider } from './Messages/PrivateText';
import MessagesView from './Messages/MessagesView';
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
};

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
  const addedChatHelpers = useAddedResponse();

  return (
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
                        <Header parentConversationId={parentConversationId} readOnly={readOnly} />
                      )}
                      renderBadge={(projectId) => <ProjectBadge projectId={projectId} />}
                      renderMessages={(thread) => <MessagesView {...thread} />}
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
                      )}
                      /* The generic disclaimer and the policy links are the welcome
                         screen's; a deployment's own footer stays with the
                         conversation that always showed it. */
                      renderFooter={(placement) =>
                        placement === 'band' ? <Footer configuredOnly /> : <Footer />
                      }
                      renderMascot={(bandRef, landing) => (
                        <Lia bandRef={bandRef} landing={landing} submission={rootSubmission} />
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
  );
}

function ChatView(props: ChatViewProps) {
  const { index = 0 } = props;
  const { conversationId } = useParams();

  return (
    <ChatSessionProvider index={index} conversationId={conversationId}>
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
