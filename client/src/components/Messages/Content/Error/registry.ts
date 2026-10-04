import { ErrorTypes, ViolationTypes } from 'librechat-data-provider';
import type { ComponentType } from 'react';
import type { ErrorRendererProps } from './parts';
import type { TranslationKeys } from '~/hooks';
import { ProviderErrorCodes } from './parts';
import ProviderError from './ProviderError';
import UserKeyError from './UserKeyError';
import BalanceError from './BalanceError';
import ContextError from './ContextError';
import ModelError from './ModelError';
import LimitError from './LimitError';
import AgentError from './AgentError';

/**
 * Codes whose whole rendering is one localized sentence.
 *
 * Anything needing a provider name, a number, a permission check or an action belongs in
 * `errorRenderers` instead.
 */
export const errorCopy: Record<string, TranslationKeys> = {
  [ErrorTypes.MODERATION]: 'com_error_moderation',
  [ErrorTypes.INVALID_ACTION]: 'com_error_invalid_action_error',
  [ErrorTypes.MODELS_NOT_LOADED]: 'com_error_models_not_loaded',
  [ErrorTypes.GOOGLE_TOOL_CONFLICT]: 'com_error_google_tool_conflict',
  [ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE]: 'com_error_google_video_unprocessable',
  [ErrorTypes.RESOURCE_RECOVERY_REQUIRED]: 'com_error_resource_recovery_required',
  [ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED]:
    'com_error_stateful_code_environment_not_allowed',
  [ErrorTypes.STREAM_EXPIRED]: 'com_error_stream_expired',
  [ErrorTypes.MODEL_NOT_FOUND]: 'com_error_model_not_found',
  [ErrorTypes.MODEL_RATE_LIMIT]: 'com_error_model_rate_limit',
  [ErrorTypes.MODEL_STREAM_CLOSED]: 'com_error_model_stream_closed',
  [ErrorTypes.MODEL_STREAM_STALLED]: 'com_error_model_stream_stalled',
  [ErrorTypes.COMPACTION_FAILED]: 'com_error_compaction_failed',
  [ErrorTypes.AUTH_FAILED]: 'com_error_auth_failed',
  [ErrorTypes.AUTH_RATE_LIMITED]: 'com_error_auth_rate_limited',
  [ErrorTypes.AUTH_BANNED]: 'com_error_auth_banned',
  [ErrorTypes.AUTH_CROSS_ORIGIN]: 'com_auth_error_login_cross_origin',
  [ViolationTypes.BAN]: 'com_error_ban',
  [ViolationTypes.CONVO_ACCESS]: 'com_error_convo_access',
  [ViolationTypes.TOOL_CALL_LIMIT]: 'com_error_tool_call_limit',
  [ViolationTypes.SHARE_LIMIT]: 'com_error_share_limit',
  [ViolationTypes.LOGINS]: 'com_error_logins',
  [ViolationTypes.REGISTRATIONS]: 'com_error_registrations',
  [ViolationTypes.RESET_PASSWORD_LIMIT]: 'com_error_reset_password_limit',
  [ViolationTypes.VERIFY_EMAIL_LIMIT]: 'com_error_verify_email_limit',
  [ViolationTypes.NON_BROWSER]: 'com_error_non_browser',
  [ViolationTypes.GENERAL]: 'com_error_request_blocked',
};

/** Codes whose copy depends on payload fields, deployment capabilities or the user's rights. */
export const errorRenderers: Record<string, ComponentType<ErrorRendererProps>> = {
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
