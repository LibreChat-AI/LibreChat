import FormData from 'form-data';
import { isAxiosError } from 'axios';
import type { AxiosInstance } from 'axios';
import type { CodeEnvIdentity } from './identity';
import { codeServerHttpAgent, codeServerHttpsAgent } from '~/utils/code';
import { appendCodeEnvFile, getCodeEnvUploadFilename } from './form';
import { appendCodeEnvFileIdentity } from './identity';

/** Half of the Code API's own per-request file cap, so a batch never loses its tail to it. */
export const CODE_UPLOAD_BATCH_MAX_FILES = 100;

/**
 * Bytes one batch may carry. Batched files are held in memory so each can be digested and a
 * rate-limited request repeated without reopening storage, and the request has to stay well
 * inside the body limits of the proxies in front of a Code API deployment.
 */
export const CODE_UPLOAD_BATCH_MAX_BYTES: number = 32 * 1024 * 1024;

const CODE_UPLOAD_BATCH_TIMEOUT_MS = 120_000;
const CODE_UPLOAD_BATCH_MAX_BODY_BYTES: number = 150 * 1024 * 1024;

export interface CodeUploadBatchPlan<T> {
  /** Groups that each fit one `/upload/batch` request. */
  batches: T[][];
  /** Entries too large, or of unknown size, to hold in memory; uploaded one stream at a time. */
  streamed: T[];
}

/** Packs uploads into as few bounded requests as their sizes allow, preserving order. */
export function planCodeUploadBatches<T>(
  entries: readonly T[],
  sizeOf: (entry: T) => number | undefined,
  limits: { maxFiles: number; maxBytes: number } = {
    maxFiles: CODE_UPLOAD_BATCH_MAX_FILES,
    maxBytes: CODE_UPLOAD_BATCH_MAX_BYTES,
  },
): CodeUploadBatchPlan<T> {
  const batches: T[][] = [];
  const streamed: T[] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const size = sizeOf(entry);
    if (size == null || !Number.isFinite(size) || size < 0 || size > limits.maxBytes) {
      streamed.push(entry);
      continue;
    }
    if (
      current.length > 0 &&
      (current.length >= limits.maxFiles || currentBytes + size > limits.maxBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return { batches, streamed };
}

export interface CodeBatchUploadFile {
  filename: string;
  buffer: Buffer;
}

/**
 * What the Code API answered for one file of a batch. Only an entry the service marked as an
 * error is a refusal; a file it left out, or a success without an object id, may still have
 * been stored, so its outcome stays `unknown`.
 */
export type CodeBatchUploadOutcome =
  | { status: 'success'; fileId: string; filename: string }
  | { status: 'error'; error: string }
  | { status: 'unknown'; error: string };

export interface CodeBatchUploadResponse {
  /** One storage session holds every file the request stored. */
  storage_session_id: string;
  /** Aligned with the request's files. */
  files: CodeBatchUploadOutcome[];
}

interface BatchResponseEntry {
  status?: string;
  filename?: string;
  fileId?: string;
  error?: string;
}

interface BatchResponseBody {
  storage_session_id?: string;
  files?: BatchResponseEntry[];
}

function isBatchResponseBody(body: unknown): body is BatchResponseBody & {
  storage_session_id: string;
  files: BatchResponseEntry[];
} {
  return (
    body != null &&
    typeof body === 'object' &&
    'storage_session_id' in body &&
    typeof body.storage_session_id === 'string' &&
    body.storage_session_id !== '' &&
    'files' in body &&
    Array.isArray(body.files)
  );
}

function toOutcome(entry: BatchResponseEntry | undefined): CodeBatchUploadOutcome {
  if (entry?.status === 'success' && typeof entry.fileId === 'string' && entry.fileId !== '') {
    return { status: 'success', fileId: entry.fileId, filename: entry.filename ?? '' };
  }
  if (entry?.status === 'error') {
    return { status: 'error', error: entry.error || 'upload failed' };
  }
  return {
    status: 'unknown',
    error: entry ? 'the Code API returned an unusable result' : 'the Code API returned no result',
  };
}

/**
 * The service answers in part order. When it reports a different number of files than were
 * sent, as it does past its per-request cap, results are paired by name instead and the
 * outcome of a file it never mentions is unknown.
 */
function alignOutcomes(
  sent: readonly CodeBatchUploadFile[],
  received: BatchResponseEntry[],
): CodeBatchUploadOutcome[] {
  if (received.length === sent.length) {
    return received.map(toOutcome);
  }
  const byName = new Map<string, BatchResponseEntry[]>();
  for (const entry of received) {
    if (typeof entry?.filename !== 'string') continue;
    const named = byName.get(entry.filename);
    if (named) named.push(entry);
    else byName.set(entry.filename, [entry]);
  }
  return sent.map((file) =>
    toOutcome(byName.get(getCodeEnvUploadFilename(file.filename))?.shift()),
  );
}

/**
 * Stores several files with one Code API request, which its upload limiter counts once.
 *
 * Resolves whenever the service answered per file, including the 400 it sends when every file
 * failed; any other failure rejects for the whole request.
 */
export async function uploadCodeEnvBatch({
  request,
  baseUrl,
  headers,
  identity,
  files,
  signal,
}: {
  request: AxiosInstance;
  baseUrl: string;
  headers: Record<string, string>;
  identity: CodeEnvIdentity;
  files: readonly CodeBatchUploadFile[];
  signal?: AbortSignal;
}): Promise<CodeBatchUploadResponse> {
  const form = new FormData();
  appendCodeEnvFileIdentity(form, identity);
  for (const file of files) {
    appendCodeEnvFile(form, file.buffer, file.filename);
  }
  let body: unknown;
  try {
    const response = await request.post<unknown>(`${baseUrl}/upload/batch`, form, {
      headers: { ...headers, ...form.getHeaders() },
      httpAgent: codeServerHttpAgent,
      httpsAgent: codeServerHttpsAgent,
      timeout: CODE_UPLOAD_BATCH_TIMEOUT_MS,
      maxContentLength: CODE_UPLOAD_BATCH_MAX_BODY_BYTES,
      maxBodyLength: CODE_UPLOAD_BATCH_MAX_BODY_BYTES,
      ...(signal ? { signal } : {}),
    });
    body = response.data;
  } catch (error) {
    if (
      !isAxiosError(error) ||
      error.response?.status !== 400 ||
      !isBatchResponseBody(error.response.data)
    ) {
      throw error;
    }
    body = error.response.data;
  }
  if (!isBatchResponseBody(body)) {
    throw new Error('Unexpected Code API batch upload response');
  }
  return {
    storage_session_id: body.storage_session_id,
    files: alignOutcomes(files, body.files),
  };
}
