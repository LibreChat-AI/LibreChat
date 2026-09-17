import type { ParsedDocumentUploadResult } from '~/types';

/**
 * Document types the parser only reformats, whose raw bytes are already the content.
 * Converting a dense CSV to a Markdown table adds pipes and padding to every cell, so a
 * source file inside the storage limit can convert to one that is not.
 */
const delimitedTextTypes = /^(?:text|application)\/csv$/i;

export function isDelimitedTextType(mimeType?: string | null): boolean {
  return delimitedTextTypes.test(mimeType ?? '');
}

/** Error shapes cross process and package boundaries, so both markers are checked. */
function matches(error: unknown, code: string, name: string): boolean {
  const candidate = error as { code?: unknown; name?: unknown } | null | undefined;
  return candidate?.code === code || candidate?.name === name;
}

/**
 * An archive whose decompressed size the guard refused. Never forwarded to another
 * engine: handing the same bytes to a configured OCR provider would send the archive the
 * guard exists to stop to somebody else's parser.
 */
export function isZipBombError(error: unknown): boolean {
  return matches(error, 'ZIP_BOMB', 'ZipBombError');
}

/** An archive the guard identified and then could not walk: past detection there is no
 * third answer, so this is a refusal rather than "this engine could not read it". */
export function isArchiveRefusal(error: unknown): boolean {
  return matches(error, 'ARCHIVE_INVALID', 'ArchiveValidationError');
}

export function isPdfPageLimitError(error: unknown): boolean {
  return matches(error, 'PDF_PAGE_LIMIT', 'PdfPageLimitError');
}

/** Shed load, not an unreadable document. Surfaced to the caller so a retry is the
 * obvious next step, rather than swallowed into a fallback that would bill a configured
 * OCR service, or into "no text found" for a perfectly readable file. */
export function isParserBusyError(error: unknown): boolean {
  return matches(error, 'CONCURRENCY_LIMIT', 'ConcurrencyLimitError');
}

export function isParserInputLimitError(error: unknown): boolean {
  return matches(error, 'PARSER_INPUT_LIMIT', 'ParserInputLimitError');
}

/** The parser declined to hand back an extraction that would not fit. Surfaced rather
 * than swallowed so the file is not reported as unreadable, and so no fallback rebuilds
 * in this process the string a child process just declined to send. */
export function isParserOutputLimitError(error: unknown): boolean {
  return matches(error, 'PARSER_OUTPUT_LIMIT', 'ParserOutputLimitError');
}

/** Not a refusal: the parser ran and the document holds no extractable text. That is the
 * case a configured OCR service exists for. */
export function isNoDocumentTextError(error: unknown): boolean {
  return matches(error, 'NO_DOCUMENT_TEXT', 'NoDocumentTextError');
}

/** A refusal is the parser's own answer about the document, so every caller reports it
 * as itself instead of continuing down a chain built for documents it could not read. */
export function isDocumentParserRefusal(error: unknown): boolean {
  return (
    isZipBombError(error) ||
    isArchiveRefusal(error) ||
    isPdfPageLimitError(error) ||
    isParserBusyError(error) ||
    isParserInputLimitError(error) ||
    isParserOutputLimitError(error)
  );
}

/** Text an extraction produced, plus what it could not read. */
export type ExtractedDocumentText = Pick<
  ParsedDocumentUploadResult,
  'text' | 'pagesNeedingOcr' | 'mayOmitContent'
> & {
  /** Set when the text is the document's own bytes rather than a conversion of them. */
  rawDelimitedText?: boolean;
  [key: string]: unknown;
};

/**
 * A result that names unread pages, or reports embedded artwork the parser converted to
 * nothing, is text with holes in it. Enough to hand a model, not enough to call the
 * document inspected, so every route that persists one fails closed while the
 * uninspectable-content policy is active.
 */
export function isPartialDocumentText(result?: ExtractedDocumentText | null): boolean {
  return !!result?.pagesNeedingOcr?.length || result?.mayOmitContent === true;
}

export interface DocumentExtractionAttempt {
  /** The built-in parser, already bound to the upload. */
  parse: () => Promise<ExtractedDocumentText | undefined>;
  /** A configured OCR service, when one can read this upload. `throwOnMissingCapability`
   * distinguishes the document that has nothing without OCR from the one that would only
   * be completed by it. */
  runConfiguredOCR?: (options: {
    throwOnMissingCapability: boolean;
  }) => Promise<ExtractedDocumentText | undefined>;
  /** The document's own bytes, for a format the parser only reformats. */
  readRawText?: () => Promise<ExtractedDocumentText | undefined>;
  /** Throws when a partial extraction may not be persisted under the active
   * uninspectable-content policy. */
  assertPartialTextAllowed: () => void;
}

/**
 * Runs the extraction engines an upload qualifies for, in the order that yields the most
 * complete text, and decides what counts as a result.
 *
 * The order is the whole point. The built-in parser goes first because it reads the
 * document itself; a configured OCR service is asked only for what the parser could not
 * read, so a part-scanned document comes back whole instead of being re-read by a
 * service that would charge for the pages the parser already had. A parser that refuses
 * an oversized conversion of a format whose bytes are already text yields those bytes,
 * which is the one case where less work produces the better answer.
 *
 * Returns `undefined` when nothing produced text, leaving the refusal to the caller,
 * which owns the message a user sees.
 */
export async function resolveDocumentExtraction(
  attempt: DocumentExtractionAttempt & { delimitedText: boolean },
): Promise<ExtractedDocumentText | undefined> {
  let parsed: ExtractedDocumentText | undefined;
  try {
    parsed = await attempt.parse();
  } catch (error) {
    if (isParserOutputLimitError(error) && attempt.delimitedText) {
      const raw = await attempt.readRawText?.();
      if (raw) {
        return raw;
      }
    }
    throw error;
  }

  const hasText = !!parsed?.text?.trim();
  /* pdf-inspector names unreadable pages. AnyDoc cannot, so it reports whether the
   * document embeds artwork that may carry content it converted to nothing. */
  const needsOCR = !hasText || isPartialDocumentText(parsed);

  if (hasText && !needsOCR) {
    return parsed;
  }

  if (needsOCR && attempt.runConfiguredOCR) {
    const ocr = await attempt.runConfiguredOCR({ throwOnMissingCapability: !hasText });
    if (ocr?.text?.trim()) {
      return ocr;
    }
  }

  if (hasText) {
    attempt.assertPartialTextAllowed();
    return parsed;
  }

  return attempt.delimitedText ? await attempt.readRawText?.() : undefined;
}
