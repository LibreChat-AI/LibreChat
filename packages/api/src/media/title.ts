import { HumanMessage } from '@langchain/core/messages';
import { initializeModel, Providers } from '@librechat/agents';
import { deriveMediaThreadTitle } from '@librechat/data-schemas';
import { Constants, TOKEN_CREDITS_PER_USD } from 'librechat-data-provider';
import type {
  AppConfig,
  MediaMethods,
  MediaOwnerScope,
  MediaTitleMethods,
} from '@librechat/data-schemas';
import type { MediaOperation, TEndpoint } from 'librechat-data-provider';
import type { Callbacks } from '@langchain/core/callbacks/manager';
import type { ClientOptions } from '@librechat/agents';
import type { BalanceCreditReservationDeps, BalanceReservation } from '~/middleware/checkBalance';
import type { UsageMetadata } from '~/stream/interfaces/IJobStore';
import type { EndpointTokenConfig } from '~/types/tokens';
import type { RecordUsageDeps } from '~/agents/usage';
import type { MediaModelTracer } from './tracing';
import type { EndpointDbMethods } from '~/types';
import type { MediaContext } from './context';
import { getBalanceConfig, getCustomEndpointConfig, getTransactionsConfig } from '~/app/config';
import { DEFAULT_TITLE_FALLBACK, sanitizeTitle } from '~/utils/sanitizeTitle';
import { recordCollectedUsage, computeUsageCostUSD } from '~/agents/usage';
import { reserveBalanceCredits } from '~/middleware/checkBalance';
import { getProviderConfig } from '~/endpoints/config/providers';
import { resolveConversationTitle } from '~/protection/title';
import { createCachedTokenCounter } from '~/agents/client';
import { resolveTitleModelConfig } from '~/agents/title';
import { resolveConfigHeaders } from '~/utils/headers';
import { createSafeUser } from '~/utils/env';

export interface MediaTitleTarget {
  endpoint: string;
  model: string;
  prompt?: string;
  timeoutMs: number;
}

type EndpointBlocks = Record<string, Partial<TEndpoint> | undefined>;

const unsetCurrentModel = (model?: string): string | undefined =>
  model === Constants.CURRENT_MODEL ? undefined : model;

function endpointTitleModel(appConfig: AppConfig, endpoint: string): string | undefined {
  const blocks = appConfig.endpoints as EndpointBlocks | undefined;
  const named = unsetCurrentModel(blocks?.[endpoint]?.titleModel);
  if (named) {
    return named;
  }
  try {
    return unsetCurrentModel(getCustomEndpointConfig({ endpoint, appConfig })?.titleModel);
  } catch {
    return undefined;
  }
}

/**
 * Resolves the text model that names new Studio threads. The endpoint comes from
 * `media.titles.endpoint`, then `endpoints.all.titleEndpoint`; the model from `media.titles.model`,
 * `endpoints.all.titleModel`, then the resolved endpoint's own `titleModel`, treating
 * `current_model` as unset because Studio has no running chat model to fall back to.
 */
export function resolveMediaTitleTarget(
  context: Pick<MediaContext, 'config' | 'appConfig'>,
): MediaTitleTarget | undefined {
  const { titles } = context.config;
  if (!titles.enabled) {
    return undefined;
  }
  const all = context.appConfig.endpoints?.all;
  const endpoint = titles.endpoint ?? all?.titleEndpoint;
  if (!endpoint) {
    return undefined;
  }
  const model =
    unsetCurrentModel(titles.model) ??
    unsetCurrentModel(all?.titleModel) ??
    endpointTitleModel(context.appConfig, endpoint);
  if (!model) {
    return undefined;
  }
  return { endpoint, model, prompt: titles.prompt, timeoutMs: titles.timeoutMs };
}

const PROMPT_PLACEHOLDER = '{prompt}';
const titleSubjects: Record<MediaOperation, string> = {
  'image.generate': 'an image generation request',
  'image.edit': 'an image editing request',
  'video.generate': 'a video generation request',
};

export function buildMediaTitlePrompt(input: {
  prompt: string;
  operation: MediaOperation;
  template?: string;
}): string {
  if (input.template) {
    return input.template.includes(PROMPT_PLACEHOLDER)
      ? input.template.split(PROMPT_PLACEHOLDER).join(input.prompt)
      : `${input.template}\n\n${input.prompt}`;
  }
  return [
    `Write a concise title of 5 words or less for ${titleSubjects[input.operation]}.`,
    'Use title case. Do not use quotes or punctuation. Respond with the title as plain text only, no markdown or bullets.',
    '',
    input.prompt,
  ].join('\n');
}

