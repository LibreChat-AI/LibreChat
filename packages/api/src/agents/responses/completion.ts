import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response as HttpResponse } from 'express';
import type { TurnConversationRequest, ConversationWriteContext } from '~/conversations/save';
import type { PersistedReply, ReplyAnnouncement } from '~/conversations/announce';
import type { getLangfuseTraceMessageFields } from '~/langfuse/destinations';
import type { ConversationCodeEnvironmentDecision } from '~/code/decision';
import type { Response, Usage, ResponseAccounting } from './types';
import type { ForegroundResponseTerminal } from './foreground';
import type { InternalMessage } from './service';
import {
  saveForegroundResponseInputs,
  projectStoredResponseMessage,
  requireResponseStorageWrite,
} from './foreground';
import { resolvePersistableCodeEnvironmentDecision } from '~/code/decision';
import { getConversationWriteContext } from '~/conversations/save';
import { isTemporaryTurn } from '~/conversations/retention';
import { sendResponsesErrorResponse } from './service';

interface CompletionRequest extends TurnConversationRequest {
  config?: AppConfig;
}
type InputMessage = Parameters<
  Parameters<typeof saveForegroundResponseInputs<ConversationWriteContext>>[1]['saveMessage']
>[1];
type OutputMessage = ReturnType<typeof projectStoredResponseMessage> & {
  messageId: string;
  conversationId: string;
  isCreatedByUser: false;
  sender: string;
  endpoint: string;
  model: string;
  finish_reason: string;
  tokenCount?: number;
};
interface StoredReply extends PersistedReply {
  conversationId: string;
  messageId: string;
}
interface CompletionDependencies {
  saveMessage: (
    context: ConversationWriteContext,
    message: InputMessage | OutputMessage,
    options: { context: string },
  ) => Promise<StoredReply | null>;
  saveConvo: (
    context: ConversationWriteContext,
    fields: ReturnType<typeof resolvePersistableCodeEnvironmentDecision> & {
      conversationId: string;
      endpoint: string;
      agent_id: string;
      title?: string;
      model?: string;
    },
    options: { context: string; initialAgentId: string | null },
  ) => Promise<unknown>;
  announceReply: (announcement: ReplyAnnouncement) => Promise<unknown>;
  resolveTitle: (request: CompletionRequest, candidate: string) => string | null;
  traceFields: typeof getLangfuseTraceMessageFields;
}

/** Own storage ordering and transport selection in the same typed completion boundary. */
export function stageForegroundResponse(
  {
    terminal,
    request,
    response,
    conversationId,
    agentId,
    agent,
    codeEnvironmentDecision,
    messages,
    parentMessageId,
    visibleOutputTokens,
    transport,
  }: {
    terminal: ForegroundResponseTerminal<StoredReply>;
    request: CompletionRequest;
    response: Response;
    conversationId: string;
    agentId: string;
    agent: { id?: string; name?: string; model?: string };
    codeEnvironmentDecision?: ConversationCodeEnvironmentDecision;
    messages: (InternalMessage & { messageId: string; parentMessageId: string })[];
    parentMessageId: string;
    visibleOutputTokens?: number;
    transport:
      | { type: 'json'; response: HttpResponse }
      | {
          type: 'stream';
          response: HttpResponse;
          finalize: (usage?: Usage, accounting?: ResponseAccounting, response?: Response) => void;
          fail: Parameters<ForegroundResponseTerminal<StoredReply>['stage']>[0]['fail'];
        };
  },
  deps: CompletionDependencies,
): void {
  terminal.stage({
    response,
    save: async (result) => {
      const context = getConversationWriteContext(request);
      const title = deps.resolveTitle(request, agent.name || 'Open Responses Conversation');
      await requireResponseStorageWrite(
        deps.saveConvo(
          context,
          {
            conversationId,
            endpoint: EModelEndpoint.agents,
            agent_id: agentId,
            ...resolvePersistableCodeEnvironmentDecision({
              conversationId,
              decision: codeEnvironmentDecision,
              conversation:
                request.resolvedConversation?.conversationId != null
                  ? {
                      conversationId: request.resolvedConversation.conversationId,
                      codeEnvironmentMode: request.resolvedConversation.codeEnvironmentMode,
                      codeWorkspaces: request.resolvedConversation.codeWorkspaces,
                    }
                  : undefined,
            }),
            ...(title != null && { title }),
            model: agent.model,
          },
          {
            context: 'Responses API - save conversation',
            initialAgentId: agent.id === agentId ? agentId : null,
          },
        ),
        { conversationId },
      );
      await saveForegroundResponseInputs(
        { context, conversationId, messages, agentId },
        { saveMessage: deps.saveMessage },
      );
      const traceFields = await deps.traceFields(request.config, result.id, {
        isTemporary: isTemporaryTurn(request),
      });
      return requireResponseStorageWrite(
        deps.saveMessage(
          context,
          {
            messageId: result.id,
            conversationId,
            ...projectStoredResponseMessage(result, parentMessageId),
            isCreatedByUser: false,
            ...traceFields,
            sender: 'Agent',
            endpoint: EModelEndpoint.agents,
            model: agentId,
            finish_reason: result.status === 'completed' ? 'stop' : result.status,
            tokenCount: visibleOutputTokens ?? result.usage?.output_tokens,
          },
          { context: 'Responses API - save assistant response' },
        ),
        { conversationId, messageId: result.id },
      ).then((saved) => {
        if (!saved) throw new Error('Response write returned no reply');
        return saved;
      });
    },
    afterStore: async (reply) => {
      await deps.announceReply({
        userId: request.user?.id,
        conversationId,
        reply,
        context: 'Responses API - announce stored reply',
      });
    },
    fail: (failure) => {
      if (transport.type === 'stream') return transport.fail(failure);
      sendResponsesErrorResponse(
        transport.response,
        failure.status,
        failure.message,
        'server_error',
        failure.code,
      );
    },
    publish: (result) => {
      if (transport.type === 'json') {
        transport.response.json(result);
        return;
      }
      transport.finalize(result.usage ?? undefined, result.accounting, result);
      transport.response.end();
    },
  });
}
