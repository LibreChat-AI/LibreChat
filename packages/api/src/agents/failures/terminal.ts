import { redactMessage } from '@librechat/data-schemas';
import {
  ErrorTypes,
  ViolationTypes,
  stripLangChainTroubleshootingUrl,
} from 'librechat-data-provider';
import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { AssistantConfig } from '../../protection/assistant';
import type { SafeErrorMetadata } from '../../utils/errors';
import type { ModelErrorTrackerCallback } from './tracker';
import type { LangChainErrorOptions } from '../errors';
import {
  resolveLangChainError,
  getModelStreamFailure,
  resolveModelStreamError,
  getProviderErrorMessage,
} from '../errors';
import {
  requiresAssistantProtection,
  isAssistantProtectionError,
} from '../../protection/assistant';
import { getSafeErrorText, getSafeErrorMetadata, isOwnedAbortError } from '../../utils/errors';
import { hasModelBoundContentProtection } from '../../middleware/modelBoundContent';
import { getContentFilterError } from '../../middleware/contentFilter';
import { traceIdForMessage } from '../../langfuse/trace';
import { createModelErrorTracker } from './tracker';

const UPSTREAM_MODEL_ERROR_CODE = 'UPSTREAM_MODEL_ERROR';
const UPSTREAM_MODEL_ERROR_ORIGIN = 'model_provider';
const UNKNOWN_UPSTREAM_MODEL_ERROR_TYPE = '_OTHER';
const UPSTREAM_MODEL_ERROR_FALLBACK = 'The model provider could not complete this request.';

export function getAssistantProtectionFailure(error: unknown): string | undefined {
  if (isAssistantProtectionError(error)) {
    return JSON.stringify({ type: ErrorTypes.ASSISTANT_OUTPUT_WITHHELD });
  }
}

function safelyResolveLangChainError(
  error: unknown,
  options: LangChainErrorOptions,
): string | undefined {
  try {
    return resolveLangChainError(error, options);
  } catch {
    return undefined;
  }
}

export interface UpstreamModelErrorMetadata extends SafeErrorMetadata {
  readonly errorCode: typeof UPSTREAM_MODEL_ERROR_CODE;
  readonly errorOrigin: typeof UPSTREAM_MODEL_ERROR_ORIGIN;
  readonly errorType: string;
  readonly traceId?: string;
}

export interface TerminalRunErrorLogger {
  error(message: string, metadata: SafeErrorMetadata | UpstreamModelErrorMetadata): void;
}

export interface TerminalRunErrorObserver {
  readonly modelCallback: ModelErrorTrackerCallback;
  readonly log: (error: unknown, signal?: AbortSignal) => void;
  readonly getUserFacingError: (error: unknown, fallback: () => string) => string;
}

/** A run cancellation requires host-owned abort state plus its own reason or an abort shape. */
export function isAgentRunCancellation(error: unknown, signal?: AbortSignal): boolean {
  return isOwnedAbortError(error, signal);
}

/** Preserve rejection status; a successful status can still precede a broken response body. */
function getUpstreamErrorType(error: unknown, status?: number): string {
  if (status != null && status >= 400) {
    return String(status);
  }
  const streamFailure = getModelStreamFailure(error);
  if (streamFailure != null) {
    return `stream_${streamFailure}`;
  }
  return status == null ? UNKNOWN_UPSTREAM_MODEL_ERROR_TYPE : String(status);
}

export function getUpstreamModelErrorMetadata(
  error: unknown,
  responseMessageId?: string,
): UpstreamModelErrorMetadata {
  const safeMetadata = getSafeErrorMetadata(error);
  return {
    ...safeMetadata,
    errorCode: UPSTREAM_MODEL_ERROR_CODE,
    errorOrigin: UPSTREAM_MODEL_ERROR_ORIGIN,
    errorType: getUpstreamErrorType(error, safeMetadata.status),
    ...(typeof responseMessageId === 'string' && responseMessageId !== ''
      ? { traceId: traceIdForMessage(responseMessageId) }
      : {}),
  };
}

