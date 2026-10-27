import { redactMessage } from '@librechat/data-schemas';
import { ErrorTypes, ViolationTypes } from 'librechat-data-provider';
import type { FiltersConfig, MessageFilterPiiConfig } from 'librechat-data-provider';
import type { SafeErrorMetadata } from '../../utils/errors';
import type { ModelErrorTrackerCallback } from './tracker';
import {
  resolveLangChainError,
  getModelStreamFailure,
  resolveModelStreamError,
  getProviderErrorMessage,
} from '../errors';
import { getSafeErrorText, getSafeErrorMetadata, isOwnedAbortError } from '../../utils/errors';
import { hasModelBoundContentProtection } from '../../middleware/modelBoundContent';
import { getContentFilterError } from '../../middleware/contentFilter';
import { traceIdForMessage } from '../../langfuse/trace';
import { createModelErrorTracker } from './tracker';

const UPSTREAM_MODEL_ERROR_CODE = 'UPSTREAM_MODEL_ERROR';
const UPSTREAM_MODEL_ERROR_ORIGIN = 'model_provider';
const UNKNOWN_UPSTREAM_MODEL_ERROR_TYPE = '_OTHER';
const UPSTREAM_MODEL_ERROR_FALLBACK = 'The model provider could not complete this request.';

function safelyResolveLangChainError(error: unknown): string | undefined {
  try {
    return resolveLangChainError(error);
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
      if (upstreamModelError == null) {
        return fallback();
      }

      const { status } = getSafeErrorMetadata(upstreamModelError);
      const classifiedError =
        safelyResolveLangChainError(error) ??
        safelyResolveLangChainError(upstreamModelError) ??
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
      if (upstreamModelError == null) {
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
export interface GenerationErrorConfig {
  readonly filters?: FiltersConfig | null;
  readonly messageFilter?: { readonly pii?: MessageFilterPiiConfig | null } | null;
}

/**
 * The error text a failed generation publishes and persists on its error row, under the same rule
 * the run's content error parts follow. Host-authored outcomes keep their wording: a typed
 * `{"type": ...}` payload (redacted, and reduced to its code and numeric fields under a content policy), a LangChain-classified provider failure, or a content policy block.
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
  const policyError = getContentFilterError(error);
  if (policyError != null) {
    return policyError.message;
  }
  const message = error instanceof Error ? error.message : undefined;
  const protectionEnabled = hasModelBoundContentProtection(
    appConfig?.filters,
    appConfig?.messageFilter?.pii,
  );
  const typed = message != null ? parseTypedErrorMessage(message) : undefined;
  if (message != null && typed != null) {
    return getSafeTypedErrorText(message, typed, protectionEnabled);
  }
  const classified = safelyResolveLangChainError(error);
  if (classified != null) {
    return classified;
  }
  if (message == null || protectionEnabled) {
    return fallback;
  }
  const trimmed = message.trim();
  return trimmed === '' ? fallback : redactMessage(getSafeErrorText(trimmed));
}
