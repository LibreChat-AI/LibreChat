import { logger } from '@librechat/data-schemas';
import { megabyte } from 'librechat-data-provider';
import type {
  TextItem,
  PDFDocumentProxy,
  TextMarkedContent,
  PDFDocumentLoadingTask,
} from 'pdfjs-dist/types/src/display/api';
import {
  MAX_PARSER_OUTPUT_BYTES,
  ParserOutputLimitError,
  isParserOutputLimit,
} from './nativeProcess';

export type ExtractedDocumentText = {
  text: string;
  pagesNeedingOcr?: number[];
};

/** Hard refusal used to stop page-flooded PDFs from entering another parser. */
export class PdfPageLimitError extends Error {
  /** The document itself is the problem, so the caller is told to send a smaller one. */
  readonly userErrorStatusCode = 413;
  readonly code = 'PDF_PAGE_LIMIT';

  constructor(
    readonly pageCount: number,
    readonly maxPages: number,
  ) {
    super(`PDF contains ${pageCount} pages, exceeding the ${maxPages}-page fallback limit`);
    this.name = 'PdfPageLimitError';
  }
}

/**
 * Flat text extraction with pdfjs, shared by the two callers that need it: the
 * pdf-inspector parser, which repairs the pages that engine drops, and the
 * document parser, whose fallback chain ends here because pdfjs reconstructs
 * damaged xref tables that pdf-inspector rejects outright.
 */

/**
 * Reads the raw text layer of specific 0-indexed pages.
 *
 * Failure here must not fail the document: pages that cannot be recovered are
 * reported in `pagesNeedingOcr` instead, so an unavailable or broken pdfjs
 * degrades to a visible omission notice rather than a parse error.
 *
 * The aggregate is the exception. A page cap says nothing about how much text a page
 * holds, and these strings are retained together in the API process, so passing the
 * bound every other extraction path enforces would leave this one able to spend it.
 * That refusal propagates: unlike an unreadable page, it is not something an omission
 * notice can honestly describe.
 */
export async function extractPageText(
  data: Buffer,
  pageIndexes: number[],
  maxBytes = MAX_PARSER_OUTPUT_BYTES,
  signal?: AbortSignal,
): Promise<Map<number, string>> {
  const texts = new Map<number, string>();
  let textBytes = 0;
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let stopLoading: (() => void) | undefined;
  try {
    throwIfAborted(signal);
    // Imported inline so that Jest can test other routes without failing due to loading ESM
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    throwIfAborted(signal);
    loadingTask = getDocument({ data: new Uint8Array(data) });
    stopLoading = watchForAbort(loadingTask, signal);
    const pdf: PDFDocumentProxy = await loadingTask.promise;
    /* Loading a slow or malformed document is itself long work, so the wait for it has
     * to be interruptible too: checking only in the page loop below would let an
     * abandoned parse hold its admission slot for as long as the document takes to open. */
    throwIfAborted(signal);

    for (const pageIndex of pageIndexes) {
      /* Checked per page rather than once: this walk is the long half of the parse, and
       * a caller that gave up should stop paying for it at the next page, not the last. */
      throwIfAborted(signal);
      try {
        const page = await pdf.getPage(pageIndex + 1);
        const textContent = await page.getTextContent();
        const pageText = joinTextItems(textContent.items);
        textBytes += Buffer.byteLength(pageText, 'utf8');
        if (textBytes > maxBytes) {
          throw new ParserOutputLimitError(
            `pdfjs recovered over the ${Math.round(maxBytes / megabyte)}MB limit by page ${pageIndex + 1}`,
          );
        }
        texts.set(pageIndex, pageText);
      } catch (error) {
        if (signal?.aborted || isParserOutputLimit(error) || isAbort(error)) {
          throw error;
        }
        /* An unreadable page is reported in pagesNeedingOcr rather than failing the document. */
      }
    }
  } catch (error) {
    if (signal?.aborted || isParserOutputLimit(error) || isAbort(error)) {
      throw error;
    }
    logger.warn('[pdfjs] unavailable for page recovery:', error);
  } finally {
    stopLoading?.();
    /* pdfjs holds the decoded document and its worker until the loading task is
     * destroyed; without this the buffer stays reachable for the whole request. */
    await loadingTask?.destroy();
  }
  return texts;
}

/**
 * Reads the raw text layer in document order, up to `maxPages`.
 *
 * A document above the limit is rejected before visiting any page. Building an
 * omitted-page array would itself be unbounded for a hostile page count, while
 * silently returning the first pages would make incomplete text look complete.
 *
 * Output is bounded as it accumulates, for the same reason the native children bound
 * theirs: page count says nothing about how much text a page holds, and this one runs
 * in the API process, where the string is built before any caller can reject it.
 */
export async function extractDocumentTextWithPages(
  data: Buffer,
  maxPages = Number.POSITIVE_INFINITY,
  maxBytes = MAX_PARSER_OUTPUT_BYTES,
  signal?: AbortSignal,
): Promise<ExtractedDocumentText> {
  // Imported inline so that Jest can test other routes without failing due to loading ESM
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  throwIfAborted(signal);

  const loadingTask = getDocument({ data: new Uint8Array(data) });
  const stopLoading = watchForAbort(loadingTask, signal);
  try {
    const pdf: PDFDocumentProxy = await loadingTask.promise;
    throwIfAborted(signal);
    if (pdf.numPages > maxPages) {
      throw new PdfPageLimitError(pdf.numPages, maxPages);
    }

    let fullText = '';
    let textBytes = 0;
    const pagesNeedingOcr: number[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      throwIfAborted(signal);
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = joinTextItems(textContent.items);
      if (!pageText.trim()) {
        pagesNeedingOcr.push(i);
      }
      textBytes += Buffer.byteLength(pageText, 'utf8') + 1;
      if (textBytes > maxBytes) {
        throw new ParserOutputLimitError(
          `pdfjs extracted over the ${Math.round(maxBytes / megabyte)}MB limit by page ${i}`,
        );
      }
      fullText += pageText + '\n';
    }

    return {
      text: fullText,
      pagesNeedingOcr: pagesNeedingOcr.length ? pagesNeedingOcr : undefined,
    };
  } finally {
    stopLoading();
    await loadingTask.destroy();
  }
}

/** Compatibility wrapper for callers that only need aggregate text. */
export async function extractDocumentText(
  data: Buffer,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<string> {
  return (await extractDocumentTextWithPages(data, maxPages)).text;
}

/** Tagged so the page loops can tell a cancellation apart from an unreadable page. */
class PdfExtractionAbortError extends Error {
  readonly code = 'PARSE_ABORTED';
  constructor() {
    super('PDF extraction was cancelled');
    this.name = 'PdfExtractionAbortError';
  }
}

function isAbort(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'PARSE_ABORTED';
}

/**
 * Tears the document down as soon as the caller gives up, so the wait for a slow or
 * malformed one ends with them rather than outliving them. Returns the unsubscribe,
 * which callers run in their `finally` so a completed parse leaves no listener behind.
 */
function watchForAbort(loadingTask: PDFDocumentLoadingTask, signal?: AbortSignal): () => void {
  if (!signal) {
    return () => {};
  }
  const onAbort = () => {
    void loadingTask.destroy().catch(() => {
      /* Already torn down or never opened; the rejection the caller sees is the abort. */
    });
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new PdfExtractionAbortError();
  }
}

/** Marked content items carry no `str`, so only genuine text items contribute. */
function joinTextItems(items: (TextItem | TextMarkedContent)[]): string {
  return items
    .filter((item): item is TextItem => !('type' in item))
    .map((item) => item.str)
    .join(' ');
}
