import { AIMessageChunk } from '@librechat/agents/langchain/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  DEFAULT_PII_REDACTION_MAX_CHARACTERS,
  ErrorTypes,
  assistantTextProtectionSchema,
} from 'librechat-data-provider';
import {
  Providers,
  initializeModel,
  ProviderTextProtectionError,
  PROVIDER_TEXT_PROTECTION_VERSION,
} from '@librechat/agents';
import type {
  OpenAIClientOptions,
  AgentInputs,
  ProviderTextProtection,
  ProviderTextProtectionResult,
} from '@librechat/agents';
import type { AIMessage, BaseMessage } from '@librechat/agents/langchain/messages';
import type { TCustomConfig } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import { createPatternContentInspector } from './detectors/pattern';

export type AssistantConfig = {
  readonly config?: Pick<TCustomConfig, 'outputProtection'>;
};

type Policy = NonNullable<NonNullable<TCustomConfig['outputProtection']>['assistantText']>;
interface AssistantProtection extends ProviderTextProtection {
  readonly inspect: (
    input: Parameters<ProviderTextProtection['inspect']>[0],
  ) => ProviderTextProtectionResult;
}

const compiled = new WeakMap<Policy, AssistantProtection>();
const admitted = new WeakSet<object>();
const historyKeys = new Set(['provenance', 'sourceMessageId', 'sourceMessageIds']);
const supportedModel = /^gpt-4(?:o(?:-mini)?|\.1(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/;
const sqlVerb = /^(?:SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i;
const sqlClause = /\b(?:FROM|AS|INTO|SET|TABLE)\b/i;

export function requiresAssistantProtection(appConfig?: AssistantConfig | null): boolean {
  return appConfig?.config?.outputProtection !== undefined;
}

/** Auxiliary producers do not share the reply's release boundary. */
export function allowsAssistantSideEffects(
  config?: AssistantConfig | null,
  enabled?: boolean,
): boolean {
  return enabled !== false && !requiresAssistantProtection(config);
}

export function runAssistantSideEffect<T>(
  config: AssistantConfig | null | undefined,
  run: () => T,
): T | undefined {
  return allowsAssistantSideEffects(config) ? run() : undefined;
}

export function isInteractiveAssistantRequest(req: object): boolean {
  return admitted.has(req);
}

export const admitAssistantRequest: RequestHandler = (req, res, next) => {
  const request = req as typeof req & {
    config?: AssistantConfig;
    _isAgentTrigger?: boolean;
    _isScheduledFire?: boolean;
  };
  if (!requiresAssistantProtection(request.config)) {
    return next();
  }
  const body = req.body;
  if (
    req.method !== 'POST' ||
    /^\/resume\/?$/i.test(req.path) ||
    request._isAgentTrigger ||
    request._isScheduledFire ||
    typeof body?.text !== 'string' ||
    body.compact ||
    body.isRegenerate ||
    body.isContinued ||
    body.editedContent != null ||
    body.files?.length ||
    body.quotes?.length ||
    body.responseMessageId != null
  ) {
    res.status(400).json({
      code: ErrorTypes.ASSISTANT_OUTPUT_UNSUPPORTED,
      error: 'content_filter_block',
      message: 'Start a regular text-only Agent turn to use assistant reply protection.',
    });
    return;
  }
  admitted.add(req);
  next();
};

export const rejectLegacyAssistantOutput: RequestHandler = (req, res, next) => {
  if (!requiresAssistantProtection((req as typeof req & { config?: AssistantConfig }).config)) {
    return next();
  }
  res.status(400).json({
    code: ErrorTypes.ASSISTANT_OUTPUT_UNSUPPORTED,
    error: 'content_filter_block',
    message: 'Assistant reply protection is not supported on this endpoint.',
  });
};

export function isAssistantProtectionError(error: unknown): boolean {
  return error instanceof ProviderTextProtectionError;
}

function classify(content: string): 'prose' | 'unsupported' {
  const text = content.trimStart();
  return text.startsWith('{') ||
    text.startsWith('[') ||
    text.includes('`') ||
    /<\/?think>/i.test(text) ||
    (sqlVerb.test(text) && sqlClause.test(text))
    ? 'unsupported'
    : 'prose';
}

export function createAssistantProtection(config: Policy): AssistantProtection {
  if (PROVIDER_TEXT_PROTECTION_VERSION !== 1) {
    throw new ProviderTextProtectionError('incompatible');
  }
  const previous = compiled.get(config);
  if (previous != null) {
    return previous;
  }
  const parsed = assistantTextProtectionSchema.safeParse(config);
  if (!parsed.success) {
    throw new ProviderTextProtectionError('incompatible');
  }
  const { timeoutMs, maxCharacters = DEFAULT_PII_REDACTION_MAX_CHARACTERS } = parsed.data;
  let detector: ReturnType<typeof createPatternContentInspector>;
  try {
    detector = createPatternContentInspector(parsed.data, { linearTime: true });
  } catch {
    throw new ProviderTextProtectionError('unavailable');
  }
  const maxAttemptBytes = maxCharacters * 16 + 65_536;
  const protection: AssistantProtection = {
    version: 1,
    timeoutMs,
    maxAttemptBytes,
    // A shared allowance for concurrent attempts using this deployment policy snapshot.
    maxBufferedBytes: Math.max(8_388_608, maxAttemptBytes),
    classify,
    inspect({ content, target, signal }) {
      if (signal.aborted) return { version: 1, ok: false, error: { code: 'cancelled' } };
      if (content.length > maxCharacters) {
        return { version: 1, ok: false, error: { code: 'overflow' } };
      }
      const finding = detector.inspectFragment({
        ...target,
        id: 'assistant.text',
        path: '/text',
        format: 'plain',
        treatment: 'inspect_only',
        text: content,
      });
      if (finding != null) return { version: 1, ok: false, error: { code: 'blocked' } };
      return { version: 1, ok: true, value: { content, replacements: 0, categories: [] } };
    },
  };
  compiled.set(config, protection);
  return protection;
}

/** The pilot never opens another output producer alongside the protected model. */
export function createAssistantModel(
  agents: readonly AgentInputs[],
  multiAgent: boolean,
): BaseChatModel {
  const agent = agents[0];
  const options = agent?.clientOptions;
  if (
    agents.length !== 1 ||
    multiAgent ||
    agent.provider !== Providers.OPENAI ||
    options == null ||
    !supportedModel.test(options.model ?? '') ||
    options.streaming === false ||
    ('useResponsesApi' in options && options.useResponsesApi === true) ||
    ('fallbacks' in options && Array.isArray(options.fallbacks) && options.fallbacks.length > 0) ||
    agent.tools?.length ||
    agent.graphTools?.length ||
    agent.toolDefinitions?.length ||
    agent.toolRegistry?.size ||
    agent.subagentConfigs?.length
  ) {
    throw new ProviderTextProtectionError('unsupported');
  }
  const model = initializeModel({
    provider: Providers.OPENAI,
    clientOptions: options as OpenAIClientOptions,
  });
  if (!(model instanceof BaseChatModel)) {
    throw new ProviderTextProtectionError('incompatible');
  }
  // The SDK's prose gate intentionally passes provider controls through. This chat profile
  // admits only text, so check the native iterator before those controls reach graph state.
  const stream = model._streamResponseChunks;
  model._streamResponseChunks = async function* (messages, options) {
    for await (const chunk of stream.call(this, messages, options)) {
      const message = chunk.message;
      if (
        !AIMessageChunk.isInstance(message) ||
        typeof message.content !== 'string' ||
        message.tool_calls?.length ||
        message.tool_call_chunks?.length ||
        message.invalid_tool_calls?.length ||
        message.additional_kwargs.reasoning != null ||
        message.additional_kwargs.reasoning_content != null ||
        message.additional_kwargs.reasoning_details != null ||
        message.additional_kwargs.thinking != null ||
        message.additional_kwargs.signature != null ||
        message.additional_kwargs.function_call != null ||
        message.additional_kwargs.tool_calls?.length
      ) {
        throw new ProviderTextProtectionError('unsupported');
      }
      yield chunk;
    }
  };
  model._generate = async () => {
    throw new ProviderTextProtectionError('unsupported');
  };
  return model;
}

/** Old assistant text is not trusted merely because the host loaded it. */
export function inspectAssistantHistory(
  protection: AssistantProtection,
  messages: readonly BaseMessage[],
  signal: AbortSignal,
): void {
  let remaining = protection.maxAttemptBytes;
  const deadline = performance.now() + protection.timeoutMs;
  for (const message of messages) {
    const type = message._getType();
    if (type !== 'ai' && type !== 'human') throw new ProviderTextProtectionError('unsupported');
    const assistant = type === 'ai' ? (message as AIMessage) : undefined;
    if (
      assistant != null &&
      (assistant.tool_calls?.length ||
        assistant.invalid_tool_calls?.length ||
        Object.keys(assistant.additional_kwargs).some((key) => !historyKeys.has(key)))
    ) {
      throw new ProviderTextProtectionError('unsupported');
    }

    let content = '';
    if (typeof message.content === 'string') {
      if (assistant == null) continue;
      content = message.content;
      remaining -= content.length * 4;
      if (remaining < 0) throw new ProviderTextProtectionError('overflow');
    } else {
      let parts: string[] | undefined;
      for (const part of message.content) {
        if (
          typeof part === 'string' ||
          part.type !== 'text' ||
          typeof part.text !== 'string' ||
          Object.keys(part).some((key) => key !== 'type' && key !== 'text')
        ) {
          throw new ProviderTextProtectionError('unsupported');
        }
        if (assistant == null || part.text === '') continue;
        remaining -= part.text.length * 4;
        if (remaining < 0) throw new ProviderTextProtectionError('overflow');
        if (content === '') content = part.text;
        else (parts ??= [content]).push(part.text);
      }
      if (parts != null) content = parts.join('');
    }
    if (content === '') continue;
    if (signal.aborted) throw new ProviderTextProtectionError('cancelled');
    if (performance.now() >= deadline) throw new ProviderTextProtectionError('timeout');
    if (protection.classify(content) !== 'prose')
      throw new ProviderTextProtectionError('unsupported');
    const result = protection.inspect({
      version: 1,
      content,
      target: { source: 'message', field: 'text', provenance: 'model' },
      signal,
    });
    if (!result.ok) throw new ProviderTextProtectionError(result.error.code);
    if (result.value.content !== content) throw new ProviderTextProtectionError('blocked');
    if (performance.now() >= deadline) throw new ProviderTextProtectionError('timeout');
  }
}