/** Applies one terminal-run log taxonomy to every agent ingress. */
export function createTerminalRunErrorObserver({
  logger,
  responseMessageId,
  source,
  protectionEnabled,
  maxProviderErrorChars,
  genericMessage = `${source} Error:`,
}: {
  logger: TerminalRunErrorLogger;
  responseMessageId?: string;
  source: string;
  /**
   * Whether a content policy inspects this deployment's traffic. A provider error body may echo
   * submitted content, so its text stays out of the failure a reader sees while one is active —
   * the same condition every other user-facing failure text is decided by. Omission fails closed
   * for JavaScript callers and older integrations.
   */
  protectionEnabled?: boolean;
  maxProviderErrorChars?: number;
  genericMessage?: string;
}): TerminalRunErrorObserver {
  const modelErrorTracker = createModelErrorTracker();
  return Object.freeze({
    modelCallback: modelErrorTracker.callback,
    getUserFacingError(error: unknown, fallback: () => string) {
      const upstreamModelError = modelErrorTracker.getUpstreamModelError(error);
      const withheld =
        getAssistantProtectionFailure(error) ?? getAssistantProtectionFailure(upstreamModelError);
      if (withheld != null) return withheld;
      if (upstreamModelError == null) {
        return fallback();
      }

      const { status } = getSafeErrorMetadata(upstreamModelError);
      const langChainOptions: LangChainErrorOptions = {
        includeProviderMessage: protectionEnabled === false,
        maxProviderErrorChars,
      };
      const classifiedError =
        safelyResolveLangChainError(error, langChainOptions) ??
        safelyResolveLangChainError(upstreamModelError, langChainOptions) ??
        (status == null || status < 400
          ? (resolveModelStreamError(upstreamModelError) ?? resolveModelStreamError(error))
          : undefined);
      if (classifiedError != null) {
        return classifiedError;
      }

      /** Unclassified: the provider's own explanation is the only account of what happened, and a
       *  rejection from a gateway or proxy carries it as the whole point of the 400. The status
       *  headlines it either way, so a deployment withholding provider text loses no taxonomy. */
      const providerMessage =
        protectionEnabled !== false
          ? undefined
          : (getProviderErrorMessage(upstreamModelError, maxProviderErrorChars) ??
            getProviderErrorMessage(error, maxProviderErrorChars));
      return `${UPSTREAM_MODEL_ERROR_FALLBACK}\n${JSON.stringify({
        type: ErrorTypes.UPSTREAM_MODEL_ERROR,
        ...(status != null ? { status } : {}),
        ...(providerMessage != null ? { message: providerMessage } : {}),
      })}`;
    },
    log(error: unknown, signal?: AbortSignal) {
      if (isAgentRunCancellation(error, signal)) {
        return;
      }

      const upstreamModelError = modelErrorTracker.getUpstreamModelError(error);
      if (
        upstreamModelError == null ||
        isAssistantProtectionError(error) ||
        isAssistantProtectionError(upstreamModelError)
      ) {
        logger.error(genericMessage, getSafeErrorMetadata(error));
        return;
      }

      logger.error(
        `${source} Upstream model error`,
        getUpstreamModelErrorMetadata(upstreamModelError, responseMessageId),
      );
    },
  });
}

const TYPED_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...Object.values(ErrorTypes),
  ...Object.values(ViolationTypes),
]);

type TypedErrorPayload = Record<string, unknown> & { type: string };

/** A host-thrown `{"type": ...}` payload whose type the client maps to localized copy. */
function parseTypedErrorMessage(message: string): TypedErrorPayload | undefined {
  if (!message.trimStart().startsWith('{')) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    const type = (parsed as { type?: unknown }).type;
    return typeof type === 'string' && TYPED_ERROR_CODES.has(type)
      ? (parsed as TypedErrorPayload)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The typed payload as a reader may see it: credentials and emails are always redacted, and while
 * a content policy is active only the code and its numeric and boolean fields (a balance, a limit)
 * remain, since any string field may carry provider or submitted content.
 */
function getSafeTypedErrorText(
  message: string,
  payload: TypedErrorPayload,
  protectionEnabled: boolean,
): string {
  if (!protectionEnabled) {
    return redactMessage(message);
  }
  const safe: Record<string, unknown> = { type: payload.type };
  for (const [key, value] of Object.entries(payload)) {
    if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') {
      safe[key] = value;
    }
  }
  return JSON.stringify(safe);
}

