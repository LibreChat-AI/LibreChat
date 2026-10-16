import axios from 'axios';
import type {
  TLangfusePromptErrorBody,
  TLangfusePromptErrorCode,
  TPromptResolveErrorCode,
} from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import type { TranslationKeys } from '~/hooks';
import { getResponseErrorCode, getResponseStatus } from './errors';

/** The transport-failure codes `/resolve` and the Langfuse prompt-sync dialog share: both
 *  surface them from the same `LangfusePromptRequestError`/`toLangfusePromptErrorResponse`
 *  path, so they read as the same localized sentence in either surface. */
const SHARED_LANGFUSE_TRANSPORT_ERROR_KEYS: Record<
  | 'not_configured'
  | 'unauthorized'
  | 'timeout'
  | 'invalid_response'
  | 'unsupported_type'
  | 'invalid_request',
  TranslationKeys
> = {
  not_configured: 'com_ui_langfuse_prompt_error_not_configured',
  unauthorized: 'com_ui_langfuse_prompt_error_unauthorized',
  timeout: 'com_ui_langfuse_prompt_error_timeout',
  invalid_response: 'com_ui_langfuse_prompt_error_invalid_response',
  unsupported_type: 'com_ui_langfuse_prompt_error_unsupported_type',
  invalid_request: 'com_ui_langfuse_prompt_error_invalid_request',
};

/** Codes whose whole copy is one localized sentence; `upstream` is handled separately below
 *  because its sentence needs the Langfuse HTTP status when the server sent one. */
export const PROMPT_ERROR_MESSAGE_KEYS: Partial<Record<TLangfusePromptErrorCode, TranslationKeys>> =
  {
    ...SHARED_LANGFUSE_TRANSPORT_ERROR_KEYS,
    not_found: 'com_ui_langfuse_prompt_error_not_found',
    already_running: 'com_ui_langfuse_prompt_error_already_running',
    lock_lost: 'com_ui_langfuse_prompt_error_lock_lost',
    internal: 'com_ui_langfuse_prompt_error_internal',
  };

function getUpstreamStatus(error: unknown): number | undefined {
  if (!axios.isAxiosError<TLangfusePromptErrorBody>(error)) {
    return undefined;
  }
  const status = error.response?.data?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Maps a failed Langfuse prompt call to one short localized line, with a generic fallback for
 *  an unmapped or missing code (for example a bare 404 with no body, which means the feature is off).
 *  A 403 is checked ahead of any body code: it means the caller lacks permission regardless of
 *  what the body says, so it always wins. */
export function getPromptErrorMessage(error: unknown, localize: LocalizeFunction): string {
  if (getResponseStatus(error) === 403) {
    return localize('com_ui_langfuse_prompt_error_forbidden');
  }
  const code = getResponseErrorCode<TLangfusePromptErrorCode>(error);
  if (code === 'upstream') {
    const status = getUpstreamStatus(error);
    return status != null
      ? localize('com_ui_langfuse_prompt_error_upstream_status', { 0: status })
      : localize('com_ui_langfuse_prompt_error_upstream');
  }
  const messageKey = code != null ? PROMPT_ERROR_MESSAGE_KEYS[code] : undefined;
  return localize(messageKey ?? 'com_ui_langfuse_prompt_error_fallback');
}

/** Codes whose whole copy is one localized sentence; `upstream` is handled separately,
 *  the same way `getPromptErrorMessage` handles it, with the Langfuse HTTP status. */
const PROMPT_RESOLVE_ERROR_MESSAGE_KEYS: Partial<Record<TPromptResolveErrorCode, TranslationKeys>> =
  {
    ...SHARED_LANGFUSE_TRANSPORT_ERROR_KEYS,
    not_found: 'com_ui_prompt_resolve_error_not_found',
    not_available: 'com_ui_prompt_resolve_error_not_available',
    source_changed: 'com_ui_prompt_resolve_error_source_changed',
  };

function isContentFilterBlock(error: unknown): boolean {
  if (!axios.isAxiosError<{ error?: string }>(error)) {
    return false;
  }
  return error.response?.data?.error === 'content_filter_block';
}

/**
 * Maps a failed `GET /api/prompts/groups/:groupId/resolve` call to one short localized
 * line. Checked in order: a content-filter block (`{ error: 'content_filter_block', ... }`,
 * no `code`), a 403 (`{ error: 'Forbidden' }` from the ACL middleware, no `code`), a
 * rate-limited 429 (`{ message }`, no `code`), then the response's `code`
 * (`TPromptResolveErrorCode`). `unauthorized`, `timeout`, `upstream`, `invalid_response`,
 * `unsupported_type`, `invalid_request` and `not_configured` reuse the exact keys
 * `getPromptErrorMessage` already uses for them, since both read the same server error
 * shapes; `not_found`, `not_available` and `source_changed` are resolve-specific. Falls
 * back to the dialog mapper's generic fallback key for an unmapped or missing code.
 */
export function getPromptResolveErrorMessage(error: unknown, localize: LocalizeFunction): string {
  if (isContentFilterBlock(error)) {
    return localize('com_ui_prompt_resolve_error_blocked');
  }
  if (getResponseStatus(error) === 403) {
    return localize('com_ui_prompt_resolve_error_forbidden');
  }
  if (getResponseStatus(error) === 429) {
    return localize('com_ui_prompt_resolve_error_rate_limited');
  }
  const code = getResponseErrorCode<TPromptResolveErrorCode>(error);
  if (code === 'upstream') {
    const status = getUpstreamStatus(error);
    return status != null
      ? localize('com_ui_langfuse_prompt_error_upstream_status', { 0: status })
      : localize('com_ui_langfuse_prompt_error_upstream');
  }
  const messageKey = code != null ? PROMPT_RESOLVE_ERROR_MESSAGE_KEYS[code] : undefined;
  return localize(messageKey ?? 'com_ui_langfuse_prompt_error_fallback');
}
