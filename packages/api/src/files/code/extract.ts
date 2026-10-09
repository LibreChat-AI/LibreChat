import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { CodeArtifactCategory } from './classify';
import { bufferToOfficeHtml, officeHtmlBucket } from '~/files/documents/html';
import { createConcurrencyLimiter, withTimeout } from '~/utils/promise';
import { parseDocument } from '~/files/documents/crud';
import { isBinaryBuffer } from '~/skills/binary';

export const MAX_TEXT_CACHE_BYTES: number = 512 * 1024;

/** Default inline-preview extraction ceiling: 2 MB. Office/text artifacts
 * larger than this skip inline preview and fall back to download-only. */
const DEFAULT_MAX_TEXT_EXTRACT_BYTES = 2 * 1024 * 1024;

/**
 * Resolve the inline-preview extraction ceiling from
 * `FILE_PREVIEW_MAX_EXTRACT_BYTES`, falling back to the 2 MB default when
 * the value is missing, non-numeric, or non-positive. Raising it lets
 * larger documents render an inline preview; the rendered HTML is still
 * independently capped at {@link MAX_TEXT_CACHE_BYTES} (512 KB), so
 * image-heavy files over that show the "too large" banner instead.
 */
export function resolveMaxTextExtractBytes(value: string | undefined): number {
  if (value == null || value.trim() === '') {
    return DEFAULT_MAX_TEXT_EXTRACT_BYTES;
  }
  /* Floor first, then validate: a fractional value in (0, 1) passes a
   * `> 0` check but floors to 0, which would treat every non-empty
   * artifact as oversized — fall back to the default instead. */
  const floored = Math.floor(Number(value));
  if (!Number.isFinite(floored) || floored < 1) {
    logger.warn(
      `[extract] Invalid FILE_PREVIEW_MAX_EXTRACT_BYTES "${value}"; using ${DEFAULT_MAX_TEXT_EXTRACT_BYTES} bytes.`,
    );
    return DEFAULT_MAX_TEXT_EXTRACT_BYTES;
  }
  return floored;
}

export const MAX_TEXT_EXTRACT_BYTES: number = resolveMaxTextExtractBytes(
  process.env.FILE_PREVIEW_MAX_EXTRACT_BYTES,
);
const DOCUMENT_PARSE_TIMEOUT_MS = 8_000;
const OFFICE_HTML_TIMEOUT_MS = 12_000;
const TRUNCATION_MARKER = '\n\n…[truncated]';
const TRUNCATION_MARKER_BYTES = Buffer.byteLength(TRUNCATION_MARKER, 'utf-8');

/**
 * Cap simultaneous office-HTML renders process-wide. Mammoth (DOCX), SheetJS
 * (XLSX/XLS/ODS), the CSV producer, and the PPTX renderer are CPU-heavy and
 * synchronous; left unbounded, a tool result with N office files fans out
 * into N parallel parses that compete with the still-running agent inference
 * for event-loop time. Two slots keeps a single bursty tool result from
 * starving inference while still allowing meaningful parallelism. Tasks
 * queue in FIFO — none are dropped, only their start is deferred. Shared
 * across every flow: streaming Responses, non-streaming Responses,
 * chat-completions BaseClient, and the `tools.js` direct endpoint all
 * funnel through this module.
 */
const OFFICE_HTML_CONCURRENCY = 2;
const officeHtmlLimit = createConcurrencyLimiter(OFFICE_HTML_CONCURRENCY);

/**
 * Decide whether a buffer is a candidate for rich HTML preview. Wraps the
 * shared `officeHtmlBucket` predicate from `~/files/documents/html` so the
 * gate here stays in lock-step with what the dispatcher will actually
 * route — including extensionless office files identified solely by MIME
 * (e.g. a tool emitting `data` with `text/csv`, which would otherwise
 * classify as `utf8-text`, skip the office gate, and ship raw CSV text
 * to the client's SPREADSHEET bucket that expects full HTML).
 *
 * Exported so `processCodeOutput`'s deferred-preview flow can decide
 * whether to mark a freshly-persisted file record as `status:
 * 'pending'` (preview expected later) or skip the status field
 * entirely (no preview ever expected).
 */
export const hasOfficeHtmlPath = (name: string, mimeType: string): boolean =>
  officeHtmlBucket(name, mimeType) !== null;

