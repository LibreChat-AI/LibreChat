import { logger } from '@librechat/data-schemas';
import { mergeFileConfig } from 'librechat-data-provider';
import type { Response } from 'express';
import type { Readable } from 'stream';
import { convertOfficeToPdf, isLibreOfficeEnabledFor } from './libreoffice';
import { assertSafeZipSize } from './zipSafety';
import { officeHtmlBucket } from './html';

const DEFAULT_PDF_PREVIEW_BYTES = 25 * 1024 * 1024;

/**
 * Convert a stored DOCX / PPTX to PDF for the on-demand `?preview=pdf` route.
 * Returns `null` when the file isn't a deck/document, LibreOffice is off for
 * its format, or conversion fails. Never throws.
 */
export async function officeFileToPdf(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<Buffer | null> {
  const bucket = officeHtmlBucket(filename, mimeType);
  const format = bucket === 'docx' ? 'docx' : 'pptx';
  if ((bucket !== 'docx' && bucket !== 'presentation') || !isLibreOfficeEnabledFor(format)) {
    return null;
  }
  try {
    await assertSafeZipSize(buffer, { name: format });
    return await convertOfficeToPdf(buffer, format);
  } catch (error) {
    logger.warn(
      `[officeFileToPdf] PDF preview failed for "${filename}": ${(error as Error).message}`,
    );
    return null;
  }
}

/** Reads a stream into a Buffer; `null` once it grows past `maxBytes` (the stream is destroyed). */
async function readStreamCapped(stream: Readable, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      stream.destroy();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * Answers a `?preview=pdf` request: reads the stored file (capped at the office preview
 * size limit), converts it, and sends the PDF; 413 when too large, 404 when unconvertible.
 * ponytail: converts on every view; store the PDF next to the file if repeat views get slow.
 */
export async function sendOfficePdfPreview({
  res,
  stream,
  file,
  fileConfig,
}: {
  res: Response;
  stream: Readable;
  file: { filename: string; type: string };
  fileConfig?: Parameters<typeof mergeFileConfig>[0];
}): Promise<void> {
  const buffer = await readStreamCapped(
    stream,
    mergeFileConfig(fileConfig).officePreview?.fileSizeLimit ?? DEFAULT_PDF_PREVIEW_BYTES,
  );
  if (buffer == null) {
    res.status(413).send('File too large for PDF preview');
    return;
  }
  const pdf = await officeFileToPdf(buffer, file.filename, file.type);
  if (pdf == null) {
    res.status(404).send('No PDF preview available');
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
}
