import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response as HttpResponse } from 'express';
import type { RequestHandler } from 'express';
import type { TurnConversationRequest, ConversationWriteContext } from '~/conversations/save';
import type { Response, ResponseContext, Usage, ResponseAccounting } from './types';
import type { PersistedReply, ReplyAnnouncement } from '~/conversations/announce';
import type { getLangfuseTraceMessageFields } from '~/langfuse/destinations';
import type { ConversationCodeEnvironmentDecision } from '~/code/decision';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import type { StoredResponseMessage } from './persistence';
import type { InternalMessage } from './service';
import {
  ResponsePersistenceError,
  selectResponseHistory,
  projectResponseMessage,
} from './persistence';
import { resolvePersistableCodeEnvironmentDecision } from '~/code/decision';
import { getConversationWriteContext } from '~/conversations/save';
import { isTemporaryTurn } from '~/conversations/retention';
import { sendResponsesErrorResponse } from './service';
import { getSafeErrorMetadata } from '~/utils/errors';

const inputSenders: Record<InternalMessage['role'], string> = {
  user: 'User',
  assistant: 'Agent',
  system: 'System',
};

interface Diagnostics {
  error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void;
}

/** Translate only the storage contract's safe error at the HTTP boundary. */
export function withResponsePersistenceErrors(handler: RequestHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (!(error instanceof ResponsePersistenceError)) throw error;
      sendResponsesErrorResponse(res, error.status, error.message, 'server_error', error.code);
    }
  };
}

export interface ResponseHistoryMessage extends StoredResponseMessage {
  content?: unknown;
  metadata?: Record<string, unknown>;
  isUserSubmitted?: boolean;
  userSubmittedPaths?: string[];
  userSubmittedMessageFieldPaths?: { path: string; field: string }[];
}

export type ForegroundHistoryMessage = InternalMessage &
  Pick<
    ResponseHistoryMessage,
    | 'messageId'
    | 'isCreatedByUser'
    | 'text'
    | 'isUserSubmitted'
    | 'userSubmittedPaths'
    | 'userSubmittedMessageFieldPaths'
  >;

function internalHistoryContent(message: ResponseHistoryMessage): InternalMessage['content'] {
  if (!Array.isArray(message.content)) return message.text ?? '';
  const content = message.content;
  if (
    !content.every(
      (part): part is { type: string; text?: string; image_url?: unknown } =>
        part != null &&
        typeof part === 'object' &&
        'type' in part &&
        typeof part.type === 'string' &&
        (!('text' in part) || typeof part.text === 'string'),
    )
  )
    throw new ResponsePersistenceError();
  return content;
}

function historyRole(message: ResponseHistoryMessage): InternalMessage['role'] {
  const role = message.isUserSubmitted ? message.metadata?.responseInputRole : undefined;
  if (role === 'system' || role === 'assistant') return role;
  return message.isCreatedByUser ? 'user' : 'assistant';
}

/** A lookup outage is not an empty conversation; model history must fail closed. */
export async function loadForegroundResponseHistory(
  input: { conversationId: string; userId: string; previousResponseId?: string },
  deps: {
    getMessages: (query: {
      conversationId: string;
      user: string;
    }) => Promise<ResponseHistoryMessage[] | null>;
  },
): Promise<ForegroundHistoryMessage[]> {
  try {
    const messages = selectResponseHistory(
      (await deps.getMessages({ conversationId: input.conversationId, user: input.userId })) ?? [],
      input.previousResponseId,
    );
    if (input.previousResponseId?.startsWith('resp_') && messages.length === 0)
      throw new ResponsePersistenceError();
    return messages.map((message) => ({
      role: historyRole(message),
      content: internalHistoryContent(message),
      messageId: message.messageId,
      isCreatedByUser: message.isCreatedByUser === true,
      ...(message.text !== undefined && { text: message.text }),
      ...(typeof message.isUserSubmitted === 'boolean' && {
        isUserSubmitted: message.isUserSubmitted,
      }),
      ...(message.userSubmittedPaths && { userSubmittedPaths: message.userSubmittedPaths }),
      ...(message.userSubmittedMessageFieldPaths && {
        userSubmittedMessageFieldPaths: message.userSubmittedMessageFieldPaths,
      }),
    }));
  } catch {
    throw new ResponsePersistenceError();
  }
}

export interface StoredResponseOutputLayout {
  id: string;
  type: 'message' | 'function_call' | 'function_call_output';
  callId?: string;
  textParts?: number;
}

