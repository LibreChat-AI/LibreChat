import * as fs from 'fs';
import { megabyte, DocumentParser } from 'librechat-data-provider';
import type { DocumentExtractionOptions } from './nativeProcess';
import type { ParsedDocumentUploadResult } from '~/types';
import { pdfInspectorSupportedMimeTypes, parseWithPdfInspector } from '~/files/pdfInspector';
import { NoDocumentTextError, withParserAdmission } from './nativeProcess';
import { anydocFormatFromType, parseWithAnydoc } from '~/files/anydoc';

/**
 * One local extraction engine, as the dispatcher sees it.
 *
 * The registry below is the only place an engine is named. Adding or replacing one is
 * an entry here plus its adapter: the upload path, the shared MIME contract and the
 * provenance of records another engine produced are all untouched by the swap.
 */
export interface DocumentExtractor {
  /** Recorded on the stored record, so a parse can be traced to the engine that made it. */
  readonly parser: DocumentParser;
  /** Type handed to the engine when it claimed a file by filename rather than by type. */
  readonly canonicalMimeType: string;
  /** Whether this engine reads the declared type, already folded and stripped of parameters. */
  claimsMimeType(mimeType: string): boolean;
  /** Whether this engine reads the file on its name alone, for generic declared types. */
  claimsFileName?(fileName: string): boolean;
  extract(
    file: Express.Multer.File,
    signal?: AbortSignal,
    options?: DocumentExtractionOptions,
  ): Promise<ParsedDocumentUploadResult>;
}

/**
 * Registry order matters in one respect only: the last entry is the general-purpose
 * engine, which answers for any type no other engine claims, including types nothing
 * supports, whose named refusal is then its own rather than a message this dispatcher
 * would have to keep in sync with it.
 */
const documentExtractors: readonly DocumentExtractor[] = [
  {
    parser: DocumentParser.pdf_inspector,
    canonicalMimeType: 'application/pdf',
    claimsMimeType: (mimeType) => pdfInspectorSupportedMimeTypes.some((re) => re.test(mimeType)),
    /* A `.pdf` whose declared type names no other engine is a PDF, whatever that type
     * says. That covers the browser's `application/octet-stream` and equally a PDF alias
     * an operator added to the parser allowlist: admission accepts those, and the type
     * pass above has already given every other engine the chance to claim it. */
    claimsFileName: (fileName) => /\.pdf$/i.test(fileName),
    extract: parseWithPdfInspector,
  },
  {
    parser: DocumentParser.anydoc,
    canonicalMimeType: '',
    claimsMimeType: (mimeType) => anydocFormatFromType(mimeType) != null,
    extract: parseWithAnydoc,
  },
];

/** Picks the engine for a document: declared type first, filename second. */
function routeDocument(
  declaredMimeType: string,
  fileName: string,
): { extractor: DocumentExtractor; mimeType: string } {
  const byType = documentExtractors.find((extractor) => extractor.claimsMimeType(declaredMimeType));
  if (byType) {
    return { extractor: byType, mimeType: declaredMimeType };
  }
  const byFileName = documentExtractors.find((extractor) => extractor.claimsFileName?.(fileName));
  if (byFileName) {
    return { extractor: byFileName, mimeType: byFileName.canonicalMimeType };
  }
  return {
    extractor: documentExtractors[documentExtractors.length - 1],
    mimeType: declaredMimeType,
  };
}

/** Ceiling a caller that supplies no configured limit gets, and the compatibility
 * default of `fileConfig.documentParser.fileSizeLimit`. */
const DOCUMENT_PARSER_MAX_FILE_SIZE = 15 * megabyte;

export class ParserInputLimitError extends Error {
  readonly code = 'PARSER_INPUT_LIMIT';
  readonly userErrorStatusCode = 413;

  constructor(message: string) {
    super(message);
    this.name = 'ParserInputLimitError';
  }
}

/** Cap on pages named in the omission notice, so a mostly-scanned document cannot
 * turn the notice itself into hundreds of KB of text persisted on every turn. */
const MAX_LISTED_MISSING_PAGES = 20;

/** Formats a bounded page list for persistence and logging. */
export function summarizeMissingPages(pagesNeedingOcr: readonly number[]): string {
  const listed = pagesNeedingOcr.slice(0, MAX_LISTED_MISSING_PAGES);
  const remaining = pagesNeedingOcr.length - listed.length;
  return remaining ? `${listed.join(', ')} and ${remaining} more` : listed.join(', ');
}

/**
 * Appends a visible notice naming the pages that hold no extractable text.
 *
 * A part-scanned document otherwise yields partial text with nothing to signal the
 * omission, leaving both the user and the model to treat an incomplete document as
 * complete. Returns `text` unchanged when every page was extracted.
 */
