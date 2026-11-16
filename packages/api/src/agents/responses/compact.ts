import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { responsesProtocolSchema } from 'librechat-data-provider';
import type { Request, RequestHandler } from 'express';
import type { PrivateTextCipher } from '~/protection/private/crypto';
import type { initializeAgent } from '../initialize';
import type { CompactionItemParam } from './types';
import type { ServerRequest } from '~/types/http';
import { sendResponsesErrorResponse, validateInputToolExchanges } from './service';
import { createPrivateTextCipher } from '~/protection/private/crypto';
import { getSafeErrorMetadata } from '~/utils/errors';
import { responseTenantId } from './scope';

const compactItem = z.object({
  type: z.literal('compaction'),
  encrypted_content: z.string().min(1),
}) satisfies z.ZodType<CompactionItemParam>;
const payload = z.object({
  kind: z.literal('librechat.responses.compaction.v1'),
  userId: z.string(),
  tenantId: z.string(),
  model: z.string(),
  createdAt: z.number(),
  summary: z.string().min(1),
});
const summaryEvent = z.object({
  summary: z.object({ content: z.array(z.object({ text: z.string() }).passthrough()) }),
});
const completedResponse = z
  .object({ status: z.literal('completed'), usage: z.unknown().optional() })
  .passthrough();
const modes = new WeakMap<Request, { summary?: string; replayToolNames: ReadonlySet<string> }>();
const historyCall = z.object({ type: z.literal('function_call'), name: z.string().min(1) });
function historyToolNames(input: unknown): ReadonlySet<string> {
  return new Set(
    Array.isArray(input)
      ? input.flatMap((item) => {
          const parsed = historyCall.safeParse(item);
          return parsed.success ? [parsed.data.name] : [];
        })
      : [],
  );
}

function options(req: Request) {
  return responsesProtocolSchema.parse(
    (req as ServerRequest).config?.endpoints?.agents?.responses ?? {},
  ).compaction;
}
function owner(req: Request) {
  const user = (req as ServerRequest).user;
  return { userId: String(user?.id ?? ''), tenantId: responseTenantId(user?.tenantId) ?? '' };
}

/** Only the admitted compact route can request summarize-only execution. */
type Initialization = Parameters<typeof initializeAgent>[0];
interface ResponseRunOperation {
  replayToolNames: ReadonlySet<string>;
  initialize: (params: Initialization) => Initialization;
  runOptions: { summarizeOnly?: boolean; summarizeFullWindow?: boolean };
  handlers: <T extends Record<string, unknown>>(
    handlers: T,
  ) => T | (T & { on_summarize_complete: { handle: (event: string, data: unknown) => void } });
}
export function responseRunOperation(req: Request): ResponseRunOperation {
  const mode = modes.get(req);
  return {
    replayToolNames: mode?.replayToolNames ?? new Set(),
    initialize: (params) => {
      if (!mode) return params;
      if (
        params.agent &&
        z
          .object({ enabled: z.literal(false) })
          .safeParse(Reflect.get(params.agent, 'summarization')).success
      ) {
        const error = new Error('Compaction is disabled for this agent.');
        throw Object.assign(error, { status: 409, code: 'compaction_unavailable' });
      }
      return {
        ...params,
        agent: {
          ...params.agent,
          tools: [],
          tool_resources: {},
          skills: [],
          edges: [],
          subagents: undefined,
        },
        loadTools: undefined,
        requestFiles: [],
        accessibleSkillIds: [],
        manualSkills: [],
        skillAuthoringAvailable: false,
        codeEnvAvailable: false,
        fileSearchAvailable: false,
        backgroundToolsAvailable: false,
        toolIntentsAvailable: false,
        statefulSessionsAvailable: false,
        memoryAvailable: false,
      };
    },
    runOptions: mode ? { summarizeOnly: true, summarizeFullWindow: true } : {},
    handlers: <T extends Record<string, unknown>>(handlers: T) =>
      mode
        ? {
            ...handlers,
            on_summarize_complete: {
              handle: (_event: string, data: unknown) => {
                const parsed = summaryEvent.safeParse(data);
                mode.summary =
                  parsed.success && !(data && typeof data === 'object' && 'error' in data)
                    ? parsed.data.summary.content
                        .map((part) => part.text)
                        .join('\n')
                        .trim()
                    : undefined;
              },
            },
          }
        : handlers,
  };
}

