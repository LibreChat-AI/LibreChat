import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CSSTransition } from 'react-transition-group';
import { setDefaultSubagentsHost } from '@librechat/chat/react';
import { SteerPart, ScrollToBottom } from '@librechat/chat/components';
import { ForkOptions, QueryKeys, dataService } from 'librechat-data-provider';
import type {
  SubagentsHost,
  MessagePartsHost,
  TaskContentScope,
  SubagentTaskContent,
  SubagentRetainedControl,
  SubagentNavigation,
  SubagentThreadRead,
  SubagentToolCallPart,
  SubagentJumpToLatestProps,
  SubagentContinueVariables,
  SubagentThreadReadOptions,
} from '@librechat/chat/react';
import type { ToolCallPartParams } from 'librechat-data-provider';
import {
  useToolCallPartQuery,
  useForkConvoMutation,
  useSubagentThreadQuery,
  useSubagentControlMutation,
} from '~/data-provider';
import {
  useSubagentTaskContentQuery,
  useSubagentToolContentQuery,
} from '~/data-provider/Subagents/content';
import ApprovalProvider from '~/components/Chat/Messages/Content/ApprovalContext';
import useNavigateToConvo from '~/hooks/Conversations/useNavigateToConvo';
import { ARTIFACTS_SHEET_MAX_WIDTH } from '~/utils/breakpoints';
import { useConfiguredFooter } from '~/components/Chat/Footer';
import useScaledMaxWidth from '~/hooks/useScaledMaxWidth';
import { useAgentsMapContext } from './AgentsMapContext';

/** Reads a shortened guidance message's full receipt, once the reader asks for it. */
function useRetainedControl(
  scope: TaskContentScope,
  invocationId: string,
  enabled: boolean,
): SubagentRetainedControl {
  const query = useQuery(
    [
      QueryKeys.subagentControlReceipt,
      scope.parentConversationId,
      scope.threadId,
      scope.taskId,
      invocationId,
    ],
    async () => {
      const response = await dataService.getSubagentControlReceipt(
        scope.parentConversationId,
        scope.threadId,
        scope.taskId,
        invocationId,
      );
      if (response.receipt.invocationId !== invocationId)
        throw new Error('subagent_control_identity_mismatch');
      return response;
    },
    { enabled, retry: 1, staleTime: Infinity, refetchOnWindowFocus: false },
  );
  return {
    message: query.data?.receipt.message,
    isFetching: query.isFetching,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}

/** A task's recovered content, read only while `enabled`. */
function useTaskContent(
  scope: TaskContentScope,
  { enabled }: { enabled: boolean },
): SubagentTaskContent {
  const query = useSubagentTaskContentQuery(scope, { enabled });
  return {
    data: query.data,
    isError: query.isError,
    isUnavailable: query.isUnavailable,
    refetch: () => void query.refetch(),
  };
}

function useThread(
  parentConversationId: string,
  threadId: string,
  taskId: string,
  { keepPreviousData, refetchInterval }: SubagentThreadReadOptions,
): SubagentThreadRead {
  const config =
    keepPreviousData == null && refetchInterval == null
      ? undefined
      : {
          ...(keepPreviousData == null ? {} : { keepPreviousData }),
          ...(refetchInterval == null ? {} : { refetchInterval }),
        };
  /** The panel's plain reads pass no options, so the query keeps its own schedule. */
  const args: Parameters<typeof useSubagentThreadQuery> =
    config == null
      ? [parentConversationId, threadId, taskId]
      : [parentConversationId, threadId, taskId, config];
  const query = useSubagentThreadQuery(...args);
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    isPreviousData: query.isPreviousData,
    isReadinessPending: query.isReadinessPending,
    refetch: query.refetch,
  };
}

function useControl(
  handlers: Parameters<SubagentsHost['useControl']>[0],
): ReturnType<SubagentsHost['useControl']> {
  const mutation = useSubagentControlMutation(handlers);
  return { mutate: mutation.mutate, isLoading: mutation.isLoading };
}

function useContinueChat(
  handlers: Parameters<SubagentsHost['useContinueChat']>[0],
): ReturnType<SubagentsHost['useContinueChat']> {
  const mutation = useForkConvoMutation(handlers);
  return {
    mutate: ({ conversationId, messageId }: SubagentContinueVariables) =>
      mutation.mutate({ conversationId, messageId, option: ForkOptions.DIRECT_PATH }),
    isLoading: mutation.isLoading,
  };
}

function useToolCallPart(
  params: ToolCallPartParams,
  options: { enabled: boolean },
  revision?: string,
): SubagentToolCallPart {
  const query = useToolCallPartQuery(params, options, revision);
  return {
    data: query.data,
    isError: query.isError,
    refetch: query.refetch,
  };
}

function useNavigation(): SubagentNavigation {
  const { navigateToConvo } = useNavigateToConvo();
  const navigate = useNavigate();
  return {
    openConversation: (conversation) => navigateToConvo(conversation),
    openConversationId: (conversationId) => navigate(`/c/${encodeURIComponent(conversationId)}`),
  };
}

const ignoreMessage: ReturnType<MessagePartsHost['useMessagesAsk']> = () => undefined;
const useNoMessagesAsk: MessagePartsHost['useMessagesAsk'] = () => ignoreMessage;

/** A child conversation's parts host: an ask inside it never reaches the parent's messages view. */
function useChildPartsHost(host: MessagePartsHost): MessagePartsHost {
  return useMemo(() => ({ ...host, useMessagesAsk: useNoMessagesAsk }), [host]);
}

/** The transcript's jump-to-latest control with the app's fade: the button takes pointers and
 *  focus only once the enter transition has settled. */
function JumpToLatest({ visible, onClick, maximizeChatSpace }: SubagentJumpToLatestProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isSettled, setIsSettled] = useState(false);
  return (
    <CSSTransition
      in={visible}
      timeout={{ enter: 300, exit: 180 }}
      classNames="scroll-animation"
      unmountOnExit={true}
      appear={true}
      nodeRef={ref}
      onEntered={() => setIsSettled(true)}
      onExit={() => setIsSettled(false)}
    >
      <ScrollToBottom
        ref={ref}
        scrollHandler={onClick}
        maximizeChatSpace={maximizeChatSpace}
        interactive={isSettled}
      />
    </CSSTransition>
  );
}

/** What subagent transcripts read from the app: the steer renderer and the jump-to-latest fade
 *  that still live here, the task-scoped reads and the agents map. Registered as the default when
 *  this module loads. */
export const appSubagentsHost: SubagentsHost = {
  renderSteer: (props) => <SteerPart {...props} />,
  renderJumpToLatest: (props) => <JumpToLatest {...props} />,
  useRetainedControl,
  useTaskContent,
  useToolContent: useSubagentToolContentQuery,
  useAgentsMap: useAgentsMapContext,
  useChildPartsHost,
  useThread,
  loadThread: (...args) => dataService.getSubagentThread(...args),
  useControl,
  useContinueChat,
  useToolCallPart,
  useNavigation,
  useSheetLayout: () => useScaledMaxWidth(ARTIFACTS_SHEET_MAX_WIDTH),
  useClearsFooter: useConfiguredFooter,
  renderApprovalScope: ({ scopeKey, children }) => (
    <ApprovalProvider key={scopeKey}>{children}</ApprovalProvider>
  ),
};

setDefaultSubagentsHost(appSubagentsHost);