/**
 * Classify the format of a string returned by `extractCodeArtifactText`
 * so callers can persist it alongside the text and the client can gate
 * "inject into iframe as HTML" on a trusted signal. Returns:
 *   - `'html'` when the file went down the office-HTML producer path
 *     (output is a complete sanitized HTML document)
 *   - `'text'` for everything else (utf8 plain text, parseDocument
 *     output for PDF/ODT, etc.)
 *   - `null` when there's no text to format (caller should also skip
 *     setting `textFormat` on the record)
 *
 * Inference is by extension/MIME via `officeHtmlBucket`, mirroring the
 * dispatch logic inside `extractCodeArtifactText` exactly. Keeping the
 * inference at the caller (rather than baking format into the
 * extractor's return type) avoids breaking the existing function
 * signature and its 30+ tests, while still giving downstream consumers
 * a definitive trust signal.
 */
export function getExtractedTextFormat(
  name: string,
  mimeType: string,
  text: string | null,
): 'html' | 'text' | null {
  if (text == null) {
    return null;
  }
  return hasOfficeHtmlPath(name, mimeType) ? 'html' : 'text';
}

/**
 * Truncate UTF-8 content to fit within MAX_TEXT_CACHE_BYTES. Walks back to a
 * code-point boundary so the cut never lands inside a multi-byte sequence
 * (which would emit a U+FFFD replacement character — a real concern for CJK
 * and emoji-heavy content). Accepts an optional pre-built buffer to avoid
 * re-encoding when the caller already has one.
 */
const truncate = (text: string, originalBuffer?: Buffer): string => {
  const buffer = originalBuffer ?? Buffer.from(text, 'utf-8');
  if (buffer.length <= MAX_TEXT_CACHE_BYTES) {
    return text;
  }
  let sliceLen = Math.max(0, MAX_TEXT_CACHE_BYTES - TRUNCATION_MARKER_BYTES);
  // UTF-8 continuation bytes match 0b10xxxxxx; keep walking back while the
  // proposed cut would split a sequence.
  while (sliceLen > 0 && (buffer[sliceLen] & 0xc0) === 0x80) {
    sliceLen--;
  }
  return buffer.subarray(0, sliceLen).toString('utf-8') + TRUNCATION_MARKER;
};

const extractUtf8 = (buffer: Buffer): string | null => {
  if (isBinaryBuffer(buffer)) {
    return null;
  }
  if (buffer.length <= MAX_TEXT_CACHE_BYTES) {
    return buffer.toString('utf-8');
  }
  return truncate(buffer.toString('utf-8'), buffer);
};

export function extractCodeArtifactRawText(
  buffer: Buffer,
  category: CodeArtifactCategory,
): string | null {
  if (
    buffer.length > MAX_TEXT_EXTRACT_BYTES ||
    category !== 'utf8-text' ||
    isBinaryBuffer(buffer)
  ) {
    return null;
  }
  return buffer.toString('utf-8');
}

/**
 * Map a known office-document extension back to its canonical MIME so we can
 * route through `parseDocument` even when buffer-sniffing yielded a generic
 * value like `application/zip` or `application/octet-stream`. `parseDocument`
 * dispatches strictly by MIME, so without this remap a `.docx` with a sniffed
 * `application/zip` would silently fall back to `null`.
 */
const documentMimeFromExtension = (name: string): string | null => {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.ods':
      return 'application/vnd.oasis.opendocument.spreadsheet';
    case '.odt':
      return 'application/vnd.oasis.opendocument.text';
    default:
      return null;
  }
};

const extractDocumentText = async (
  buffer: Buffer,
  name: string,
  mimeType: string,
): Promise<string | null> => {
  const canonicalMime = documentMimeFromExtension(name) ?? mimeType;
  const tempPath = path.join(os.tmpdir(), `code-artifact-${randomUUID()}`);
  await fs.writeFile(tempPath, buffer);
  try {
    const result = await withTimeout(
      parseDocument({
        file: {
          path: tempPath,
          size: buffer.length,
          mimetype: canonicalMime,
          originalname: path.basename(name),
        } as Express.Multer.File,
      }),
      DOCUMENT_PARSE_TIMEOUT_MS,
      `parseDocument exceeded ${DOCUMENT_PARSE_TIMEOUT_MS}ms`,
    );
    if (!result?.text) {
      return null;
    }
    return result.text;
  } finally {
    fs.unlink(tempPath).catch(() => {});
  }
};