/** Keep accounting beside canonical message content, without a second copy of private output. */
export function projectStoredResponseMessage(
  response: Response,
  parentMessageId: string,
): ReturnType<typeof projectResponseMessage> & {
  parentMessageId: string;
  metadata: {
    responseReceipt: Pick<Response, 'accounting' | 'usage'> & {
      previousResponseId: Response['previous_response_id'];
      createdAt: number;
      completedAt: number | null;
      outputLayout: StoredResponseOutputLayout[];
    };
  };
} {
  return {
    ...projectResponseMessage(response),
    parentMessageId,
    metadata: {
      responseReceipt: {
        outputLayout: response.output.flatMap((item): StoredResponseOutputLayout[] => {
          if (item.type === 'reasoning') return [];
          return [
            {
              id: item.id,
              type: item.type,
              ...(item.type === 'message'
                ? { textParts: item.content.filter((part) => part.type === 'output_text').length }
                : { callId: item.call_id }),
            },
          ];
        }),
        ...(response.accounting && { accounting: response.accounting }),
        usage: response.usage,
        previousResponseId: response.previous_response_id,
        createdAt: response.created_at,
        completedAt: response.completed_at,
      },
    },
  };
}

export async function saveForegroundResponseInputs<WriteContext>(
  input: {
    context: WriteContext;
    conversationId: string;
    messages: (InternalMessage & { messageId: string; parentMessageId: string })[];
    agentId: string;
  },
  deps: {
    saveMessage: (
      context: WriteContext,
      message: {
        messageId: string;
        conversationId: string;
        parentMessageId: string;
        isCreatedByUser: boolean;
        isUserSubmitted: true;
        metadata: { responseInputRole: InternalMessage['role'] };
        text: string;
        content: Exclude<InternalMessage['content'], string>;
        sender: string;
        endpoint: string;
        model: string;
      },
      options: { context: string },
    ) => Promise<unknown>;
  },
): Promise<void> {
  for (const message of input.messages) {
    await requireResponseStorageWrite(
      deps.saveMessage(
        input.context,
        {
          messageId: message.messageId,
          conversationId: input.conversationId,
          parentMessageId: message.parentMessageId,
          isCreatedByUser: message.role === 'user',
          isUserSubmitted: true,
          metadata: { responseInputRole: message.role },
          text:
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          content:
            typeof message.content === 'string'
              ? [{ type: ContentTypes.TEXT, text: message.content }]
              : message.content,
          sender: inputSenders[message.role],
          endpoint: EModelEndpoint.agents,
          model: input.agentId,
        },
        { context: 'Responses API - save response input' },
      ),
      { messageId: message.messageId, conversationId: input.conversationId },
    );
  }
}

export interface ForegroundResponseFailure {
  status: 409 | 503;
  code: 'response_execution_cancelled' | 'response_execution_unavailable';
  message: string;
}

interface ForegroundTerminalFrame<Saved> {
  response: Response;
  save: (response: Response) => Promise<Saved>;
  afterStore?: (saved: Saved) => Promise<void>;
  publish: (response: Response) => void;
  fail: (failure: ForegroundResponseFailure) => void;
}

export interface ForegroundResponseTerminal<Saved> {
  onSettlementError: (error: unknown) => void;
  beforeSettle: (
    execution: Pick<AgentExecutionEnrollment, 'signal' | 'track'>,
    error: unknown,
  ) => void;
  stage: (frame: ForegroundTerminalFrame<Saved>) => void;
  afterSettle: (
    execution: Pick<AgentExecutionEnrollment, 'terminalOutcome'>,
    error: unknown,
  ) => Promise<void>;
}

export interface ResponseTerminalCompletion<Execution = AgentExecutionEnrollment> {
  /** Required storage finished; persist a proposal while the provider still owns cleanup. */
  prepare: (response: Response) => Promise<void>;
  afterSettle: (execution: Execution, error: unknown) => Promise<void>;
}

/** Legacy storage can resolve absence/error records; those are not successful persistence. */
export async function requireResponseStorageWrite<Result>(
  operation: Promise<Result>,
  identity: { conversationId: string; messageId?: string },
): Promise<Result> {
  const value = await operation;
  if (
    value == null ||
    typeof value !== 'object' ||
    !('conversationId' in value) ||
    value.conversationId !== identity.conversationId ||
    (identity.messageId != null &&
      (!('messageId' in value) || value.messageId !== identity.messageId))
  )
    throw new ResponsePersistenceError();
  return value;
}

/** Persist while the provider owns cleanup; render only after the host confirms drain. */
export function createResponseTerminal<
  Saved,
  Execution extends Pick<AgentExecutionEnrollment, 'terminalOutcome'> = Pick<
    AgentExecutionEnrollment,
    'terminalOutcome'
  >,
