import * as fs from 'fs';
import { logger } from '@librechat/data-schemas';
import { excelFileTypes, DocumentParser } from 'librechat-data-provider';
import type { DocumentExtractionOptions } from '../documents/nativeProcess';
import type { ParsedDocumentUploadResult } from '~/types';
import {
  isParserOutputLimit,
  NoDocumentTextError,
  UnsupportedDocumentTypeError,
  withStableParserInput,
} from '../documents/nativeProcess';
import { assertSafeZipSizeIfArchive } from '../documents/zipSafety';
import { ConcurrencyLimitError } from '~/utils/promise';
import { mayEmbedMedia } from '../documents/media';
import { extractMarkdownIsolated } from './native';

/**
 * MIME types the local AnyDoc path declares support for.
 *
 * Hand-written because neither side can enumerate itself: anydoc's `Format` is a napi
 * `const enum` that resolves to `{}` at runtime, and the platform has no MIME table for
 * the container variants (`.docm`, `.xlsb`, `.ppsx`) that collapse onto those formats.
 * PDF is deliberately excluded even though the upstream library accepts it. LibreChat
 * routes PDFs directly through its richer pdf-inspector adapter, which preserves page
 * accounting and bounded pdfjs recovery.
 */
export const anydocMimeTypes: ReadonlySet<string> = new Set<string>([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.oasis.opendocument.text',
  'application/rtf',
  'text/rtf',
  'application/epub+zip',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.12',
  'application/vnd.oasis.opendocument.presentation',
  ...excelFileTypes,
  'application/vnd.ms-excel.sheet.macroEnabled.12',
  'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/csv',
  'application/csv',
]);

/** MIME types are case-insensitive, so matching happens against a folded copy. */
const foldedMimeTypes: ReadonlySet<string> = new Set<string>(
  [...anydocMimeTypes].map((type) => type.toLowerCase()),
);

const ANYDOC_MIME_FORMATS: Readonly<Record<string, string>> = {
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-word.document.macroenabled.12': 'docx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'application/epub+zip': 'epub',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow': 'pptx',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12': 'pptx',
  'application/vnd.ms-powerpoint.slideshow.macroenabled.12': 'pptx',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'application/msexcel': 'xlsx',
  'application/x-msexcel': 'xlsx',
  'application/x-ms-excel': 'xlsx',
  'application/x-excel': 'xlsx',
  'application/x-dos_ms_excel': 'xlsx',
  'application/xls': 'xlsx',
  'application/x-xls': 'xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': 'xlsx',
  'application/vnd.ms-excel.sheet.binary.macroenabled.12': 'xlsx',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'text/csv': 'csv',
  'application/csv': 'csv',
};

const ANYDOC_EXTENSION_FORMATS: Readonly<Record<string, string>> = {
  doc: 'doc',
  docx: 'docx',
  docm: 'docx',
  odt: 'odt',
  rtf: 'rtf',
  epub: 'epub',
  ppt: 'ppt',
  pps: 'ppt',
  pot: 'ppt',
  pptx: 'pptx',
  pptm: 'pptx',
  ppsx: 'pptx',
  ppsm: 'pptx',
  odp: 'odp',
  xls: 'xlsx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xlsb: 'xlsx',
  ods: 'ods',
  csv: 'csv',
  pdf: 'pdf',
};

const LEGACY_CFB_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/msword',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-excel',
  'application/msexcel',
  'application/x-msexcel',
  'application/x-ms-excel',
  'application/x-excel',
  'application/x-dos_ms_excel',
  'application/xls',
  'application/x-xls',
]);

const LEGACY_CFB_EXTENSIONS: ReadonlySet<string> = new Set(['doc', 'ppt', 'pps', 'pot', 'xls']);
const RTF_MIME_TYPES: ReadonlySet<string> = new Set(['application/rtf', 'text/rtf']);

/**
 * The anydoc format a declared MIME type names, if any.
 *
 * Exported so the dispatcher can ask the same question before choosing an engine: a
 * type this table does not know is not anydoc's, which is what lets a configured PDF
 * alias reach pdf-inspector instead of arriving here to be refused.
 */
export function anydocFormatFromType(mimetype?: string): string | null {
  return ANYDOC_MIME_FORMATS[normalizeType(mimetype)] ?? null;
}

