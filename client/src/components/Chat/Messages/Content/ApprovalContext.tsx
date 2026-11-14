import { useContext, useMemo, useRef } from 'react';
import { useAtomValue } from 'jotai';
import { Constants } from 'librechat-data-provider';
import { activeGenerationCreatedAtByConvoId } from '@librechat/chat/react';
import { useResumeSubmit as resumeWithHost } from '@librechat/chat/components';
import type { ApprovalResumeHost } from '@librechat/chat/react';
import { useSubmitAskAnswerMutation, useSubmitToolApprovalMutation } from '~/data-provider';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { ChatContext } from '~/Providers/ChatContext';

export {
  ApprovalProvider as default,
  ResumeSubmitContext,
  useApprovalContext,
  useAskSubmitStatus,
} from '@librechat/chat/components';
export type { ResumeSubmitTransport, ToolApprovalDecisionDraft } from '@librechat/chat/components';

/**
 * The app's resume adapter: conversation fields, ephemeral agent settings, and the
 * mutations that send a tool decision or an ask answer. The package hook owns the lock
 * and the status. Built here, not in the provider, so the composer can resume outside
 * `ApprovalProvider`.
 */
function useChatApprovalHost(): ApprovalResumeHost {
  const chatContext = useContext(ChatContext);
  const { getEphemeralAgent } = useChatSettings();
  const approvalMutation = useSubmitToolApprovalMutation();
  const askMutation = useSubmitAskAnswerMutation();
  const conversationId = chatContext?.conversation?.conversationId ?? Constants.NEW_CONVO;
  const activeGenerationCreatedAt = useAtomValue(
    activeGenerationCreatedAtByConvoId(conversationId),
  );
  const latest = useRef({
    chatContext,
    getEphemeralAgent,
    approvalMutation,
    askMutation,
    activeGenerationCreatedAt,
  });
  latest.current = {
    chatContext,
    getEphemeralAgent,
    approvalMutation,
    askMutation,
    activeGenerationCreatedAt,
  };

  return useMemo<ApprovalResumeHost>(
    () => ({
      readFields: () => {
        const current = latest.current;
        const conversation = current.chatContext?.conversation;
        const id = conversation?.conversationId;
        if (!id || id === Constants.NEW_CONVO) {
          return null;
        }
        return {
          conversationId: id,
          ...(current.activeGenerationCreatedAt != null && {
            generationCreatedAt: current.activeGenerationCreatedAt,
          }),
          endpoint: conversation.endpoint,
          endpointType: conversation.endpointType,
          agent_id: conversation.agent_id,
          model: conversation.model,
          spec: conversation.spec,
          // Ephemeral agents derive their instructions from promptPrefix. Re-send it so
          // the resumed run rebuilds the same graph and matches the server fingerprint.
          promptPrefix: conversation.promptPrefix,
          ephemeralAgent: current.getEphemeralAgent(id),
        };
      },
      submitToolApproval: (body, callbacks) => {
        latest.current.approvalMutation.mutate(body, callbacks);
      },
      submitAskAnswer: (body, callbacks) => {
        latest.current.askMutation.mutate(body, callbacks);
      },
      readMessages: () => {
        const chat = latest.current.chatContext;
        const messages = chat?.getMessages?.();
        if (chat == null || messages == null || chat.setMessages == null) {
          return null;
        }
        return { messages, setMessages: chat.setMessages };
      },
    }),
    [],
  );
}

/** App resume hook. The package owns readiness, locks and status; this supplies the host. */
export function useResumeSubmit() {
  const host = useChatApprovalHost();
  return resumeWithHost(host);
}