export interface MediaTitleModel {
  provider: string;
  clientOptions: ClientOptions;
  endpointTokenConfig?: EndpointTokenConfig;
}

export type MediaTitleModelResolver = (input: {
  context: MediaContext;
  target: MediaTitleTarget;
}) => Promise<MediaTitleModel | undefined>;

export function createMediaTitleModelResolver({
  db,
}: {
  db: EndpointDbMethods;
}): MediaTitleModelResolver {
  return async ({ context, target }) => {
    const { user, appConfig } = context;
    if (!user) {
      return undefined;
    }
    const providerConfig = getProviderConfig({ provider: target.endpoint, appConfig });
    const options = await providerConfig.getOptions({
      runtime: { appConfig, user, requestBody: {} },
      endpoint: target.endpoint,
      model_parameters: { model: target.model },
      db,
    });
    const { provider, clientOptions } = resolveTitleModelConfig({
      endpoint: target.endpoint,
      options,
      fallbackProvider: providerConfig.overrideProvider,
    });
    resolveConfigHeaders({
      llmConfig: clientOptions,
      user: createSafeUser(user),
      tenantId: context.scope.tenantId ?? undefined,
      body: {},
    });
    return {
      provider,
      clientOptions,
      endpointTokenConfig: options.endpointTokenConfig,
    };
  };
}

export type MediaTitleUsage = UsageMetadata;

export interface MediaTitleInvocation {
  text: string;
  usage?: MediaTitleUsage;
}

export type MediaTitleInvoker = (
  model: MediaTitleModel,
  prompt: string,
  signal: AbortSignal,
  callbacks?: Callbacks,
) => Promise<MediaTitleInvocation>;

type TitleContentBlock = string | { type?: string; text?: string };
interface TitleResponse {
  content?: string | TitleContentBlock[];
  usage_metadata?: MediaTitleUsage;
}

function extractText(content: TitleResponse['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((block) => (typeof block === 'string' ? block : (block.text ?? ''))).join('');
}

const invokeTitleModel: MediaTitleInvoker = async (model, prompt, signal, callbacks) => {
  const response: TitleResponse = await initializeModel({
    provider: model.provider as Providers,
    clientOptions: { ...model.clientOptions, streaming: false } as ClientOptions,
  }).invoke(prompt, { signal, callbacks });
  return { text: extractText(response.content), usage: response.usage_metadata };
};

const quotePairs: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['«', '»'],
];

function stripWrappingQuotes(title: string): string {
  const wrapped = quotePairs.some(
    ([open, close]) => title.length > 1 && title.startsWith(open) && title.endsWith(close),
  );
  return wrapped ? title.slice(1, -1).trim() : title;
}

