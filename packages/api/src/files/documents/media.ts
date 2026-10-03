import yauzl from 'yauzl';
import { isCompoundFileBinary, isRichTextFormat, isZipArchive } from './zipSafety';

/**
 * Artwork, by extension rather than by location.
 *
 * OOXML and ODF do keep pictures in fixed places (`<part>/media/`, `Pictures/`), but
 * those directories also hold audio and video, and a deck with a soundtrack and no scan
 * has nothing for OCR to read. EPUB has no fixed place at all. Matching the extension
 * answers both: it finds an EPUB image wherever the manifest put it, and it leaves
 * `ppt/media/media1.mp4` alone. EMF and WMF are included because Office routinely wraps
 * a scanned page in one. SVG is included because it often carries the only extra text
 * in an otherwise selectable document, and AnyDoc does not read that text.
 */
const IMAGE_ENTRY = /\.(?:jpe?g|png|gif|tiff?|bmp|webp|jp2|jpx|avif|heic|heif|emf|wmf|svg)$/i;

/**
 * Renderings of the document itself rather than content within it. Office writes
 * `docProps/thumbnail.jpeg` and ODF `Thumbnails/thumbnail.png` whenever the "save
 * preview" option is on, so treating them as artwork would send a large share of
 * perfectly ordinary uploads to a paid OCR service for a picture of their own cover.
 */
const PREVIEW_ENTRY = /^(?:docProps|Thumbnails)\//i;

function isMediaEntry(name: string): boolean {
  return IMAGE_ENTRY.test(name) && !PREVIEW_ENTRY.test(name);
}

/** RTF is plain text, and every embedded picture opens with this control word. */
const RTF_PICTURE = Buffer.from('\\pict');

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Media inspection cancelled');
}

function zipContainsMedia(buffer: Buffer, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let zipfile: yauzl.ZipFile | undefined;
    const finish = (found: boolean, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        zipfile?.close();
      } catch {
        /* Best-effort: yauzl throws when closing mid-walk, and the answer is settled. */
      }
      if (error) {
        reject(error);
      } else {
        resolve(found);
      }
    };
    const onAbort = () => finish(false, abortReason(signal as AbortSignal));
    signal?.addEventListener('abort', onAbort, { once: true });

    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, openedZipfile) => {
      if (settled) {
        try {
          openedZipfile?.close();
        } catch {
          /* The aborted walk already settled. */
        }
        return;
      }
      if (err || !openedZipfile) {
        finish(false);
        return;
      }
      zipfile = openedZipfile;

      openedZipfile.on('entry', (entry: yauzl.Entry) => {
        if (isMediaEntry(entry.fileName)) {
          finish(true);
          return;
        }
        openedZipfile.readEntry();
      });
      openedZipfile.on('end', () => finish(false));
      openedZipfile.on('error', () => finish(false));
      openedZipfile.readEntry();
    });
  });
}

/**
 * Whether a document may embed artwork whose content a text converter cannot read.
 *
 * AnyDoc returns Markdown with no page accounting, so a deck of scanned slides comes
 * back looking as complete as one with no images at all. This is the missing-content
 * signal that lets the upload path escalate to a configured OCR service, and its
 * contract is deliberately "may", not "does": a false negative silently loses a
 * scanned page, while a false positive costs one OCR call on a document that had
 * nothing to recover.
 *
 * Each container is answered as precisely as it can be:
 *
 * - Zip-backed (OOXML, ODF, EPUB): the central directory is walked for image entries by
 *   extension. No decompression, and a malformed archive reports `false` because the
 *   zip-bomb guard owns rejection and the parser owns the read error.
 * - RTF: plain text, so the `\pict` control word answers it exactly.
 * - Legacy Office (`.doc`, `.xls`, `.ppt`): pictures live in Escher records inside a
 *   Compound File stream with no addressable name, and no cheap read distinguishes a
 *   scanned page from a document with none. Reported as media so these keep reaching
 *   a configured OCR service, which is what they did before local parsing existed.
 * - Everything else (CSV and other flat text): nothing to embed, so `false`.
 */
export async function mayEmbedMedia(buffer: Buffer, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
  if (isCompoundFileBinary(buffer)) {
    return true;
  }
  if (isRichTextFormat(buffer)) {
    return buffer.includes(RTF_PICTURE);
  }
  if (isZipArchive(buffer)) {
    return zipContainsMedia(buffer, signal);
  }
  return false;
}
