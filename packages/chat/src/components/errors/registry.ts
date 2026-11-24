import { ErrorTypes, ViolationTypes } from 'librechat-data-provider';
import type { ComponentType } from 'react';
import type { ErrorRendererProps } from './parts';
import { ProviderErrorCodes } from '../../core/errors';
import ProviderError from './ProviderError';
import UserKeyError from './UserKeyError';
import BalanceError from './BalanceError';
import ContextError from './ContextError';
import ModelError from './ModelError';
import LimitError from './LimitError';
import AgentError from './AgentError';

type ErrorRenderer = ComponentType<ErrorRendererProps>;

let renderers: Record<string, ErrorRenderer> | undefined;

/**
 * Codes whose copy depends on payload fields, deployment capabilities or the user's rights. Built
 * on first use: the codes are read from `librechat-data-provider`, which a module must not read
 * while it loads.
 */
function errorRenderers(): Record<string, ErrorRenderer> {
  renderers ??= {
    [ErrorTypes.NO_USER_KEY]: UserKeyError,
    [ErrorTypes.EXPIRED_USER_KEY]: UserKeyError,
    [ErrorTypes.INVALID_USER_KEY]: UserKeyError,
    [ErrorTypes.NO_BASE_URL]: UserKeyError,
    [ErrorTypes.INVALID_BASE_URL]: UserKeyError,
    [ProviderErrorCodes.INVALID_API_KEY]: UserKeyError,
    [ProviderErrorCodes.INSUFFICIENT_QUOTA]: UserKeyError,
    [ErrorTypes.INVALID_AGENT_PROVIDER]: AgentError,
    [ErrorTypes.MISSING_MODEL]: ModelError,
    [ErrorTypes.ENDPOINT_MODELS_NOT_LOADED]: ModelError,
    [ErrorTypes.UPSTREAM_MODEL_ERROR]: ModelError,
    [ErrorTypes.CODE_WORKSPACE_UNAVAILABLE]: ModelError,
    [ViolationTypes.ILLEGAL_MODEL_REQUEST]: ModelError,
    [ErrorTypes.REFUSAL]: ProviderError,
    [ErrorTypes.GOOGLE_ERROR]: ProviderError,
    [ErrorTypes.INVALID_REQUEST]: ProviderError,
    [ErrorTypes.NO_SYSTEM_MESSAGES]: ProviderError,
    [ErrorTypes.MODEL_NOT_FOUND]: ProviderError,
    [ErrorTypes.MODEL_RATE_LIMIT]: ProviderError,
    [ErrorTypes.INPUT_LENGTH]: ContextError,
    [ErrorTypes.EMPTY_MESSAGES]: ContextError,
    [ErrorTypes.FINAL_CONTEXT_OVERFLOW]: ContextError,
    [ErrorTypes.COMPACTION_SKIPPED]: ContextError,
    [ViolationTypes.TOKEN_BALANCE]: BalanceError,
    [ViolationTypes.MESSAGE_LIMIT]: LimitError,
    [ViolationTypes.CONCURRENT]: LimitError,
    [ViolationTypes.FILE_UPLOAD_LIMIT]: LimitError,
    [ViolationTypes.TTS_LIMIT]: LimitError,
    [ViolationTypes.STT_LIMIT]: LimitError,
  };
  return renderers;
}

/**
 * The card for an error code, when its copy needs more than one fixed sentence. Codes come from
 * message data, so only the table's own entries match: a payload typed `constructor` is not a card.
 */
export function errorRenderer(code: string): ErrorRenderer | undefined {
  const table = errorRenderers();
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
}
