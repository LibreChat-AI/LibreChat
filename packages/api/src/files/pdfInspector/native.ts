import type { PageMarkdownResult } from '@firecrawl/pdf-inspector';
import type { DocumentExtractionOptions } from '../documents/nativeProcess';
import {
  MAX_PARSER_OUTPUT_BYTES,
  MAX_PARSER_PAGES,
  PARSER_PAGE_OVERHEAD_BYTES,
  runNativeParserChild,
} from '../documents/nativeProcess';
import { PdfPageLimitError } from '../documents/pdfjs';
import { MAX_PDF_PAGES } from './limits';

/**
 * Runs pdf-inspector's native bindings in a child process.
 *
 * The bindings expose no async variant: every export is a synchronous napi call,
 * so invoking them inline blocks the event loop for the whole parse and stalls
 * every other request on the process. A worker thread keeps the event loop free,
 * but it does not isolate native faults because worker threads share the server
 * process, and terminating a worker cannot preempt a synchronous N-API call.
 *
 * A child process per document provides the required fault boundary: an abort or
 * segmentation fault ends only the parser process, and the parent can forcibly
 * kill a synchronous parse that exceeds the timeout. Callers receive a rejection
 * and can fall back to pdfjs without risking the API process.
 */

/** Bounds a parse that never returns; the main thread is free to fire this timer. The
 * caller's configured deadline replaces it when one is supplied. */
const PDF_CHILD_TIMEOUT_MS = 30_000;

/** Optional scan classification receives its own killable deadline. */
const PDF_CLASSIFIER_TIMEOUT_MS = 15_000;

/**
 * Child body, kept as a string so the bundler emits no second entry point and the
 * path resolution stays valid under Jest, tsdown's CJS bundle, and a published
 * tarball alike. The native module is resolved on the main thread and passed in,
 * so the child never depends on its own working directory.
 */
const CHILD_SOURCE = `
process.once('message', (request) => {
  const fs = require('fs');
  try {
    const native = require(request.modulePath);
    const data = fs.readFileSync(request.path);
    let result;
    if (request.op === 'text') {
      result = { text: native.extractText(data) };
    } else {
      const extraction = native.extractPagesMarkdown(data);
      result = { pages: extraction.pages };
    }
    /* Bounded here so no oversized extraction crosses IPC into the API process. The
     * page count is its own limit: pages that converted to nothing weigh nothing, so
     * byte accounting alone would wave through an arbitrarily long array of them. */
    if (request.op !== 'text' && result.pages.length > request.maxPages) {
      process.send({
        ok: false,
        code: 'PARSER_OUTPUT_LIMIT',
        message:
          'returned ' +
          result.pages.length +
          ' pages, over the ' +
          request.maxPages +
          '-page limit',
      });
      return;
    }
    const bytes =
      request.op === 'text'
        ? __serializedBytes(result.text || '')
        : result.pages.reduce(
            (total, page) =>
              total + __serializedBytes(page.markdown || '') + request.pageOverheadBytes,
            0,
          );
    if (bytes > request.maxOutputBytes) {
      process.send({
        ok: false,
        code: 'PARSER_OUTPUT_LIMIT',
        message:
          'extracted ' +
          Math.round(bytes / (1024 * 1024)) +
          'MB of text, over the ' +
          Math.round(request.maxOutputBytes / (1024 * 1024)) +
          'MB limit',
      });
      return;
    }
    process.send({ ok: true, result });
  } catch (error) {
    process.send({ ok: false, message: error && error.message ? error.message : String(error) });
  }
});
`;

/**
 * The optional classifier runs separately from extraction so its synchronous native
 * call can be killed without discarding pages that were already extracted successfully.
 */
const CLASSIFIER_CHILD_SOURCE = `
process.once('message', (request) => {
  const fs = require('fs');
  try {
    const native = require(request.modulePath);
    const data = fs.readFileSync(request.path);
    const detection = native.detectPdf(data);
    const scannedPages = (detection.ocrReasonsByPage || [])
      .filter((entry) => (entry.reasons || []).some((reason) => request.scanReasons.includes(reason)))
      .map((entry) => entry.page);
    process.send({ ok: true, result: { scannedPages } });
  } catch (error) {
    process.send({ ok: false, message: error && error.message ? error.message : String(error) });
  }
});
`;

interface PdfChildResult {
  pages?: PageMarkdownResult[];
  /** 1-indexed pages the classifier attributes to a scan. */
  scannedPages?: number[];
  text?: string;
}

