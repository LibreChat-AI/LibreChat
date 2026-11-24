// file deepcode ignore HardcodedNonCryptoSecret: No hardcoded secrets
import { ErrorTypes, ViolationTypes, parseLangChainErrorCode } from 'librechat-data-provider';
import type { CodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';
import type { ErrorPayload } from './payload';
import { readObject, readString } from './payload';
import { extractJson, isJson } from '../json';

/**
 * The server converts classified LangChain failures into typed payloads, but messages persisted
 * before it did still carry the docs URL, so the code is read back out of the text to localize
 * those the same way. Codes without copy fall through to the provider text, stripped of the URL.
 */
const langChainErrorKeys: Record<string, string> = {
  MODEL_NOT_FOUND: 'com_error_model_not_found',
  MODEL_RATE_LIMIT: 'com_error_model_rate_limit',
};

/** The localization key for a LangChain error code a failure's text names, if it has one. */
export function getLangChainErrorKey(text: string): string | undefined {
  const code = parseLangChainErrorCode(text);
  return code == null ? undefined : langChainErrorKeys[code];
}

let copyKeys: Record<string, string> | undefined;

/**
 * Codes whose whole rendering is one localized sentence. Anything needing a provider name, a
 * number, a permission check or an action has a renderer of its own instead. Built on first use:
 * the codes are read from `librechat-data-provider`, which a module must not read while loading.
 */
function errorCopy(): Record<string, string> {
  copyKeys ??= {
    [ErrorTypes.ASSISTANT_OUTPUT_UNSUPPORTED]: 'com_error_assistant_output_unsupported',
    [ErrorTypes.ASSISTANT_OUTPUT_WITHHELD]: 'com_error_assistant_output_withheld',
    [ErrorTypes.MODERATION]: 'com_error_moderation',
    [ErrorTypes.INVALID_ACTION]: 'com_error_invalid_action_error',
    [ErrorTypes.MODELS_NOT_LOADED]: 'com_error_models_not_loaded',
    [ErrorTypes.GOOGLE_TOOL_CONFLICT]: 'com_error_google_tool_conflict',
    [ErrorTypes.GOOGLE_VIDEO_UNPROCESSABLE]: 'com_error_google_video_unprocessable',
    [ErrorTypes.RESOURCE_RECOVERY_REQUIRED]: 'com_error_resource_recovery_required',
    [ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED]:
      'com_error_stateful_code_environment_not_allowed',
    [ErrorTypes.STREAM_EXPIRED]: 'com_error_stream_expired',
    [ErrorTypes.MODEL_STREAM_CLOSED]: 'com_error_model_stream_closed',
    [ErrorTypes.MODEL_STREAM_STALLED]: 'com_error_model_stream_stalled',
    [ErrorTypes.COMPACTION_FAILED]: 'com_error_compaction_failed',
    [ErrorTypes.OUTPUT_BUDGET_EXHAUSTED]: 'com_error_output_budget_exhausted',
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
  return copyKeys;
}

/** The one localized sentence an error code renders as, when that is its whole rendering. */
export function errorCopyKey(code: string): string | undefined {
  const copy = errorCopy();
  return Object.prototype.hasOwnProperty.call(copy, code) ? copy[code] : undefined;
}

/** Why a code workspace selection was refused, as the sentence a reader is shown. */
export const codeWorkspaceErrorKeys: Record<CodeWorkspaceSelectionErrorReason, string> = {
  required: 'com_error_code_workspace_required',
  invalid: 'com_error_code_workspace_invalid',
  worker_unavailable: 'com_error_code_workspace_worker_unavailable',
  unsupported: 'com_error_code_workspace_unsupported',
  missing: 'com_error_code_workspace_missing',
  locked: 'com_error_code_workspace_locked',
};

/** What a failed turn's persisted text turned out to be. */
export type ErrorTextClass =
  /** A LangChain failure an older server persisted as prose; `key` localizes it. */
  | { kind: 'langchain'; key: string }
  /** Prose with no JSON payload in it. */
  | { kind: 'prose' }
  /**
   * A JSON payload. `payload` is what a renderer reads: the body itself, or its OpenAI-style
   * `error` envelope when only the envelope names a code. `code` is that code, if any.
   */
  | { kind: 'payload'; json: ErrorPayload; payload: ErrorPayload; code?: string };

/**
 * Reads a failed turn's text. Three kinds of text arrive: a typed payload this app produced, a
 * provider's own error body, and unclassified prose.
 */
export function classifyErrorText(text: string): ErrorTextClass {
  const langChainKey = getLangChainErrorKey(text);
  if (langChainKey != null) {
    return { kind: 'langchain', key: langChainKey };
  }

  const jsonString = extractJson(text);
  if (!isJson(jsonString)) {
    return { kind: 'prose' };
  }

  const json = JSON.parse(jsonString) as ErrorPayload;
  /**
   * OpenAI-compatible bodies nest their `code` and `type` under `error`. When the top level names
   * neither, that envelope is the payload a renderer reads; a top-level `type`, even a generic one
   * like Anthropic's `"error"`, keeps the body as it is.
   */
  const envelope = readObject(json, 'error');
  const topLevelKey = readString(json, 'code') ?? readString(json, 'type');
  const nestedKey =
    topLevelKey == null
      ? (readString(envelope, 'code') ?? readString(envelope, 'type'))
      : undefined;
  const payload = nestedKey != null && envelope != null ? envelope : json;
  return { kind: 'payload', json, payload, code: topLevelKey ?? nestedKey };
}