/** The deployment config that decides whether a failure may show its own text. */
export interface GenerationErrorConfig extends AssistantConfig {
  readonly filters?: FiltersConfig | null;
  readonly messageFilter?: { readonly pii?: MessageFilterPiiConfig | null } | null;
  readonly endpoints?: {
    readonly agents?: { readonly maxProviderErrorChars?: number } | null;
  } | null;
}

export function hasGenerationContentProtection(appConfig?: GenerationErrorConfig | null): boolean {
  return (
    requiresAssistantProtection(appConfig) ||
    hasModelBoundContentProtection(appConfig?.filters, appConfig?.messageFilter?.pii)
  );
}

/** User-facing fallback for an Agent chat run that failed outside the provider. */
export function getUserFacingRequestError(
  baseMessage: string,
  error: Error | undefined,
  appConfig?: GenerationErrorConfig | null,
): string {
  if (error?.name === 'ManualSummarizationSkippedError') {
    const { reason } = error as Error & { reason?: string };
    return JSON.stringify({ type: ErrorTypes.COMPACTION_SKIPPED, reason });
  }
  const withheld = getAssistantProtectionFailure(error);
  if (withheld != null) return withheld;
  if (hasGenerationContentProtection(appConfig) || !error?.message) return baseMessage;
  const classified = resolveClassifiedProviderError(error, appConfig);
  if (classified != null) return classified;
  const message = stripLangChainTroubleshootingUrl(error.message);
  return message ? `${baseMessage}: ${message}` : baseMessage;
}

/**
 * The typed payload of a LangChain-classified provider failure, or `undefined` for any other error.
 * The provider's message rides along as `info`, bounded by `endpoints.agents.maxProviderErrorChars`,
 * only while no content policy is active; `formatProviderMessage` applies the caller's redaction.
 */
export function resolveClassifiedProviderError(
  error: unknown,
  appConfig: GenerationErrorConfig | null | undefined,
  formatProviderMessage?: (message: string) => string,
): string | undefined {
  return safelyResolveLangChainError(error, {
    includeProviderMessage: !hasGenerationContentProtection(appConfig),
    maxProviderErrorChars: appConfig?.endpoints?.agents?.maxProviderErrorChars,
    formatProviderMessage,
  });
}

/**
 * The error text a failed generation publishes and persists on its error row, under the same rule
 * the run's content error parts follow. Host-authored outcomes keep their wording: a typed
 * `{"type": ...}` payload (redacted, and reduced to its code and numeric fields under a content policy), a LangChain-classified provider failure (with the provider's redacted message as `info` when no
 * content policy is active), or a content policy block.
 * Any other exception may echo submitted content, so while a content policy is active the turn
 * carries `fallback`; otherwise it carries the message with URLs, credentials (API keys, tokens, auth headers) and email
 * addresses redacted. The exception
 * itself reaches the logs only through `getSafeErrorMetadata`.
 */
export function getUserFacingGenerationError(
  error: unknown,
  appConfig: GenerationErrorConfig | null | undefined,
  fallback: string,
): string {
  const withheld = getAssistantProtectionFailure(error);
  if (withheld != null) return withheld;
  const policyError = getContentFilterError(error);
  if (policyError != null) {
    return policyError.message;
  }
  const message = error instanceof Error ? error.message : undefined;
  const protectionEnabled = hasGenerationContentProtection(appConfig);
  const typed = message != null ? parseTypedErrorMessage(message) : undefined;
  if (message != null && typed != null) {
    return getSafeTypedErrorText(message, typed, protectionEnabled);
  }
  const classified = resolveClassifiedProviderError(error, appConfig, (text) =>
    redactMessage(getSafeErrorText(text)),
  );
  if (classified != null) {
    return classified;
  }
  if (message == null || protectionEnabled) {
    return fallback;
  }
  const trimmed = message.trim();
  return trimmed === '' ? fallback : redactMessage(getSafeErrorText(trimmed));
}