export interface PdfPageExtraction {
  pages: PageMarkdownResult[];
  scannedPages: number[];
  /** True when no classifier result exists, so selectable text cannot prove completeness. */
  classificationDidNotRun?: boolean;
}

/**
 * Classification reasons that mean "a scan holds content here".
 *
 * An allowlist, not a denylist: the engine also flags pages for text-quality reasons
 * such as `suspected_garbled_text`, which false-positives on dot leaders and dense
 * punctuation. Escalating those would replace a correct extraction with an OCR guess
 * on any document that has a table of contents.
 */
export const SCAN_OCR_REASONS = ['scanned'] as const;

type PdfChildOp = 'pages' | 'text';

function runPdfChild(
  op: PdfChildOp,
  filePath: string,
  signal?: AbortSignal,
  timeoutMs: number = PDF_CHILD_TIMEOUT_MS,
  maxPageCount?: DocumentExtractionOptions['maxPageCount'],
): Promise<PdfChildResult> {
  const modulePath = require.resolve('@firecrawl/pdf-inspector');
  return runNativeParserChild<PdfChildResult>({
    childSource: CHILD_SOURCE,
    parserName: `pdf-inspector ${op}`,
    request: {
      op,
      path: filePath,
      modulePath,
      maxOutputBytes: MAX_PARSER_OUTPUT_BYTES,
      /* The configured page count wins below MAX_PARSER_PAGES; the safety bound wins
       * for an unvalidated direct caller that supplies a larger value. */
      maxPages: Math.min(maxPageCount ?? MAX_PDF_PAGES, MAX_PARSER_PAGES),
      pageOverheadBytes: PARSER_PAGE_OVERHEAD_BYTES,
    },
    timeoutMs,
    signal,
  });
}

function runPdfClassifierChild(
  filePath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<PdfChildResult> {
  const modulePath = require.resolve('@firecrawl/pdf-inspector');
  return runNativeParserChild<PdfChildResult>({
    childSource: CLASSIFIER_CHILD_SOURCE,
    parserName: 'pdf-inspector classifier',
    request: {
      path: filePath,
      modulePath,
      scanReasons: SCAN_OCR_REASONS,
    },
    timeoutMs,
    signal,
  });
}

/** Per-page markdown for a PDF, parsed outside the API process. */
export async function extractPagesMarkdownIsolated(
  filePath: string,
  signal?: AbortSignal,
  timeoutMs: number = PDF_CHILD_TIMEOUT_MS,
  maxPageCount: DocumentExtractionOptions['maxPageCount'] = MAX_PDF_PAGES,
  classifierTimeoutMs: DocumentExtractionOptions['classifierTimeoutMs'] = PDF_CLASSIFIER_TIMEOUT_MS,
): Promise<PdfPageExtraction> {
  const startedAt = Date.now();
  const { pages } = await runPdfChild('pages', filePath, signal, timeoutMs, maxPageCount);
  const extractedPages = pages ?? [];
  if (extractedPages.length > maxPageCount) {
    throw new PdfPageLimitError(extractedPages.length, maxPageCount);
  }
  let scannedPages: number[] = [];
  let classificationDidNotRun = false;
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Document parsing was cancelled');
  }
  if (remainingMs <= 0) {
    classificationDidNotRun = true;
  } else {
    try {
      /* The classifier shares the parse deadline, so a slow classifier cannot outlive
       * the overall budget and delay the upload beyond its configured timeout. */
      const classification = await runPdfClassifierChild(
        filePath,
        Math.min(classifierTimeoutMs, remainingMs),
        signal,
      );
      scannedPages = classification.scannedPages ?? [];
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      /* The extraction stands; what is lost is the only signal that selectable text may
       * sit beside a scan, so the caller is told the document was never classified
       * rather than being handed an empty scan list that reads as "nothing missing". */
      classificationDidNotRun = true;
    }
  }
  return {
    pages: extractedPages,
    scannedPages,
    ...(classificationDidNotRun && { classificationDidNotRun }),
  };
}

/**
 * Whole-document plain text for a PDF, parsed outside the API process.
 *
 * Unlike the per-page markdown extractor, this one re-segments words from glyph
 * positions, which is what makes it readable on documents with a poor OCR layer.
 */
export async function extractTextIsolated(
  filePath: string,
  signal?: AbortSignal,
  timeoutMs: number = PDF_CHILD_TIMEOUT_MS,
): Promise<string> {
  const { text } = await runPdfChild('text', filePath, signal, timeoutMs);
  return text ?? '';
}
