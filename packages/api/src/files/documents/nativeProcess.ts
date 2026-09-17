import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { extname, join } from 'path';
import { spawn } from 'child_process';
import { unlink, writeFile } from 'fs/promises';
import { megabyte } from 'librechat-data-provider';
import { createConcurrencyLimiter } from '~/utils/promise';

/** Native document parsers are CPU and memory intensive even for small uploads. */
const NATIVE_PARSER_CONCURRENCY = 2;

/** Maximum queued uploads in the compatibility-default admission limiter. */
const NATIVE_PARSER_MAX_QUEUED = 6;

/**
 * Largest extraction a child may hand back, matching the limit the upload path applies
 * to the stored text.
 *
 * The caps that bound decompression do not bound conversion: an archive of highly
 * compressible text passes both the per-entry and total inflate limits and still
 * converts to tens of megabytes of Markdown. Enforcing only in the parent means every
 * one of those bytes is serialized through IPC and rebuilt in the API process before
 * anything rejects it, and two children may be doing that at once. The child measures
 * its own output first, so an oversized parse costs a message instead of a copy.
 */
export const MAX_PARSER_OUTPUT_BYTES: number = 15 * megabyte;

/**
 * Per-page envelope charged on top of a page's own text, so a result is measured by
 * what crosses IPC rather than by its content alone. A page object that converted to
 * nothing still costs its keys, its number and its braces in both processes.
 */
export const PARSER_PAGE_OVERHEAD_BYTES = 64;

/**
 * Most pages a page-oriented parser may return.
 *
 * Byte accounting alone does not bound this: a page that produced no text contributes
 * almost nothing, so a document declaring hundreds of thousands of empty pages passes
 * the size cap while serializing an object array that large through IPC and rebuilding
 * it in the API process. A page costs an attacker roughly 110 bytes on disk, so the
 * 15MB upload limit buys well over a hundred thousand of them. The cap sits far above
 * any real document, and the pdfjs fallback refuses anything past 250 pages anyway.
 */
export const MAX_PARSER_PAGES = 10_000;

/**
 * A parser refused because its own output would not fit, not because the document is
 * unreadable. Tag-distinct so callers do not answer it by handing the same document to
 * another unbounded extractor, which is how a bound enforced in a child process gets
 * spent in the API process instead.
 */
export class ParserOutputLimitError extends Error {
  readonly code = 'PARSER_OUTPUT_LIMIT';
  /** The document itself is the problem, so the caller is told to send a smaller one. */
  readonly userErrorStatusCode = 413;
  constructor(message: string) {
    super(message);
    this.name = 'ParserOutputLimitError';
  }
}

/**
 * A parser read the document and it held no extractable text: every engine reports this
 * by returning nothing, and every caller refuses the empty extraction rather than
 * storing it. Coded because the upload router treats it as an outcome — the case a
 * configured OCR service exists for — while a genuine parser failure keeps surfacing as
 * itself. Defined here, beside the other parse-boundary refusal, so both engines and
 * the dispatcher can throw it without importing each other.
 */
export class NoDocumentTextError extends Error {
  readonly code = 'NO_DOCUMENT_TEXT';

  constructor(message = 'No text found in document') {
    super(message);
    this.name = 'NoDocumentTextError';
  }
}

/**
 * What a caller may tune about one extraction, shared by every engine so the dispatcher
 * hands the same object to whichever one claims the document.
 */
export interface DocumentExtractionOptions {
  /** Deadline for the extraction child, in milliseconds. Each engine keeps its own
   * default, which is what a direct caller with no configuration gets. */
  readonly timeoutMs?: number;
  /**
   * Reports a failure the engine recovered from on its own. Recovery means the upload
   * path never sees the error, and only the caller knows whether a filename and a
   * parser's own message may be written to a log: under content protection both are
   * redacted. Without this the engine logs only that it recovered.
   */
  readonly onEngineFallback?: (error: unknown) => void;
  /**
   * How this upload may be named in a log line the engine writes on a path that
   * succeeded. Under content protection the caller's label is an opaque file id, and
   * only the caller knows that; without one an engine names no file at all.
   */
  readonly fileLabel?: string;
  /**
   * Maximum PDF pages accepted by the local parser. Non-PDF engines ignore this option,
   * and the PDF engine supplies its own default when a direct caller omits it.
   */
  readonly maxPageCount?: number;
  /**
   * Maximum PDF pages whose text layer the in-process recovery walk reads when the
   * native engine dropped them. Pages past it are reported as needing OCR, so the cap
   * bounds work rather than deciding what the document is.
   */
  readonly maxRecoveredPageCount?: number;
  /** Maximum decompressed bytes allowed for one ZIP entry, in bytes. */
  readonly archiveEntrySizeLimit?: number;
  /** Maximum decompressed bytes allowed across one ZIP archive, in bytes. */
  readonly archiveTotalSizeLimit?: number;
  /** Maximum number of entries one ZIP archive may hold: every entry costs a stream and
   * an inflate teardown however little it decompresses to. */
  readonly archiveEntryCountLimit?: number;
  /** Maximum whole-document parses allowed to run concurrently. */
  readonly maxConcurrentParsers?: number;
  /** Maximum whole-document parses allowed to wait for a slot. */
  readonly maxQueuedParsers?: number;
  /** Deadline for the optional PDF scan classifier, in milliseconds. */
  readonly classifierTimeoutMs?: number;
}

/**
 * Runs a child parse against a private copy of bytes the caller has already validated.
 *
 * The children take a path and reopen it, and the upload route stages a document at a
 * path derived from its sanitized filename, so two concurrent uploads of the same name
 * by the same user share one staging path. Without this copy the second request can
 * replace those bytes between the zip-decompression guard, which reads the buffer in
 * memory, and the child, which reads the path: the parse would then convert bytes the
 * guard never saw, and persist another request's content.
 */
