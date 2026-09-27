import {
  ErrorTypes,
  DEFAULT_MAX_PROVIDER_ERROR_CHARS,
  parseLangChainErrorCode,
  stripLangChainTroubleshootingUrl,
} from 'librechat-data-provider';
import { MCPErrorCodes, isMCPInitializationError } from '~/mcp/errors';
import { OboTokenResolutionError } from '~/mcp/oauth/obo';

export const AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE = 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE';
export const AGENT_ATTACHMENT_LIMIT_EXCEEDED = 'AGENT_ATTACHMENT_LIMIT_EXCEEDED';

const FATAL_AGENT_INITIALIZATION_CODES = new Set(
  [
    AGENT_ATTACHMENT_LIMIT_EXCEEDED,
    ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
    ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
    ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
  ].filter((code): code is string => typeof code === 'string'),
);

export function createStatefulCodeEnvironmentPolicyError(environment: string): Error {
  return Object.assign(
    new Error(`Stateful code environment is not allowed by this deployment: ${environment}`),
    {
      code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
      status: 403,
      statusCode: 403,
    },
  );
}

export interface FatalAgentInitializationOptions {
  signal?: AbortSignal;
  /**
   * Skill `allowed-tools` may add an MCP tool beyond the agent's configured
   * baseline. That union load is allowed to retry without the skill extras;
   * a second failure from the baseline still propagates normally.
   */
  allowExpectedMCPFallback?: boolean;
}

function getErrorCode(error: unknown): unknown {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  return (error as { code?: unknown }).code;
}

/**
 * Returns whether agent initialization must abort instead of using the
 * legacy soft-failure behavior for unavailable optional tools or agents.
 * Keep fatal initialization policy centralized here so every topology and
 * ingress path makes the same decision when new invariant errors are added.
 */
export function isFatalAgentInitializationError(
  error: unknown,
  options: FatalAgentInitializationOptions = {},
): boolean {
  const code = getErrorCode(error);
  return (
    isMCPInitializationError(error, options.signal) ||
    FATAL_AGENT_INITIALIZATION_CODES.has(code as string) ||
    (code === AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE && options.allowExpectedMCPFallback !== true)
  );
}

/** Fallback shown when provider error text must not reach the user. */
export const GENERIC_PROVIDER_ERROR = 'An error occurred while processing the request';

/**
 * LangChain error codes we answer with localized copy. Codes absent here keep the provider's own
 * message (minus the docs URL), which is more specific than any generic string we could write.
 */
const LANGCHAIN_ERROR_TYPES: Record<string, ErrorTypes> = {
  MODEL_NOT_FOUND: ErrorTypes.MODEL_NOT_FOUND,
  MODEL_RATE_LIMIT: ErrorTypes.MODEL_RATE_LIMIT,
};

/**
 * Reads LangChain's classification off the error, falling back to the docs URL it stamps into the
 * message so a re-thrown or serialized error still classifies.
 */
export function getLangChainErrorCode(error: unknown): string | undefined {
  if (error == null || typeof error !== 'object') {
    return parseLangChainErrorCode(error);
  }
  const { lc_error_code: code, message } = error as { lc_error_code?: unknown; message?: unknown };
  if (typeof code === 'string' && code.length > 0) {
    return code.toUpperCase();
  }
  return parseLangChainErrorCode(message);
}

/**
 * Typed payload the client localizes for a classified LangChain failure, or `undefined` when the
 * code has no localized copy and the provider's own message should be shown instead.
 */
export function resolveLangChainError(error: unknown): string | undefined {
  const code = getLangChainErrorCode(error);
  const type = code == null ? undefined : LANGCHAIN_ERROR_TYPES[code];
  return type == null ? undefined : JSON.stringify({ type });
}

/**
 * Provider failure text for OpenAI-compatible responses, which carry raw strings rather than the
 * typed payloads the LibreChat client localizes.
 */
