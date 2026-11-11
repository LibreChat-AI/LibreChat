import { z } from 'zod';
import { ContentTypes } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import type { Response, ResponseAccounting, OutputItem } from './types';
import type { StoredResponseOutputLayout } from './foreground';
import type { StoredResponseMessage } from './persistence';
import {
  createResponseContext,
  buildAggregatedResponse,
  createResponseAggregator,
  sendResponsesErrorResponse,
} from './service';
import { createResponseAccountingCollector } from './accounting';
import { getSafeErrorMetadata } from '~/utils/errors';
import { selectStoredResponse } from './persistence';

const count = z.number().int().nonnegative().safe();
const totals = z.object({ input_tokens: count, output_tokens: count, total_tokens: count });
const accounting: z.ZodType<ResponseAccounting> = z.object({
  status: z.enum(['available', 'unavailable']),
  currency: z.literal('USD'),
  amount: z.string().optional(),
  basis: z.enum(['provider_reported', 'application_billing']).optional(),
  coverage: z.enum(['complete', 'partial', 'none']),
  reason: z.enum([
    'priced',
    'pricing_unavailable',
    'usage_unavailable',
    'partial_coverage',
    'mixed_bases',
    'conflicting_usage',
  ]),
  calls: z.array(
    z.object({
      provider: z.string().optional(),
      model: z.string().optional(),
      modelSource: z.enum(['provider_reported', 'runtime_reported', 'configured', 'unknown']),
      usageType: z.enum([
        'message',
        'summarization',
        'subagent',
        'sequential',
        'activity-label',
        'activity-phase',
        'reasoning-label',
      ]),
      inputTokens: count,
      outputTokens: count,
      cacheReadTokens: count,
      cacheWriteTokens: count,
      amount: z.string().optional(),
      basis: z.enum(['provider_reported', 'application_billing']).optional(),
      reason: z.enum(['priced', 'pricing_unavailable', 'usage_unavailable', 'invalid_usage']),
    }),
  ),
});
const receiptSchema = z.object({
  status: z
    .enum(['queued', 'in_progress', 'completed', 'failed', 'incomplete', 'cancelled'])
    .optional(),
  background: z.boolean().optional(),
  error: z
    .object({
      type: z.enum([
        'server_error',
        'invalid_request',
        'not_found',
        'model_error',
        'too_many_requests',
      ]),
      code: z.string().optional(),
      message: z.string(),
      param: z.string().optional(),
    })
    .nullable()
    .optional(),
  accounting: accounting.optional(),
  usage: totals
    .extend({
      input_tokens_details: z.object({ cached_tokens: count }),
      output_tokens_details: z.object({ reasoning_tokens: count }),
      primary: totals.optional(),
      subagent: totals.optional(),
    })
    .nullable(),
  outputLayout: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(['message', 'function_call', 'function_call_output']),
        callId: z.string().optional(),
        textParts: count.optional(),
      }),
    )
    .optional(),
  previousResponseId: z.string().nullable(),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
});
const backgroundReceiptSchema = z.object({ background: z.literal(true) });
const textPart = z.object({ type: z.literal(ContentTypes.TEXT), text: z.string() });
const toolPart = z.object({
  type: z.literal(ContentTypes.TOOL_CALL),
  tool_call: z.object({
    id: z.string().min(1),
    name: z.string(),
    args: z.unknown().optional(),
    output: z.unknown().optional(),
  }),
});

interface SavedMessage extends StoredResponseMessage {
  content?: unknown[];
  metadata?: Record<string, unknown>;
  model?: string;
  tokenCount?: number;
}
interface SavedConversation {
  createdAt?: Date | string;
  updatedAt?: Date | string;
  agent_id?: string;
  model?: string;
}

function isBackgroundMessage(message: SavedMessage): boolean {
  return backgroundReceiptSchema.safeParse(message.metadata?.responseReceipt).success;
}
export interface StoredForegroundResponseDependencies {
  getMessage: (query: { user: string; messageId: string }) => Promise<SavedMessage | null>;
  getConvo: (userId: string, conversationId: string) => Promise<SavedConversation | null>;
  getMessages: (query: { user: string; conversationId: string }) => Promise<SavedMessage[] | null>;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
}

/** Project canonical message content rather than retaining an unredacted duplicate response body. */
function output(message: SavedMessage): OutputItem[] {
  const items: OutputItem[] = [];
  for (const [index, part] of (message.content ?? []).entries()) {
    const text = textPart.safeParse(part);
    if (text.success) {
      items.push({
        type: 'message',
        id: `msg_${message.messageId}_${index}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: text.data.text, annotations: [], logprobs: [] }],
      });
      continue;
    }
    const parsed = toolPart.safeParse(part);
    if (!parsed.success || parsed.data.tool_call.output == null) continue;
    const call = parsed.data.tool_call;
    items.push({
      type: 'function_call',
      id: `fc_${message.messageId}_${index}`,
      call_id: call.id,
      name: call.name,
      arguments: typeof call.args === 'string' ? call.args : JSON.stringify(call.args ?? {}),
      status: 'completed',
    });
    items.push({
      type: 'function_call_output',
      id: `fco_${message.messageId}_${index}`,
      call_id: call.id,
      output: typeof call.output === 'string' ? call.output : JSON.stringify(call.output),
      status: 'completed',
    });
  }
  if (!items.length && message.text)
    items.push({
      type: 'message',
      id: `msg_${message.messageId}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: message.text, annotations: [], logprobs: [] }],
    });
  return items;
}