export async function withStableParserInput<T>(
  bytes: Buffer,
  fileName: string,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const extension = extname(fileName);
  const path = join(tmpdir(), `parser-${randomUUID()}${extension}`);
  await writeFile(path, bytes);
  try {
    return await run(path);
  } finally {
    unlink(path).catch(() => {});
  }
}

/**
 * Matched on the code rather than the class: it arrives from a child process as a wire
 * field, and the same string is what the upload path reads to decide the response.
 */
export function isParserOutputLimit(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PARSER_OUTPUT_LIMIT';
}

/**
 * Uploads waiting for one of those slots. Each waiter is a separate request that has
 * already read its document into memory (up to the parser's 15MB cap) and holds it for
 * the whole wait, and the timeout below only starts once a slot frees, so an unbounded
 * queue turns a burst of uploads into unbounded retained memory. Shedding at the door
 * with a named error is the honest answer: the caller can retry, where an accepted
 * request would have sat behind a queue with no deadline.
 */
type ParserLimiter = <T>(task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
const parserLimiters = new Map<string, ParserLimiter>();

function getParserLimiter(maxConcurrentParsers?: number, maxQueuedParsers?: number) {
  const resolvedConcurrency = maxConcurrentParsers ?? NATIVE_PARSER_CONCURRENCY;
  const resolvedMaxQueued = maxQueuedParsers ?? NATIVE_PARSER_MAX_QUEUED;
  const key = `${resolvedConcurrency}:${resolvedMaxQueued}`;
  let limiter = parserLimiters.get(key);
  if (!limiter) {
    limiter = createConcurrencyLimiter(resolvedConcurrency, {
      maxQueued: resolvedMaxQueued,
      label: 'document parsing',
    });
    parserLimiters.set(key, limiter);
  }
  return limiter;
}

/**
 * Admits one whole document parse, not one child spawn.
 *
 * A PDF parse is a child, then up to 250 pdfjs page reads in this process, then possibly
 * a second child. Holding the slot only for the children would release it while the
 * in-process recovery is still decoding, letting fresh parses start and pile those
 * recoveries up: the expensive half of the pipeline would run unbounded behind a cap
 * that only ever counted the cheap half.
 */
export function withParserAdmission<T>(
  parse: () => Promise<T>,
  signal?: AbortSignal,
  maxConcurrentParsers?: number,
  maxQueuedParsers?: number,
): Promise<T> {
  /* The signal goes to the limiter, not just around the task: a caller that gives up
   * while queued has to leave the queue, or it holds a share of the bound against
   * callers who are still waiting. */
  return getParserLimiter(maxConcurrentParsers, maxQueuedParsers)(parse, signal);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  return reason instanceof Error ? reason : new Error('Document parsing was cancelled');
}

interface NativeParserResponse<T> {
  ok: boolean;
  result?: T;
  message?: string;
  /** Set by a child that refused on its own output bounds rather than on the document. */
  code?: string;
}

/**
 * Injected ahead of every child body so both parsers measure the same thing.
 *
 * `process.send` serializes as JSON, and that is what actually crosses the pipe and is
 * rebuilt in the API process. Measuring the raw string instead undercounts it: a newline
 * doubles, a quote or backslash doubles, and any other control character becomes a
 * six-byte escape, so a document sitting just inside the cap can serialize to several
 * times it. Counted in a single pass rather than by stringifying, because building the
 * escaped copy to measure it would allocate the very thing the cap exists to refuse.
 */
export const CHILD_PRELUDE = `
function __serializedBytes(text) {
  let bytes = 2;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code < 0x20) {
      bytes += code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdfff) {
      const low = code <= 0xdbff ? text.charCodeAt(i + 1) : NaN;
      if (low >= 0xdc00 && low <= 0xdfff) {
        /* One scalar across two UTF-16 units: four bytes, not three each. Charging both
         * halves separately made an emoji-heavy extraction look half again as large as
         * it is, and refused documents comfortably inside the limit. */
        bytes += 4;
        i++;
      } else {
        /* A half with no partner is not encodable, so JSON escapes it instead. */
        bytes += 6;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
`;

interface NativeParserChildOptions {
  childSource: string;
  parserName: string;
  request: Record<string, unknown>;
  timeoutMs: number;
  /** Kills the child when the caller stops waiting, so an abandoned parse frees its slot. */
  signal?: AbortSignal;
}

/**
 * Run one synchronous native parser operation in a child process.
 *
 * Admission is the caller's, via {@link withParserAdmission} around the whole parse, so
 * the timeout here measures only the work it bounds and never a wait for a slot.
 */
export function runNativeParserChild<T>({
  childSource,
  parserName,
  request,
  timeoutMs,
  signal,
}: NativeParserChildOptions): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', CHILD_PRELUDE + childSource], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    let settled = false;
    const finish = (error: Error | null, value?: T) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(value as T);
    };

    const timer = setTimeout(
      () => finish(new Error(`${parserName} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref?.();
    const onAbort = () => finish(abortError(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('message', (message: NativeParserResponse<T>) => {
      if (message.ok) {
        finish(null, message.result);
        return;
      }
      const failure = message.message ?? `${parserName} failed`;
      finish(
        message.code === 'PARSER_OUTPUT_LIMIT'
          ? new ParserOutputLimitError(`${parserName} ${failure}`)
          : new Error(failure),
      );
    });
    child.on('error', (error: Error) => finish(error));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
      finish(
        new Error(
          signal
            ? `${parserName} child exited from signal ${signal}`
            : `${parserName} child exited with code ${code}`,
        ),
      ),
    );
    try {
      child.send(request, (error) => {
        if (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
