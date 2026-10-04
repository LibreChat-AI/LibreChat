import { ContentTypes } from 'librechat-data-provider';
import { logger, CLIENT_MESSAGE_SELECT } from '@librechat/data-schemas';
import type { FullToolCall, ToolCallPartResponse } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type {
  MessageRequestValidation,
  FailedMessageValidationResult,
} from '~/middleware/messageValidation';

/** Scopes a read to one message the authenticated user owns. */
export interface ToolCallPartFilter {
  user: string;
  conversationId: string;
  messageId: string;
}

interface StoredMessage {
  content?: unknown[] | null;
}

export interface ToolCallPartDeps {
  /**
   * The data-schemas `getMessages` method. The projection is supplied here, so the part leaves
   * with exactly the fields a conversation load sends for it, private fields excluded.
   */
  getMessages: (filter: ToolCallPartFilter, select: string) => Promise<StoredMessage[] | null>;
}

export interface ToolCallPartInput extends ToolCallPartFilter {
  partIndex: number;
  toolCallId?: string;
}

export type ToolCallPartErrorCode = 'message_not_found' | 'part_not_found';

export type ToolCallPartResult =
  | { ok: true; value: { partIndex: number; toolCall: FullToolCall } }
  | { ok: false; error: { code: ToolCallPartErrorCode } };

interface StoredToolCallPart {
  type?: string;
  tool_call?: FullToolCall;
}

const MAX_PART_INDEX = 100_000;
const MAX_TOOL_CALL_ID_LENGTH = 512;
const PART_INDEX_PATTERN = /^\d{1,6}$/;

function getAgentToolCall(part: unknown): FullToolCall | undefined {
  if (part == null || typeof part !== 'object') {
    return undefined;
  }
  const { type, tool_call: toolCall } = part as StoredToolCallPart;
  if (type !== ContentTypes.TOOL_CALL || toolCall == null || typeof toolCall !== 'object') {
    return undefined;
  }
  return toolCall.type == null || toolCall.type === 'tool_call' ? toolCall : undefined;
}

/**
 * Finds the part at its index, or by tool-call id when the client's copy of the content no
 * longer lines up with storage (a client-only card was inserted or removed). An id that matches
 * a different part than the index points at never wins over the indexed part.
 */
function locatePart(
  content: unknown[],
  partIndex: number,
  toolCallId?: string,
): { partIndex: number; toolCall: FullToolCall } | undefined {
  const indexed = getAgentToolCall(content[partIndex]);
  if (indexed != null && (toolCallId == null || indexed.id === toolCallId)) {
    return { partIndex, toolCall: indexed };
  }
  if (toolCallId == null) {
    return undefined;
  }
  for (let i = 0; i < content.length; i++) {
    const toolCall = getAgentToolCall(content[i]);
    if (toolCall?.id === toolCallId) {
      return { partIndex: i, toolCall };
    }
  }
  return undefined;
}

/** Reads one stored tool-call part in full, scoped to the requesting user's message. */
export async function readToolCallPart(
  deps: ToolCallPartDeps,
  input: ToolCallPartInput,
): Promise<ToolCallPartResult> {
  const { user, conversationId, messageId, partIndex, toolCallId } = input;
  const messages = await deps.getMessages(
    { user, conversationId, messageId },
    CLIENT_MESSAGE_SELECT,
  );
  const content = messages?.[0]?.content;
  if (!Array.isArray(content)) {
    return { ok: false, error: { code: 'message_not_found' } };
  }
  const located = locatePart(content, partIndex, toolCallId);
  if (located == null) {
    return { ok: false, error: { code: 'part_not_found' } };
  }
  return { ok: true, value: located };
}

export type ToolCallPartRequest = Request<
  { conversationId?: string; messageId?: string; partIndex?: string },
  ToolCallPartResponse | { error: string },
  unknown,
  { toolCallId?: unknown }
> & { user?: { id?: string; tenantId?: string | null } };

export interface ToolCallPartHandlerDeps extends ToolCallPartDeps {
  /**
   * Starts the conversation access check the message routes use (ownership, the active-job
   * fallback, child-thread refusal). The part read runs beside it, and nothing is sent until it
   * passes.
   */
  validate: (req: ToolCallPartRequest) => MessageRequestValidation;
  sendValidationResponse: (res: Response, result: FailedMessageValidationResult) => unknown;
}

type SettledRead = { ok: true; value: ToolCallPartResult } | { ok: false; error: unknown };

function parsePartIndex(value: string | undefined): number | undefined {
  if (value == null || !PART_INDEX_PATTERN.test(value)) {
    return undefined;
  }
  const index = Number(value);
  return index <= MAX_PART_INDEX ? index : undefined;
}

/** `undefined` when absent, `null` when present but unusable. */
function parseToolCallId(value: unknown): string | undefined | null {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== 'string' || value === '' || value.length > MAX_TOOL_CALL_ID_LENGTH) {
    return null;
  }
  return value;
}

/**
 * `GET /api/messages/:conversationId/:messageId/parts/:partIndex[?toolCallId=]`, mounted behind
 * authentication. Conversation access is validated as the message routes do it, with the
 * user-scoped part read started alongside so an expansion costs one round trip of latency; the
 * read is itself scoped to the authenticated user, so a message id from another conversation or
 * account resolves to not found.
 */
export function createToolCallPartHandler(
  deps: ToolCallPartHandlerDeps,
): (req: ToolCallPartRequest, res: Response) => Promise<void> {
  return async (req, res) => {
    const userId = req.user?.id;
    const { conversationId, messageId } = req.params;
    const partIndex = parsePartIndex(req.params.partIndex);
    const toolCallId = parseToolCallId(req.query.toolCallId);
    if (!userId || !conversationId || !messageId) {
      res.status(404).json({ error: 'Tool call not found' });
      return;
    }
    if (partIndex == null || toolCallId === null) {
      res.status(400).json({ error: 'Invalid tool call part' });
      return;
    }
    try {
      const validation = deps.validate(req);
      if (!validation.shouldFetchMessages) {
        res.status(404).json({ error: 'Tool call not found' });
        return;
      }
      const read: Promise<SettledRead> = readToolCallPart(deps, {
        user: userId,
        conversationId,
        messageId,
        partIndex,
        toolCallId,
      }).then(
        (value) => ({ ok: true, value }),
        (error: unknown) => ({ ok: false, error }),
      );
      const verdict = await validation.promise;
      if (!verdict.ok) {
        deps.sendValidationResponse(res, verdict);
        return;
      }
      const settled = await read;
      if (!settled.ok) {
        throw settled.error;
      }
      const result = settled.value;
      if (!result.ok) {
        res.status(404).json({ error: 'Tool call not found' });
        return;
      }
      res.status(200).json({
        conversationId,
        messageId,
        partIndex: result.value.partIndex,
        tool_call: result.value.toolCall,
      });
    } catch (error) {
      logger.error('[toolCallPart] Failed to read tool call part', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