const extractDocument = async (
  buffer: Buffer,
  name: string,
  mimeType: string,
): Promise<string | null> => {
  const text = await extractDocumentText(buffer, name, mimeType);
  return text == null ? null : truncate(text);
};

/**
 * Minimal valid HTML document substituted when a producer's output
 * exceeds `MAX_TEXT_CACHE_BYTES`. Byte-truncating the producer's HTML
 * would land mid-tag (e.g. `<table><tr><td>con\n…[truncated]`) and the
 * Sandpack iframe would render the malformed markup unpredictably —
 * see review finding #2 on PR #12934. The banner stays under the cap by
 * construction.
 */
const OVERSIZED_HTML_BANNER = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Preview</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#6b7280;padding:16px;font-size:14px;line-height:1.5}@media(prefers-color-scheme:dark){body{color:#9ca3af;background:#1a1a2e}}</style>
</head><body>Preview exceeds the size limit. Download the file to view the full contents.</body></html>`;

/**
 * Render an office-format buffer as a sanitized HTML preview document. Used
 * for docx, xlsx/xls/ods, csv, and pptx — produces interactive HTML the
 * frontend feeds into the Sandpack `static` template via `index.html`.
 *
 * **HTML-or-null contract** (security-critical, do NOT relax). Returns
 * `null` if the file isn't an office type, rendering timed out, or the
 * parser threw. Callers MUST NOT fall back to plain-text extraction on
 * null — the client routes office types into `index.html` and would
 * inject any text-shaped fallback as executable HTML, creating an XSS
 * vector. The pre-fix versions of this function permitted text fallback
 * and that path was a real vulnerability; see Codex P1 review on
 * PR #12934 (commit b06f08a) for the original bug and remediation.
 *
 * On oversized output (>`MAX_TEXT_CACHE_BYTES`), returns a small
 * "preview too large" banner document instead of byte-truncating the
 * producer's HTML — slicing mid-tag would ship malformed markup to the
 * iframe.
 */
const renderOfficeHtml = async (
  buffer: Buffer,
  name: string,
  mimeType: string,
): Promise<string | null> => {
  try {
    const html = await officeHtmlLimit(() =>
      withTimeout(
        bufferToOfficeHtml(buffer, name, mimeType),
        OFFICE_HTML_TIMEOUT_MS,
        `bufferToOfficeHtml exceeded ${OFFICE_HTML_TIMEOUT_MS}ms`,
      ),
    );
    if (html == null) {
      return null;
    }
    if (Buffer.byteLength(html, 'utf-8') > MAX_TEXT_CACHE_BYTES) {
      return OVERSIZED_HTML_BANNER;
    }
    return html;
  } catch (error) {
    logger.debug(
      `[renderOfficeHtml] Failed to render "${name}" (${mimeType}): ${(error as Error).message}`,
    );
    return null;
  }
};

/**
 * Extract a string representation of a code-execution artifact for inline
 * rendering. Returns `null` for binary, oversized, or unsupported files; the
 * caller should fall back to the standard download UI in that case.
 *
 * Office types (docx, xlsx/xls/ods, csv, pptx/potx) are rendered as sanitized
 * HTML by the producers in `~/files/documents/html`. The frontend feeds the
 * HTML into the Sandpack `static` template via `index.html`. CSV is special-
 * cased here — its category is `utf8-text` (raw CSV is text), but we want
 * the styled-table preview when the file extension says CSV.
 *
 * - office (docx/xlsx/xls/ods/csv/pptx/potx): sanitized HTML preview
 * - utf8-text: decodes the buffer (with a binary safety net)
 * - document: dispatches to the existing PDF/ODT parser
 * - other: returns null (binary file, no inline preview)
 */
export async function extractCodeArtifactText(
  buffer: Buffer,
  name: string,
  mimeType: string,
  category: CodeArtifactCategory,
): Promise<string | null> {
  if (buffer.length > MAX_TEXT_EXTRACT_BYTES) {
    return null;
  }
  try {
    /* Office HTML preview is independent of `category` — `officeHtmlBucket`
     * routes by extension OR (parameter-normalized) MIME, and may route
     * inputs the legacy classifier labels as 'other'. Concrete cases:
     *   - extensionless `application/csv` (CSV MIMEs aren't in the
     *     classifier's text-MIME set and don't start with `text/`)
     *   - extensionless office MIMEs with parameters like
     *     `application/vnd...spreadsheetml.sheet; charset=binary`
     * Without checking `hasOfficeHtmlPath` BEFORE the `category === 'other'`
     * early return, those inputs would silently fall back to download-only
     * even though the new dispatcher and the client both expect HTML.
     *
     * For office types it is **HTML-or-null** with no text fallback.
     * The client routes these by extension/MIME to the office preview
     * buckets and feeds `attachment.text` straight into the Sandpack
     * iframe's `index.html`. Substituting plain text on producer failure
     * (timeout, malformed file, zip-bomb rejection) would render literal
     * `<script>` from a DOCX/XLSX/CSV body as executable markup — a
     * direct XSS vector. Returning null here lets the client's empty-
     * text gate keep the artifact off the panel and fall back to the
     * regular download UI, matching what PPTX already does. */
    if (hasOfficeHtmlPath(name, mimeType)) {
      const html = await renderOfficeHtml(buffer, name, mimeType);
      return html;
    }
    if (category === 'other') {
      return null;
    }
    if (category === 'utf8-text') {
      return extractUtf8(buffer);
    }
    if (category === 'document') {
      /* Reaches here only for non-office documents (PDF, ODT) — neither
       * is routed to an HTML preview bucket on the client (PDF has no
       * client routing, ODT routes to PLAIN_TEXT which renders through
       * the markdown viewer with proper escaping). Plain text is safe. */
      return await extractDocument(buffer, name, mimeType);
    }
    /* category === 'presentation' that didn't go through the office HTML path
     * (shouldn't happen — presentation extensions use the office HTML path — but
     * defended in depth). */
    return null;
  } catch (error) {
    logger.debug(
      `[extractCodeArtifactText] Failed to extract "${name}" (${mimeType}): ${(error as Error).message}`,
    );
    return null;
  }
}

export interface CodeArtifactInspectionText {
  readonly text: string | null;
  readonly complete: boolean;
}

/**
 * Extracts text for content inspection independently of the persisted preview
 * cache. Plain text and parsed documents are complete only when their full
 * derived text fits inside the inspection ceiling. Parseable office documents
 * use their full semantic extraction; office preview-only formats retain the
 * available HTML for compatibility-mode inspection but stay marked partial
 * because their producers have independent row, slide, and output caps.
 */
export async function extractCodeArtifactInspectionText(
  buffer: Buffer,
  name: string,
  mimeType: string,
  category: CodeArtifactCategory,
): Promise<CodeArtifactInspectionText> {
  const incomplete = (text: string | null = null): CodeArtifactInspectionText => ({
    text,
    complete: false,
  });
  const bounded = (text: string | null): CodeArtifactInspectionText => {
    if (text == null) {
      return incomplete();
    }
    if (Buffer.byteLength(text, 'utf-8') > MAX_TEXT_EXTRACT_BYTES) {
      return incomplete(truncate(text));
    }
    return {
      text,
      complete: true,
    };
  };
  if (buffer.length > MAX_TEXT_EXTRACT_BYTES) {
    return incomplete();
  }
  try {
    if (hasOfficeHtmlPath(name, mimeType)) {
      if (category === 'utf8-text') {
        return bounded(extractCodeArtifactRawText(buffer, category));
      }
      if (category === 'document') {
        try {
          return bounded(await extractDocumentText(buffer, name, mimeType));
        } catch {
          // Compatibility mode can still inspect the available preview below.
        }
      }
      return incomplete(await renderOfficeHtml(buffer, name, mimeType));
    }
    if (category === 'utf8-text') {
      return bounded(extractCodeArtifactRawText(buffer, category));
    }
    if (category !== 'document') {
      return incomplete();
    }

    return bounded(await extractDocumentText(buffer, name, mimeType));
  } catch {
    logger.debug('[extractCodeArtifactInspectionText] Artifact inspection failed');
    return incomplete();
  }
}