export function createResponseCompaction(deps: {
  create: RequestHandler;
  getKey: () => string;
  onError?: (
    metadata: ReturnType<typeof getSafeErrorMetadata> & { stage: 'key' | 'execution' },
  ) => void;
  now?: () => number;
}): { expand: RequestHandler; create: RequestHandler } {
  const now = deps.now ?? Date.now;
  const cipher = () => createPrivateTextCipher(deps.getKey(), 'librechat-responses-compaction-v1');
  const binding = (req: Request) => {
    const identity = owner(req);
    return [
      'responses-compaction-v1',
      identity.userId,
      identity.tenantId,
      String(req.body.model ?? ''),
    ];
  };
  const expand: RequestHandler = async (req, res, next) => {
    const body = req.body;
    if (
      !body ||
      !Array.isArray(body.input) ||
      !body.input.some(
        (item: unknown) =>
          item && typeof item === 'object' && 'type' in item && item.type === 'compaction',
      )
    )
      return next();
    if (body.previous_response_id != null)
      return void sendResponsesErrorResponse(
        res,
        400,
        'Start a new response chain with compacted input.',
        'invalid_request',
        'invalid_compaction',
      );
    const config = options(req);
    const input: unknown[] = [];
    let encryption: PrivateTextCipher | undefined;
    try {
      for (const item of body.input) {
        if (!item || typeof item !== 'object' || item.type !== 'compaction') {
          input.push(item);
          continue;
        }
        if (!config.enabled) throw new Error('disabled');
        if (!encryption) {
          try {
            encryption = cipher();
          } catch (error) {
            deps.onError?.({ stage: 'key', ...getSafeErrorMetadata(error) });
            return void sendResponsesErrorResponse(
              res,
              503,
              'Compaction is unavailable.',
              'server_error',
              'compaction_unavailable',
            );
          }
        }
        const parsed = compactItem.parse(item);
        if (Buffer.byteLength(parsed.encrypted_content) > config.maxItemBytes)
          throw new Error('size');
        const restored = payload.parse(
          JSON.parse(encryption.open(parsed.encrypted_content, binding(req))),
        );
        const identity = owner(req);
        if (
          !identity.userId ||
          restored.userId !== identity.userId ||
          restored.tenantId !== identity.tenantId ||
          restored.model !== body.model ||
          restored.createdAt > now() + config.maxClockSkewMs ||
          now() - restored.createdAt > config.maxAgeMs
        )
          throw new Error('scope');
        // A summary remains lower-trust conversation data, never an instruction or authority grant.
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: restored.summary }],
        });
        if (Buffer.byteLength(JSON.stringify(input)) > config.maxInputBytes)
          throw new Error('size');
      }
    } catch {
      return void sendResponsesErrorResponse(
        res,
        400,
        'Compaction item is invalid or unavailable.',
        'invalid_request',
        'invalid_compaction',
      );
    }
    if (Buffer.byteLength(JSON.stringify(input)) > config.maxInputBytes)
      return void sendResponsesErrorResponse(
        res,
        413,
        'Compacted input exceeds the configured limit.',
        'invalid_request',
        'request_too_large',
      );
    req.body = { ...body, input };
    next();
  };
  const create: RequestHandler = async (req, res, next) => {
    const config = options(req);
    if (!config.enabled)
      return void sendResponsesErrorResponse(
        res,
        404,
        'Compaction is disabled.',
        'not_found',
        'compaction_unavailable',
      );
    if ((req as ServerRequest).config?.summarization?.enabled === false)
      return void sendResponsesErrorResponse(
        res,
        409,
        'Summarization is disabled.',
        'invalid_request',
        'compaction_unavailable',
      );
    if (
      !req.body ||
      typeof req.body.model !== 'string' ||
      !req.body.model ||
      !(typeof req.body.input === 'string'
        ? req.body.input.trim().length > 0
        : Array.isArray(req.body.input) && req.body.input.length > 0) ||
      req.body.previous_response_id != null ||
      req.body.stream ||
      req.body.background ||
      Buffer.byteLength(JSON.stringify(req.body)) > config.maxInputBytes
    )
      return void sendResponsesErrorResponse(
        res,
        400,
        'Compaction requires a model and an explicit input window.',
        'invalid_request',
      );
    let encryption: PrivateTextCipher;
    try {
      encryption = cipher();
    } catch (error) {
      deps.onError?.({ stage: 'key', ...getSafeErrorMetadata(error) });
      return void sendResponsesErrorResponse(
        res,
        503,
        'Compaction is unavailable.',
        'server_error',
        'compaction_unavailable',
      );
    }
    const replayToolNames = historyToolNames(req.body.input);
    if (
      Array.isArray(req.body.input) &&
      validateInputToolExchanges(req.body.input, replayToolNames) !== undefined
    )
      return void sendResponsesErrorResponse(
        res,
        400,
        'Finish all function-call exchanges before compaction.',
        'invalid_request',
        'invalid_compaction',
      );
    const mode: { summary?: string; replayToolNames: ReadonlySet<string> } = { replayToolNames };
    modes.set(req, mode);
    const { model, input, instructions, prompt_cache_key } = req.body;
    req.body = {
      model,
      input,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(prompt_cache_key !== undefined ? { prompt_cache_key } : {}),
      stream: false,
      background: false,
      store: false,
    };
    let captured: unknown;
    const json = res.json.bind(res);
    res.json = (body?: unknown) => {
      captured = body;
      return res;
    };
    try {
      await deps.create(req, res, next);
      res.json = json;
      if (res.writableEnded || res.destroyed) return;
      const response = completedResponse.safeParse(captured);
      if (res.statusCode >= 400) {
        if (captured !== undefined) return void json(captured);
        return void sendResponsesErrorResponse(
          res,
          503,
          'Compaction could not complete.',
          'server_error',
          'compaction_failed',
        );
      }
      if (!response.success || !mode.summary)
        return void sendResponsesErrorResponse(
          res,
          503,
          'Compaction produced no usable summary.',
          'server_error',
          'compaction_failed',
        );
      const ciphertext = encryption.seal(
        JSON.stringify({
          kind: 'librechat.responses.compaction.v1',
          ...owner(req),
          model: req.body.model,
          createdAt: now(),
          summary: mode.summary,
        }),
        binding(req),
      );
      if (Buffer.byteLength(ciphertext) > config.maxItemBytes)
        return void sendResponsesErrorResponse(
          res,
          413,
          'Compacted context exceeds the configured limit.',
          'invalid_request',
          'compaction_too_large',
        );
      if (res.writableEnded || res.destroyed) return;
      json({
        id: `cmp_${randomUUID()}`,
        object: 'response.compaction',
        created_at: Math.floor(now() / 1000),
        output: [{ id: `cmp_${randomUUID()}`, type: 'compaction', encrypted_content: ciphertext }],
        usage: response.data.usage,
      });
    } catch (error) {
      deps.onError?.({ stage: 'execution', ...getSafeErrorMetadata(error) });
      res.json = json;
      if (!res.headersSent)
        sendResponsesErrorResponse(
          res,
          503,
          'Compaction is unavailable. Please try again.',
          'server_error',
          'compaction_failed',
        );
      else res.destroy();
    } finally {
      modes.delete(req);
      res.json = json;
    }
  };
  return { expand, create };
}