export function annotateMissingPages(text: string, pagesNeedingOcr?: number[]): string {
  if (!pagesNeedingOcr?.length) {
    return text;
  }
  const pages = summarizeMissingPages(pagesNeedingOcr);
  const notice =
    pagesNeedingOcr.length === 1
      ? `Page ${pages} of this document contains no extractable text and was omitted. It is image-based and requires an OCR service to read.`
      : `Pages ${pages} of this document contain no extractable text and were omitted. They are image-based and require an OCR service to read.`;
  return `${text}\n\n[${notice}]\n`;
}

/**
 * Parses an uploaded document with whichever registered engine claims its format,
 * so that a PDF keeps page-level OCR accounting and pdfjs recovery while every other
 * accepted document goes to the general-purpose engine.
 *
 * The administrator-facing `fileConfig.documentParser.supportedMimeTypes` gate is
 * evaluated by the upload router before this function. Each engine still validates
 * its own technical defaults here so direct callers receive a named error.
 */
export async function parseDocument({
  file,
  signal,
  maxFileSize = DOCUMENT_PARSER_MAX_FILE_SIZE,
  timeoutMs,
  maxPageCount,
  maxRecoveredPageCount,
  archiveEntrySizeLimit,
  archiveTotalSizeLimit,
  archiveEntryCountLimit,
  maxConcurrentParsers,
  maxQueuedParsers,
  classifierTimeoutMs,
  fileLabel,
  onEngineFallback,
}: {
  file: Express.Multer.File;
  /** Cancels the parse and frees its admission slot when the caller stops waiting. */
  signal?: AbortSignal;
  /** Largest document to parse, in bytes. Defaults to the parser's own ceiling, which
   * `fileConfig.documentParser.fileSizeLimit` reproduces, so a direct caller that
   * carries no config is still bounded. */
  maxFileSize?: number;
  /** Deadline for the extraction child, in milliseconds. Each engine keeps its own
   * default; `fileConfig.documentParser.timeoutMs` reproduces it. */
  timeoutMs?: number;
  /** Maximum PDF pages to parse. Each engine keeps its own default when omitted. */
  maxPageCount?: number;
  /** Maximum PDF pages the in-process recovery walk reads. Default in the PDF engine. */
  maxRecoveredPageCount?: number;
  /** Maximum decompressed bytes allowed for one ZIP entry, in bytes. */
  archiveEntrySizeLimit?: number;
  /** Maximum decompressed bytes allowed across one ZIP archive, in bytes. */
  archiveTotalSizeLimit?: number;
  /** Maximum entries one ZIP archive may hold. */
  archiveEntryCountLimit?: number;
  /** Maximum whole-document parses allowed to run concurrently. */
  maxConcurrentParsers?: number;
  /** Maximum whole-document parses allowed to wait for a slot. */
  maxQueuedParsers?: number;
  /** Deadline for the optional PDF scan classifier, in milliseconds. */
  classifierTimeoutMs?: number;
  /** How an engine may name this upload in a log line on a path that succeeded. */
  fileLabel?: string;
  /** Told when an engine recovered from a failure on its own, so the caller can log it
   * under whatever redaction its deployment applies. */
  onEngineFallback?: DocumentExtractionOptions['onEngineFallback'];
}): Promise<ParsedDocumentUploadResult> {
  const fileSize = file.size ?? (file.path != null ? (await fs.promises.stat(file.path)).size : 0);
  if (fileSize > maxFileSize) {
    const limitMB = maxFileSize / megabyte;
    const sizeMB = Math.ceil(fileSize / megabyte);
    throw new ParserInputLimitError(
      `File "${file.originalname}" exceeds the ${limitMB}MB document parser limit (${sizeMB}MB).`,
    );
  }

  const declaredMimeType = (file.mimetype ?? '').split(';')[0].trim().toLowerCase();
  const { extractor, mimeType } = routeDocument(declaredMimeType, file.originalname);
  const parserFile = mimeType === file.mimetype ? file : { ...file, mimetype: mimeType };
  /* Admission covers the whole parse. A PDF is a child, then in-process pdfjs
   * recovery, then possibly a second child, and bounding only the children would leave
   * the recovery to pile up behind a cap that never counted it. */
  const result = await withParserAdmission(
    () =>
      extractor.extract(parserFile, signal, {
        timeoutMs,
        maxPageCount,
        maxRecoveredPageCount,
        archiveEntrySizeLimit,
        archiveTotalSizeLimit,
        archiveEntryCountLimit,
        maxConcurrentParsers,
        maxQueuedParsers,
        classifierTimeoutMs,
        fileLabel,
        onEngineFallback,
      }),
    signal,
    maxConcurrentParsers,
    maxQueuedParsers,
  );
  if (!result.text?.trim()) {
    throw new NoDocumentTextError();
  }

  return result;
}