export function getUserFacingProviderError(error: unknown, protectionEnabled: boolean): string {
  if (protectionEnabled) {
    return GENERIC_PROVIDER_ERROR;
  }
  if (!(error instanceof Error)) {
    return 'An error occurred';
  }
  return stripLangChainTroubleshootingUrl(error.message) || GENERIC_PROVIDER_ERROR;
}

/** Bounded lookahead covers LangChain's appended troubleshooting label and URL. */
const TROUBLESHOOTING_LOOKAHEAD = 256;

/**
 * The provider's own words for a failure, or `undefined` when it has none to give. A gateway,
 * proxy or OpenAI-compatible endpoint answers a rejection it alone can explain, and that sentence
 * is more specific than any generic string we could write.
 *
 * Read defensively: an SDK error's `message` may be a hostile accessor or a body object rather
 * than a string, and the docs URL LangChain stamps in is not for a reader.
 */
export function getProviderErrorMessage(
  error: unknown,
  maxChars: number = DEFAULT_MAX_PROVIDER_ERROR_CHARS,
): string | undefined {
  const raw =
    error != null && typeof error === 'object' ? readErrorProperty(error, 'message') : error;
  if (typeof raw !== 'string') {
    return undefined;
  }
  const limit =
    Number.isSafeInteger(maxChars) && maxChars >= 0 ? maxChars : DEFAULT_MAX_PROVIDER_ERROR_CHARS;
  const message = stripLangChainTroubleshootingUrl(raw.slice(0, limit + TROUBLESHOOTING_LOOKAHEAD))
    .slice(0, limit)
    .trim();
  return message.length === 0 ? undefined : message;
}

/**
 * LangGraph's stable machine identifier for "the graph ran out of supersteps".
 * Set as `lc_error_code` on the `GraphRecursionError` thrown by the Pregel loop
 * when `loop.status === 'out_of_steps'`.
 */
const GRAPH_RECURSION_LIMIT_CODE = 'GRAPH_RECURSION_LIMIT';

/** Bounded `cause` walk: a graph error may be rethrown wrapped by an outer node. */
const MAX_CAUSE_DEPTH = 4;

function readErrorProperty(error: object, property: PropertyKey): unknown {
  try {
    return Reflect.get(error, property);
  } catch {
    return undefined;
  }
}

/**
 * Whether `error` is the agent graph exhausting its per-turn step budget
 * (`recursionLimit`), as opposed to anything actually going wrong.
 *
 * This is a normal terminal condition, not a failure: the turn is persisted as
 * `unfinished` with `Constants.TOOL_CALL_LIMIT_FINISH_REASON` so the UI can offer
 * to continue, instead of surfacing a red error bubble the user cannot act on.
 *
 * Both markers are checked because they fail independently. `lc_error_code` is the
 * documented contract but is only present on errors constructed with the fields
 * argument, while `name` is assigned in the constructor body and therefore survives
 * class-name minification. Either one alone is sufficient evidence.
 */
export function isStepLimitError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
    if (typeof current !== 'object') {
      return false;
    }
    if (
      readErrorProperty(current, 'lc_error_code') === GRAPH_RECURSION_LIMIT_CODE ||
      readErrorProperty(current, 'name') === 'GraphRecursionError'
    ) {
      return true;
    }
    current = readErrorProperty(current, 'cause');
  }
  return false;
}

/** Outward metadata shared by UI generation failures and both remote agent APIs. */
export function getAgentErrorMetadata(
  error: unknown,
): { status?: number; code?: string; retryable?: boolean } | undefined {
  if (error instanceof OboTokenResolutionError) {
    return {
      status: error.retryable ? 503 : 403,
      code: error.retryable
        ? MCPErrorCodes.AUTHENTICATION_REFRESH_FAILED
        : MCPErrorCodes.AUTHENTICATION_REJECTED,
      retryable: error.retryable,
    };
  }
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  return {
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600
      ? { status }
      : {}),
    ...(typeof candidate.code === 'string' ? { code: candidate.code } : {}),
  };
}
