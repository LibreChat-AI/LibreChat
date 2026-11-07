import { memo, useMemo } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { Constants, buildTree } from 'librechat-data-provider';
import { ChatPane, getChatPaneView, QueuedTurnPortalProvider } from '@librechat/chat/components';
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
import { useAddedResponse, useLocalize } from '~/hooks';
import MessagesView from './Messages/MessagesView';
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
  const localize = useLocalize();
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
   *  composer's clearance has to account for the bar when it does — including
   *  before the config answers, so a cold load does not jump. */
  const configuredFooter = useConfiguredFooter();
  const landingFooter = useLandingFooter();

  const methods = useForm<ChatFormValues>({
    defaultValues: { text: '' },
  });

  const fileMap = useFileMapContext();

  const messagesTree = useMemo(() => {
    const dataTree = buildTree({ messages, fileMap });
    return dataTree?.length === 0 ? null : (dataTree ?? null);
  }, [messages, fileMap]);

  const chat = useChatContext();
  const addedChatHelpers = useAddedResponse();

  const activeConversation =
    chat.conversation?.conversationId === conversationId ? chat.conversation : undefined;
  const activeSubagentThread = activeConversation?.subagentThread;
  const chatProjectId = activeConversation?.chatProjectId || undefined;

  const view = getChatPaneView({
    conversationId,
    isLoading,
    hasMessages: messagesTree != null && messagesTree.length > 0,
  });
  const { isLanding: isLandingPage } = view;

  /** The welcome screen carries the full footer unless the deployment turned it
   *  off; otherwise a footer bar renders only for configured content. */
  const fullFooter = isLandingPage && landingFooter;
  const footerBelow = fullFooter || configuredFooter;
  const isProjectLandingPage = isLandingPage && project != null;

  const chatFormPlaceholder =
    isProjectLandingPage && project
      ? localize('com_ui_new_chat_in_project', { name: project.name })
      : undefined;

  // Recoil conversation can lag the route during navigation; only announce a
  // title that belongs to the conversation currently in the URL.
  const conversationTitle = activeConversation?.title?.trim();
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
          <QueuedTurnPortalProvider>
            <AddedChatContext.Provider value={addedChatHelpers}>
              <ApprovalProvider pendingAction={pendingAction}>
                <Presentation routePending={routePending}>
                  <TraceSurface conversationId={conversationId}>
                    <ChatPane
                      index={index}
                      view={view}
                      heading={pageHeading}
                      header={
                        <Header
                          parentConversationId={parentConversationId}
                          readOnly={isSubagentThreadReadOnly}
                        />
                      }
                      badge={chatProjectId ? <ProjectBadge projectId={chatProjectId} /> : null}
                      messages={<MessagesView messagesTree={messagesTree} messages={messages} />}
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
                      readOnlyNote={
                        isSubagentThreadReadOnly
                          ? localize('com_ui_subagent_thread_read_only')
                          : undefined
                      }
                      composer={
                        <ChatForm
                          index={index}
                          routePending={routePending}
                          placeholder={chatFormPlaceholder}
                          project={isProjectLandingPage ? project : undefined}
                          isLandingPage={isLandingPage}
                          enterToSend={enterToSend}
                          autoSendText={autoSendText}
                          speechSettingsInitialized={speechSettingsInitialized}
                          footerBelow={footerBelow}
                          centerFormOnLanding={centerFormOnLanding}
                        />
                      }
                      /* The generic disclaimer and the policy links are the welcome
                         screen's; a deployment's own footer stays with the
                         conversation that always showed it. */
                      bandFooter={
                        !fullFooter && configuredFooter ? <Footer configuredOnly /> : null
                      }
                      footer={fullFooter ? <Footer /> : null}
                      renderMascot={(bandRef) => (
                        <Lia
                          bandRef={bandRef}
                          landing={isLandingPage}
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
