import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import type { StoredResponseMessage } from './persistence';
import type { Response, ResponseContext } from './types';
import type { InternalMessage } from './service';
import {
  ResponsePersistenceError,
  selectResponseHistory,
  projectResponseMessage,
} from './persistence';
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
  stage: (frame: ForegroundTerminalFrame<Saved>) => void;
  afterSettle: (
    execution: Pick<AgentExecutionEnrollment, 'terminalOutcome'>,
    error: unknown,
  ) => Promise<void>;
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

/** The shared host invokes settlement only for the owned, drained terminal attempt. */
export function createForegroundResponseTerminal<Saved>({
  context,
  requestedStore,
  logger,
}: {
  context: ResponseContext;
  requestedStore?: boolean;
  logger: Diagnostics;
}): ForegroundResponseTerminal<Saved> {
  let staged: ForegroundTerminalFrame<Saved> | undefined;
  const fail = (cancelled = false): void => {
    const frame = staged;
    staged = undefined;
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
  return {
    onSettlementError(error: unknown): void {
      logger.error('[Responses API] Failed to settle execution', getSafeErrorMetadata(error));
      fail();
    },
    stage(frame: ForegroundTerminalFrame<Saved>): void {
      if (staged) throw new Error('Response terminal result was already staged');
      staged = frame;
    },
    async afterSettle(
      execution: Pick<AgentExecutionEnrollment, 'terminalOutcome'>,
      error: unknown,
    ): Promise<void> {
      if (!staged) return;
      if (error != null || execution.terminalOutcome !== 'complete') {
        fail(execution.terminalOutcome === 'aborted');
        return;
      }
      const frame = staged;
      staged = undefined;
      context.stored = false;
      if (requestedStore === true) {
        let saved: { value: Saved } | undefined;
        try {
          saved = { value: await frame.save(frame.response) };
          context.stored = true;
        } catch (saveError) {
          logger.error('[Responses API] Error saving response', getSafeErrorMetadata(saveError));
        }
        if (saved && frame.afterStore) {
          try {
            await frame.afterStore(saved.value);
          } catch (notificationError) {
            logger.error(
              '[Responses API] Error announcing stored response',
              getSafeErrorMetadata(notificationError),
            );
          }
        }
      }
      frame.publish({ ...frame.response, store: context.stored });
    },
  };
}