function cleanMediaTitle(
  raw: string,
  appConfig: AppConfig,
  maxTitleChars: number,
): string | undefined {
  const firstLine = raw
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
    .split(/\r?\n/)
    .find((line) => line.trim());
  if (!firstLine) {
    return undefined;
  }
  const sanitized = sanitizeTitle(firstLine);
  if (sanitized === DEFAULT_TITLE_FALLBACK) {
    return undefined;
  }
  const plain = sanitized
    .replace(/^(?:(?:[*+-]|\d+[.)]|#{1,6})\s+)+/, '')
    .replace(/^[*_`]+|[*_`]+$/g, '')
    .trim();
  const candidate = stripWrappingQuotes(plain).replace(/\.$/, '').trim();
  const allowed = resolveConversationTitle({
    filters: appConfig.filters,
    candidate,
    fallback: null,
  });
  if (!allowed) {
    return undefined;
  }
  return deriveMediaThreadTitle(allowed, maxTitleChars).trimEnd() || undefined;
}

export interface MediaTitleRequest {
  context: MediaContext;
  jobId: string;
  threadId: string;
  prompt: string;
  operation: MediaOperation;
  currentTitle: string;
  signal: AbortSignal;
}

export type MediaTitleGenerator = (input: MediaTitleRequest) => Promise<string | undefined>;

export interface MediaTitleGeneratorDependencies {
  modelTracer?: MediaModelTracer;
  repository: Pick<MediaMethods, 'replaceMediaThreadTitle'> & MediaTitleMethods;
  resolveModel: MediaTitleModelResolver;
  usage?: RecordUsageDeps;
  admission?: Omit<BalanceCreditReservationDeps, 'balanceConfig'>;
  /** Defaults to a real model call; tests substitute a fake to exercise the surrounding logic. */
  invoke?: MediaTitleInvoker;
  withScope<T>(scope: MediaOwnerScope, operation: () => Promise<T>): Promise<T>;
  log(message: string, error?: Error): void;
}

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * Names a freshly created Studio thread with a text model. Best effort by design: every failure is
 * logged and swallowed, and the write is conditional on the prompt-derived title still being in
 * place so a user rename in the meantime always wins.
 */
export function createMediaTitleGenerator(
  deps: MediaTitleGeneratorDependencies,
): MediaTitleGenerator {
  const invoke = deps.invoke ?? invokeTitleModel;

  async function recordUsage(
    input: MediaTitleRequest,
    target: MediaTitleTarget,
    model: MediaTitleModel,
    usage: MediaTitleUsage | undefined,
  ): Promise<void> {
    const source = deps.usage;
    if (!source || !usage) {
      return;
    }
    const { appConfig, scope } = input.context;
    const pending: Promise<unknown>[] = [];
    const usageDeps: RecordUsageDeps = {
      ...source,
      spendTokens: (...args) => {
        const write = source.spendTokens(...args);
        pending.push(write);
        return write;
      },
      spendStructuredTokens: (...args) => {
        const write = source.spendStructuredTokens(...args);
        pending.push(write);
        return write;
      },
    };
    try {
      await recordCollectedUsage(usageDeps, {
        user: scope.ownerId,
        conversationId: input.threadId,
        context: 'title',
        model: target.model,
        endpointTokenConfig: model.endpointTokenConfig,
        collectedUsage: [
          {
            ...usage,
            provider: usage.provider ?? model.provider,
            model: usage.model ?? target.model,
          },
        ],
        balance: getBalanceConfig(appConfig),
        transactions: getTransactionsConfig(appConfig),
      });
      await Promise.all(pending);
    } catch (error) {
      deps.log('[media] Title generation failed.', toError(error));
    }
  }

  return async (input) => {
    let reservation: BalanceReservation | undefined;
    try {
      input.signal.throwIfAborted();
      const target = resolveMediaTitleTarget(input.context);
      if (!target) {
        return undefined;
      }
      const model = await deps.resolveModel({ context: input.context, target });
      input.signal.throwIfAborted();
      if (!model) {
        return undefined;
      }
      const { scope, appConfig, config } = input.context;
      const prompt = buildMediaTitlePrompt({
        prompt: input.prompt,
        operation: input.operation,
        template: target.prompt,
      });
      const balanceConfig = getBalanceConfig(appConfig);
      if (balanceConfig?.enabled) {
        const admission = deps.admission;
        if (!admission || !deps.usage?.pricing) return undefined;
        const countTokens = await createCachedTokenCounter(
          model.provider === Providers.ANTHROPIC ? 'claude' : 'o200k_base',
        );
        const amount =
          computeUsageCostUSD(
            {
              model: target.model,
              provider: model.provider,
              input_tokens: countTokens(new HumanMessage(prompt)),
              output_tokens: config.titles.maxOutputTokens,
            },
            deps.usage.pricing,
            model.endpointTokenConfig,
          ) * TOKEN_CREDITS_PER_USD;
        const admitted = await deps.withScope(scope, () =>
          reserveBalanceCredits({ user: scope.ownerId, amount }, { ...admission, balanceConfig }),
        );
        reservation = admitted.reservation;
        if (!reservation) return undefined;
      }
      input.signal.throwIfAborted();
      const claimed = await deps.withScope(scope, () =>
        deps.repository.claimMediaThreadTitle({
          scope,
          jobId: input.jobId,
          threadId: input.threadId,
          expectedTitle: input.currentTitle,
        }),
      );
      if (!claimed) return undefined;
      const signal = AbortSignal.any([input.signal, AbortSignal.timeout(target.timeoutMs)]);
      signal.throwIfAborted();
      const invokeModel = (callbacks?: Callbacks) => invoke(model, prompt, signal, callbacks);
      const result = deps.modelTracer
        ? await deps.modelTracer.run(
            {
              context: input.context,
              jobId: input.jobId,
              threadId: input.threadId,
              kind: 'title',
              model: target.model,
              provider: model.provider,
            },
            invokeModel,
            (result) => result.usage,
          )
        : await invokeModel();
      await recordUsage(input, target, model, result.usage);
      signal.throwIfAborted();
      const title = cleanMediaTitle(result.text, appConfig, config.limits.maxTitleChars);
      const applied =
        title !== undefined && title !== input.currentTitle
          ? await deps.withScope(scope, () =>
              deps.repository.replaceMediaThreadTitle({
                scope,
                threadId: input.threadId,
                expectedTitle: input.currentTitle,
                title,
              }),
            )
          : false;
      return applied ? title : undefined;
    } catch (error) {
      deps.log('[media] Title generation failed.', toError(error));
      return undefined;
    } finally {
      if (reservation) {
        const held = reservation;
        await deps.withScope(input.context.scope, () => held.release());
      }
    }
  };
}
