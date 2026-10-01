import { logger } from '@librechat/data-schemas';
import type { TImportError, TImportFailureCode } from 'librechat-data-provider';

const UNSUPPORTED_IMPORT_TYPE = 'Unsupported import type';
const ARCHIVE_TOO_LARGE_MESSAGE = 'The uploaded archive exceeds the allowed size limits';
const FILE_TOO_LARGE_MESSAGE =
  'This JSON file is too large to import on its own. Compress it into a .zip and upload that instead';
const ARCHIVE_CORRUPT_MESSAGE = 'The uploaded archive is corrupt or could not be read';
const STORAGE_FAILURE_MESSAGE = 'A storage error occurred while processing the import';
const IMPORT_FAILED_MESSAGE = 'The import could not be completed';

/** Node `fs` error codes that indicate a local storage failure (disk
 * pressure, permissions, a file removed out from under a read). Every one
 * of these embeds the server's absolute filesystem path in `.message`. */
const FS_ERROR_CODES = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
  'ENOSPC',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'ELOOP',
  'ENAMETOOLONG',
  'EROFS',
  'EEXIST',
  'EIO',
]);

const CORRUPT_ARCHIVE_PATTERN =
  /invalid relative path|absolute path|traversal|central directory|not a valid zip|unable to read archive|entry not found in archive|unable to read entry/i;

/**
 * A bare (un-zipped) upload larger than the per-entry cap. Distinct from
 * `ZipBombError` because it is not a bomb and not the user's mistake: the
 * upload limit is sized for a `.zip`, whose shards are each well under the
 * cap, so this file passed every check before the one that can reject it.
 * The message it maps to therefore names the workaround.
 */
export class ImportFileTooLargeError extends Error {
  readonly code = 'IMPORT_FILE_TOO_LARGE';
  constructor(message: string) {
    super(message);
    this.name = 'ImportFileTooLargeError';
  }
}

function errorCode(error: Error): string | undefined {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Classifies a raw import failure into one of a small set of stable,
 * non-revealing codes before it is stored on a job record or returned
 * to a client. Node's `fs` errors (`ENOENT`, `EACCES`, ...) embed the
 * server's absolute upload path in `.message`, and a raw `ZipBombError`
 * or archive-parsing error can embed attacker-controlled entry names;
 * none of that detail is ever forwarded. The original error is logged
 * here, server-side, and only here; callers should not also log it.
 */
export function classifyImportError(
  error: unknown,
  context: string,
  log = true,
): TImportFailureCode {
  const normalized = error instanceof Error ? error : new Error(String(error));
  if (log) {
    logger.error(`[import] ${context}`, normalized);
  }

  const code = errorCode(normalized);
  if (code === 'IMPORT_FILE_TOO_LARGE') {
    return 'file_too_large';
  }
  if (code === 'ZIP_BOMB') {
    return 'archive_too_large';
  }
  if (normalized.message === UNSUPPORTED_IMPORT_TYPE) {
    return 'unsupported_type';
  }
  if (code !== undefined && FS_ERROR_CODES.has(code)) {
    return 'storage_error';
  }
  if (normalized instanceof SyntaxError || CORRUPT_ARCHIVE_PATTERN.test(normalized.message)) {
    return 'archive_corrupt';
  }
  return 'failed';
}

/**
 * The English rendering of each code. Only for `job.error` and other places
 * that must be a single string; the per-item report carries codes instead and
 * is localized on the client.
 */
const MESSAGE_BY_CODE: Record<TImportFailureCode, string> = {
  unsupported_type: UNSUPPORTED_IMPORT_TYPE,
  archive_too_large: ARCHIVE_TOO_LARGE_MESSAGE,
  file_too_large: FILE_TOO_LARGE_MESSAGE,
  archive_corrupt: ARCHIVE_CORRUPT_MESSAGE,
  storage_error: STORAGE_FAILURE_MESSAGE,
  failed: IMPORT_FAILED_MESSAGE,
};

export function sanitizeImportError(error: unknown, context: string): string {
  return MESSAGE_BY_CODE[classifyImportError(error, context)];
}

/** How many per-item failures a report keeps. A systematically broken export
 * produces one entry per conversation and per asset, and the whole array is
 * serialized into the job's cache record and returned in full on every poll,
 * so an uncapped list is hundreds of KB of Redis value and response body for
 * an import that told the user nothing more than the first hundred would. */
export const MAX_REPORT_ERRORS = 100;

/**
 * Appends a failure to a report, keeping the first `MAX_REPORT_ERRORS` and
 * replacing the rest with a single running count. Returns nothing: callers
 * push through this rather than onto the array directly.
 */
export function recordError(errors: TImportError[], entry: TImportError): void {
  if (errors.length < MAX_REPORT_ERRORS) {
    errors.push(entry);
    return;
  }

  const suffix = errors[MAX_REPORT_ERRORS];
  const hidden = Number(suffix?.params?.count ?? 0) + 1;
  errors[MAX_REPORT_ERRORS] = { code: 'errors_truncated', params: { count: hidden } };
}

/**
 * Records one per-item failure (a conversation or an asset). Every failure is
 * classified and counted, but only the ones the report still keeps are logged:
 * a single archive can carry thousands of records that each fail, and once the
 * report is truncated a full stack trace per item is unbounded log volume that
 * says nothing the first hundred did not.
 */
export function recordItemError(
  errors: TImportError[],
  error: unknown,
  context: string,
  location: string,
): void {
  const log = errors.length < MAX_REPORT_ERRORS;
  recordError(errors, { code: classifyImportError(error, context, log), location });
}
