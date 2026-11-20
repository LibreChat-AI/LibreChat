import axios from 'axios';
import { isCodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';
import type { CodeWorkspaceSelectionErrorReason } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/**
 * Returns the HTTP response status code from an error, regardless of the
 * HTTP client used.  Handles Axios errors first, then falls back to checking
 * for a plain `status` property so callers never need to import axios.
 */
export const getResponseStatus = (error: unknown): number | undefined => {
  if (axios.isAxiosError(error)) {
    return error.response?.status;
  }
  if (error != null && typeof error === 'object' && 'status' in error) {
    const { status } = error as { status: unknown };
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
};

export const isNotFoundError = (error: unknown): boolean => getResponseStatus(error) === 404;

export const codeWorkspaceErrorKeys: Record<CodeWorkspaceSelectionErrorReason, TranslationKeys> = {
  required: 'com_error_code_workspace_required',
  invalid: 'com_error_code_workspace_invalid',
  worker_unavailable: 'com_error_code_workspace_worker_unavailable',
  unsupported: 'com_error_code_workspace_unsupported',
  missing: 'com_error_code_workspace_missing',
  locked: 'com_error_code_workspace_locked',
};

/** Reads the workspace rejection reason a failed request carried, when the server sent one. */
export const getCodeWorkspaceErrorReason = (
  error: unknown,
): CodeWorkspaceSelectionErrorReason | undefined => {
  if (!axios.isAxiosError(error)) {
    return undefined;
  }
  const data: unknown = error.response?.data;
  const reason = data != null && typeof data === 'object' && 'reason' in data ? data.reason : null;
  return isCodeWorkspaceSelectionErrorReason(reason) ? reason : undefined;
};

export const getResponseErrorCode = <TCode extends string>(error: unknown): TCode | undefined => {
  if (!axios.isAxiosError<{ code?: string }>(error)) {
    return undefined;
  }
  const code = error.response?.data?.code;
  return typeof code === 'string' ? (code as TCode) : undefined;
};