/** Identity/layout receipts contain no output text; content still comes from the privacy projection. */
function restoreOutputIdentity(
  items: OutputItem[],
  layout?: StoredResponseOutputLayout[],
): OutputItem[] {
  if (!layout) return items;
  const tools = new Map(
    items.flatMap((item) =>
      item.type === 'function_call' || item.type === 'function_call_output'
        ? [[`${item.type}:${item.call_id}`, item] as const]
        : [],
    ),
  );
  const texts = items.filter((item) => item.type === 'message');
  const consumed = new Set<string>();
  const output: OutputItem[] = [];
  let textIndex = 0;
  for (const entry of layout) {
    if (entry.type === 'message') {
      const count = entry.textParts ?? 1;
      const messages = texts.slice(textIndex, textIndex + count);
      textIndex += count;
      for (const message of messages) consumed.add(message.id);
      if (messages.length > 0 || count === 0)
        output.push({
          type: 'message',
          id: entry.id,
          role: 'assistant',
          status: 'completed',
          content: messages.flatMap((message) => message.content),
        });
      continue;
    }
    const item = tools.get(`${entry.type}:${entry.callId}`);
    if (item) {
      output.push({ ...item, id: entry.id });
      consumed.add(item.id);
      tools.delete(`${entry.type}:${entry.callId}`);
    }
  }
  for (const item of items) if (!consumed.has(item.id)) output.push(item);
  return output;
}

/** Foreground-only response-ID and legacy conversation-ID reads remain owner/tenant scoped. */
export function createStoredForegroundResponseReader(
  deps: StoredForegroundResponseDependencies,
): RequestHandler {
  return async (req, res) => {
    const responseId = req.params.id;
    const userId =
      req.user && 'id' in req.user && typeof req.user.id === 'string' ? req.user.id : undefined;
    const missing = () =>
      sendResponsesErrorResponse(
        res,
        404,
        'Response not found.',
        'not_found',
        'response_not_found',
      );
    if (!responseId || !userId) return missing();
    try {
      const selected = responseId.startsWith('resp_')
        ? await deps.getMessage({ user: userId, messageId: responseId })
        : undefined;
      if (
        selected &&
        (selected.isCreatedByUser ||
          selected.isUserSubmitted ||
          !selected.conversationId ||
          isBackgroundMessage(selected))
      )
        return missing();
      const conversationId = selected?.conversationId ?? responseId;
      const [conversation, messages] = await Promise.all([
        deps.getConvo(userId, conversationId),
        selected ? Promise.resolve([selected]) : deps.getMessages({ user: userId, conversationId }),
      ]);
      const message = selectStoredResponse(messages ?? [], responseId, selected != null)[0];
      if (!conversation || !message || isBackgroundMessage(message)) return missing();
      const receipt = receiptSchema.safeParse(message.metadata?.responseReceipt);
      const context = createResponseContext(
        {
          model: message.model ?? conversation.agent_id ?? conversation.model ?? 'unknown',
          input: '',
        },
        message.messageId,
      );
      context.stored = true;
      const response: Response = buildAggregatedResponse(context, createResponseAggregator());
      response.output = restoreOutputIdentity(
        output(message),
        receipt.success ? receipt.data.outputLayout : undefined,
      );
      const legacyTokens = count.safeParse(message.tokenCount);
      response.usage = null;
      if (receipt.success) response.usage = receipt.data.usage;
      else if (legacyTokens.success) {
        response.usage = {
          input_tokens: 0,
          output_tokens: legacyTokens.data,
          total_tokens: legacyTokens.data,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        };
      }
      response.accounting =
        receipt.success && receipt.data.accounting
          ? receipt.data.accounting
          : createResponseAccountingCollector().snapshot();
      if (receipt.success) {
        response.status = receipt.data.status ?? response.status;
        response.error = receipt.data.error ?? null;
      }
      response.previous_response_id = receipt.success ? receipt.data.previousResponseId : null;
      response.created_at = receipt.success
        ? receipt.data.createdAt
        : Math.floor(
            new Date(message.createdAt ?? conversation.createdAt ?? Date.now()).getTime() / 1000,
          );
      response.completed_at = receipt.success
        ? receipt.data.completedAt
        : Math.floor(new Date(conversation.updatedAt ?? Date.now()).getTime() / 1000);
      res.json(response);
    } catch (error) {
      deps.logger.error(
        '[Responses API] Error getting stored response',
        getSafeErrorMetadata(error),
      );
      sendResponsesErrorResponse(
        res,
        503,
        'Response storage is unavailable. Please try again.',
        'server_error',
        'response_storage_unavailable',
      );
    }
  };
}