>({
  context,
  requestedStore,
  logger,
  completion,
}: {
  context: ResponseContext;
  requestedStore?: boolean;
  logger: Diagnostics;
  completion?: ResponseTerminalCompletion<Execution>;
}): Omit<ForegroundResponseTerminal<Saved>, 'afterSettle'> & {
  afterSettle: (execution: Execution, error: unknown) => Promise<void>;
} {
  let staged: ForegroundTerminalFrame<Saved> | undefined;
  let phase: 'open' | 'staged' | 'prepared' | 'done' = 'open';
  const fail = (cancelled = false): void => {
    const frame = staged;
    staged = undefined;
    phase = 'done';
    if (completion) return;
    frame?.fail(
      cancelled
        ? {
            status: 409,
            code: 'response_execution_cancelled',
            message: 'Response execution was cancelled.',
          }
        : {
            status: 503,
            code: 'response_execution_unavailable',
            message: 'Response execution is unavailable. Please try again.',
          },
    );
  };
  const persist = async (frame: ForegroundTerminalFrame<Saved>): Promise<void> => {
    let saved: { value: Saved } | undefined;
    try {
      saved = { value: await frame.save(frame.response) };
      context.stored = true;
    } catch (saveError) {
      logger.error('[Responses API] Error saving response', getSafeErrorMetadata(saveError));
      if (completion) throw new ResponsePersistenceError();
    }
    if (!saved) return;
    if (frame.afterStore) {
      try {
        await frame.afterStore(saved.value);
      } catch (notificationError) {
        logger.error(
          '[Responses API] Error announcing stored response',
          getSafeErrorMetadata(notificationError),
        );
      }
    }
    await completion?.prepare({ ...frame.response, store: true });
  };
  return {
    onSettlementError(error: unknown): void {
      logger.error('[Responses API] Failed to settle execution', getSafeErrorMetadata(error));
      fail();
    },
    stage(frame: ForegroundTerminalFrame<Saved>): void {
      if (phase !== 'open') throw new Error('Response terminal result was already staged');
      staged = frame;
      phase = 'staged';
    },
    beforeSettle(
      execution: Pick<AgentExecutionEnrollment, 'signal' | 'track'>,
      error: unknown,
    ): void {
      if (!staged) return;
      if (phase !== 'staged') throw new Error('Response persistence was already prepared');
      phase = 'prepared';
      context.stored = false;
      if ((!completion && requestedStore !== true) || error != null || execution.signal.aborted)
        return;
      // Account/conversation cleanup must still see this generation until all data writes finish.
      execution.track(persist(staged));
    },
    async afterSettle(execution: Execution, error: unknown): Promise<void> {
      if (completion) {
        await completion.afterSettle(execution, error);
        staged = undefined;
        phase = 'done';
        return;
      }
      if (!staged) return;
      if (phase !== 'prepared' || error != null || execution.terminalOutcome !== 'complete') {
        fail(execution.terminalOutcome === 'aborted');
        return;
      }
      const frame = staged;
      staged = undefined;
      phase = 'done';
      frame.publish({ ...frame.response, store: context.stored === true });
    },
  };
}

/** Compatibility name for existing foreground callers. */
export const createForegroundResponseTerminal: typeof createResponseTerminal =
  createResponseTerminal;

interface CompletionRequest
  extends Omit<TurnConversationRequest, 'config' | 'resolvedConversation'> {
  config?: AppConfig;
  resolvedConversation?:
    | (ReturnType<typeof resolvePersistableCodeEnvironmentDecision> & {
        conversationId?: string;
        isTemporary?: boolean;
        expiredAt?: Date;
      })
    | null;
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
export interface ResponsePersistenceDependencies {
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

/** The shared turn's storage and transport inputs; terminal ownership is selected separately. */
export interface ResponseStageInput {
  terminal: Pick<ForegroundResponseTerminal<StoredReply>, 'stage'>;
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
}

export function createResponsePersistence(
  {
    request,
    conversationId,
    agentId,
    agent,
    codeEnvironmentDecision,
    messages,
    parentMessageId,
    visibleOutputTokens,
  }: Omit<ResponseStageInput, 'terminal' | 'response' | 'transport'>,
  deps: ResponsePersistenceDependencies,
) {
  const context = getConversationWriteContext(request);
  return {
    async saveConversation(): Promise<void> {
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
    },
    async saveInput(): Promise<void> {
      await saveForegroundResponseInputs(
        { context, conversationId, messages, agentId },
        { saveMessage: deps.saveMessage },
      );
    },
    async saveOutput(result: Response): Promise<StoredReply> {
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
    async announce(reply: StoredReply): Promise<void> {
      await deps.announceReply({
        userId: request.user?.id,
        conversationId,
        reply,
        context: 'Responses API - announce stored reply',
      });
    },
  };
}

/** Stage one shared persistence frame; the chosen terminal owner publishes after drain. */
export function stageResponseResult(
  { terminal, response, transport }: ResponseStageInput,
  persistence: ReturnType<typeof createResponsePersistence>,
): void {
  terminal.stage({
    response,
    save: async (result) => {
      await persistence.saveConversation();
      await persistence.saveInput();
      return persistence.saveOutput(result);
    },
    afterStore: persistence.announce,
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

/** Compatibility entry point for existing foreground callers. */
export function stageForegroundResponse(
  input: ResponseStageInput,
  deps: ResponsePersistenceDependencies,
): void {
  stageResponseResult(input, createResponsePersistence(input, deps));
}