/** Strips any `; charset=` parameter and folds case, so lookups match the table. */
function normalizeType(mimetype?: string): string {
  return (mimetype ?? '').split(';')[0].trim().toLowerCase();
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Pure extension mapping, so loading AnyDoc's native binding stays inside the child. */
function extensionFromPath(name: string): string | undefined {
  return name.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase();
}

function formatFromPath(name: string): string | null {
  const extension = extensionFromPath(name);
  return extension ? (ANYDOC_EXTENSION_FORMATS[extension] ?? null) : null;
}

function declaresLegacyCfbContainer(name: string, type: string): boolean {
  if (ANYDOC_MIME_FORMATS[type] != null) {
    return LEGACY_CFB_MIME_TYPES.has(type);
  }
  const extension = extensionFromPath(name);
  return extension != null && LEGACY_CFB_EXTENSIONS.has(extension);
}

function declaresRtfContainer(name: string, type: string): boolean {
  if (ANYDOC_MIME_FORMATS[type] != null) {
    return RTF_MIME_TYPES.has(type);
  }
  return extensionFromPath(name) === 'rtf';
}

/**
 * The format anydoc should read the file as.
 *
 * A declared type that names a format it supports is the stronger signal, because it
 * describes the bytes; an extension only describes what the file was called. Reading
 * the extension first meant DOCX bytes renamed `report.csv` were handed to the CSV
 * reader, and the same bytes named `.pdf` were refused as belonging to another engine.
 * The extension still decides when the type says nothing useful, which is the ordinary
 * case of a browser sending `application/octet-stream`.
 */
function resolveFormat(name: string, type: string): string | null {
  return ANYDOC_MIME_FORMATS[type] ?? formatFromPath(name);
}

/**
 * Refuses types anydoc cannot read, before the file is loaded from disk.
 *
 * Only the combination of an undeclared MIME type and an extension anydoc does not
 * recognize is a hard failure, because either signal alone is routinely wrong in
 * practice: browsers send `application/octet-stream` for perfectly ordinary office
 * documents, and uploads arrive with no extension at all. When one of the two says
 * the file is supported, the attempt is worth more than the refusal, so it proceeds
 * with a warning and anydoc gets to make the final call from the content itself.
 *
 * @throws {UnsupportedDocumentTypeError} when neither the MIME type nor the extension
 * names a supported format.
 */
function assertSupportedType(
  name: string,
  type: string,
  extensionFormat: string | null,
  warningLabel: string,
): void {
  /* A supported type outranks the name here too: only a file nothing else identifies as
   * an anydoc format is refused for looking like a PDF. */
  if (
    type === 'application/pdf' ||
    (ANYDOC_MIME_FORMATS[type] == null && extensionFormat === 'pdf')
  ) {
    throw new UnsupportedDocumentTypeError(
      `PDF files are handled by pdf-inspector, not anydoc ("${name}").`,
    );
  }
  if (foldedMimeTypes.has(type)) {
    if (extensionFormat == null) {
      logger.warn(
        `[parseWithAnydoc] "${warningLabel}" has no extension anydoc recognizes; falling back to content detection.`,
      );
    }
    return;
  }
  if (extensionFormat != null) {
    logger.warn(
      `[parseWithAnydoc] "${warningLabel}" arrived as "${type || 'no MIME type'}", which anydoc does not declare support for; its extension names "${extensionFormat}", so extraction is attempted anyway.`,
    );
    return;
  }
  throw new UnsupportedDocumentTypeError(
    `Unsupported file type in the anydoc parser: "${type || 'unknown'}" ("${name}").`,
  );
}

/**
 * Converts an uploaded document to Markdown with anydoc, recovering headings, tables
 * and emphasis that plain-text extractors drop.
 *
 * The zip guard runs on the raw buffer before anydoc is handed a single byte, and sits
 * outside the try on purpose. anydoc applies no decompression cap of its own: a 158KB
 * DOCX whose document.xml inflates to 78MB is parsed in full at ~400MB RSS, and the
 * same bomb padded with junk bytes measures 162KB on disk for 80MB of Markdown at
 * ~336MB RSS. A refusal therefore has to propagate as a refusal; reporting it as
 * "anydoc failed" would let the shared parser's fallback chain hand the very file the
 * guard exists to stop to another inflating parser.
 *
 * @throws {Error} when the type is unsupported, the archive fails the zip guard, anydoc
 * throws, or extraction yields nothing.
 */
export async function parseWithAnydoc(
  file: Express.Multer.File,
  signal?: AbortSignal,
  options?: DocumentExtractionOptions,
): Promise<ParsedDocumentUploadResult> {
  const name = file.originalname ?? file.path;
  const warningLabel = options?.fileLabel || 'uploaded document';
  const type = normalizeType(file.mimetype);

  const format = resolveFormat(name, type);
  assertSupportedType(name, type, formatFromPath(name), warningLabel);

  const buffer = await fs.promises.readFile(file.path, { signal });
  let knownOuterContainer: 'cfb' | 'rtf' | undefined;
  if (declaresLegacyCfbContainer(name, type)) {
    knownOuterContainer = 'cfb';
  } else if (declaresRtfContainer(name, type)) {
    knownOuterContainer = 'rtf';
  }
  await assertSafeZipSizeIfArchive(buffer, {
    name,
    ...(knownOuterContainer && { knownOuterContainer }),
    maxEntryBytes: options?.archiveEntrySizeLimit,
    maxTotalBytes: options?.archiveTotalSizeLimit,
    maxEntries: options?.archiveEntryCountLimit,
    signal,
  });
  /* Read from the buffer already in hand, before extraction: anydoc converts artwork
   * to nothing at all, so this is the only record that the Markdown below may be
   * missing what an embedded scan holds. */
  const embedsMedia = await mayEmbedMedia(buffer, signal);

  let markdown: string;
  try {
    markdown = await withStableParserInput(buffer, name, (path) =>
      extractMarkdownIsolated(path, format, signal, options?.timeoutMs),
    );
  } catch (error) {
    /* Shed load and an oversized extraction surface as themselves. Reporting either as
     * a parse failure would send the caller down a fallback chain built for documents
     * this engine cannot read. */
    if (error instanceof ConcurrencyLimitError || isParserOutputLimit(error)) {
      throw error;
    }
    const message = toMessage(error);
    throw new Error(`anydoc failed to extract text from "${name}": ${message}`);
  }

  /* Coded, not generic: a document whose only content is an embedded scan converts to
   * nothing, and that is the case configured OCR exists for. A plain error here would
   * reach the upload router as a parse failure and refuse the document instead. */
  if (!markdown.trim()) {
    throw new NoDocumentTextError(`anydoc extracted no text from "${name}".`);
  }

  return {
    filename: file.originalname,
    bytes: Buffer.byteLength(markdown, 'utf8'),
    filepath: DocumentParser.anydoc,
    text: markdown,
    images: [],
    ...(embedsMedia && { mayOmitContent: true }),
  };
}
