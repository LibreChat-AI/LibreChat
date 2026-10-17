import axios from 'axios';
import type { TLangfusePromptErrorBody, TLangfusePromptErrorCode } from 'librechat-data-provider';
import type { TranslationKeys, useLocalize } from '~/hooks';
import { getResponseErrorCode, getResponseStatus } from '~/utils';

/** Codes whose whole copy is one localized sentence; `upstream` is handled separately below
 *  because its sentence needs the Langfuse HTTP status when the server sent one. */
export const PROMPT_ERROR_MESSAGE_KEYS: Partial<Record<TLangfusePromptErrorCode, TranslationKeys>> =
  {
    not_configured: 'com_ui_langfuse_prompt_error_not_configured',
    unauthorized: 'com_ui_langfuse_prompt_error_unauthorized',
    timeout: 'com_ui_langfuse_prompt_error_timeout',
    invalid_response: 'com_ui_langfuse_prompt_error_invalid_response',
    not_found: 'com_ui_langfuse_prompt_error_not_found',
    unsupported_type: 'com_ui_langfuse_prompt_error_unsupported_type',
    invalid_request: 'com_ui_langfuse_prompt_error_invalid_request',
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
export function getPromptErrorMessage(
  error: unknown,
  localize: ReturnType<typeof useLocalize>,
): string {
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
