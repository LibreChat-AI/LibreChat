import { useMemo } from 'react';
import { createInstance } from 'i18next';
import { hasParallelLanes } from '@librechat/chat';
import en from '@librechat/chat/locales/en.json';
import { PortalProvider, ThemeProvider } from '@librechat/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { initReactI18next, I18nextProvider, useTranslation } from 'react-i18next';
import {
  useMessageContext,
  emptyToolCallChrome,
  MessagePartsHostProvider,
} from '@librechat/chat/react';
import {
  ContentRow,
  useAttachments,
  AttachmentGroup,
  contentPartsRenderer,
} from '@librechat/chat/components';
import type { MessagePartsHost, ToolCallChrome } from '@librechat/chat/react';
import type { ContentPartsSlots } from '@librechat/chat/components';
import type { PtcTrace } from '@librechat/chat';
import type { ReactNode } from 'react';

/**
 * An app that is not LibreChat, drawing a conversation with `@librechat/chat` alone: the package's
 * rows and parts, its compiled stylesheet, its shipped strings and the client package's theme. Every
 * member a host has to supply is filled here with what such an app has, which for a page with no
 * server is very little: no user, no files, no agents, no MCP servers.
 */

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

const NO_STEER: [boolean, (steerId: string) => void] = [false, () => undefined];
const NO_CLAIM: [string | null, () => void] = [null, () => undefined];
/** The trace a programmatic tool call shows with no live run behind it. The package names this
 *  value internally but does not export it, so a host writes it out. */
const NO_TRACE: PtcTrace = { entries: [], dropped: 0 };
const USER_TEXT = {
  enableUserMsgMarkdown: true,
  collapseLongUserMessages: true,
  usernameDisplay: false,
};

/** The tool card's strings and its attachment row, from the package and the shipped strings. */
function useToolCallChrome(): ToolCallChrome {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      ...emptyToolCallChrome(),
      localize: (key, values) => t(key, values),
      renderAttachments: (attachments) => <AttachmentGroup attachments={attachments} />,
    }),
    [t],
  );
}

/**
 * MCP Apps are the host's to run. This page has no App runtime, so it marks where each one goes;
 * the check compares that position, not what an App draws.
 */
export const outsideSlots: ContentPartsSlots = {
  renderApp: (occurrence, ordinal) => (
    <div data-outside-app={occurrence.resource.uri} data-ordinal={ordinal} />
  ),
};

/** The settings follow LibreChat's defaults, so a difference the check finds is the package's. */
export const outsideHost: MessagePartsHost = {
  useMessage: () => {
    const { messageId, isSubmitting, isLatestMessage, nextType, conversationId, partIndex } =
      useMessageContext();
    return { messageId, isSubmitting, isLatestMessage, nextType, conversationId, partIndex };
  },
  renderContentParts: contentPartsRenderer(outsideSlots),
  renderFilePreview: () => null,
  useSmoothStreaming: () => false,
  useAgent: () => undefined,
  renderAgentIcon: () => null,
  renderAgentAvatar: () => null,
  useFontSize: () => 'text-base',
  useShowThinking: () => false,
  useAutoExpandTools: () => false,
  useLaTeXParsing: () => true,
  useChatDirection: () => 'auto',
  useUserTextPreferences: () => USER_TEXT,
  useUser: () => undefined,
  useFileMap: () => undefined,
  useToast: () => () => undefined,
  useSandboxStarting: () => false,
  usePtcTrace: () => NO_TRACE,
  useToolArtifactClaim: () => NO_CLAIM,
  useSteerEscalating: () => false,
  usePaneConversationId: () => null,
  useLiveAppliedSteer: () => NO_STEER,
  useShare: () => ({}),
  useLoadedSkill: () => undefined,
  useToolCallChrome,
};

/** The providers an outside app wraps the chat in, per the package README. */
export function OutsideProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <MessagePartsHostProvider host={outsideHost}>
            <PortalProvider className="librechat">
              <div className="librechat">{children}</div>
            </PortalProvider>
          </MessagePartsHostProvider>
        </QueryClientProvider>
      </I18nextProvider>
    </ThemeProvider>
  );
}

type Message = Record<string, unknown> & {
  messageId: string;
  isCreatedByUser?: boolean;
  content?: unknown[];
};

/** One message as the row LibreChat's chat view draws for it. */
function OutsideRow({
  message,
  conversation,
  index,
  isLast,
  isSubmitting,
}: {
  message: Message;
  conversation: Record<string, unknown>;
  index: number;
  isLast: boolean;
  isSubmitting: boolean;
}) {
  const { attachments, searchResults } = useAttachments({
    messageId: message.messageId,
    attachments: message.attachments as never,
  });
  return (
    <ContentRow
      message={message as never}
      conversation={conversation as never}
      index={index}
      label={message.isCreatedByUser ? 'You' : String(message.sender ?? 'Assistant')}
      iconData={
        { endpoint: String(message.endpoint ?? ''), model: String(message.model ?? '') } as never
      }
      hasConfiguredSender={false}
      isLast={isLast}
      isLatestMessage={isLast}
      isSubmitting={isLast && isSubmitting}
      edit={false}
      enterEdit={() => undefined}
      attachments={attachments}
      searchResults={searchResults}
      hasParallelContent={hasParallelLanes(message.content as never)}
      fullWidth={false}
      toolbar={null}
    />
  );
}

/** A conversation's messages, one row each. */
export function OutsideConversation({
  conversation,
  messages,
  isSubmitting = false,
}: {
  conversation: Record<string, unknown>;
  messages: Message[];
  isSubmitting?: boolean;
}) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6" data-outside-host>
      {messages.map((message, index) => (
        <OutsideRow
          key={message.messageId}
          message={message}
          conversation={conversation}
          index={index}
          isLast={index === messages.length - 1}
          isSubmitting={isSubmitting}
        />
      ))}
    </main>
  );
}
