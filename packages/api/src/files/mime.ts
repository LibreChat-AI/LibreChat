import type { Metadata } from 'sharp';

/**
 * Media types for the image formats sharp encodes. `heif` covers both AVIF and HEIC, which share
 * a container and are told apart by the compression inside it, so that entry is resolved
 * separately rather than being keyed on the format name alone.
 */
const SHARP_FORMAT_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  gif: 'image/gif',
  jp2: 'image/jp2',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  jxl: 'image/jxl',
  png: 'image/png',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

export type EncodedImageMetadata = Pick<Metadata, 'format' | 'compression'>;

/**
 * Resolves the media type of an encoded image from what sharp read back out of it.
 *
 * Sharp re-encodes whatever it resizes, and the format that comes out need not be the one that
 * went in — an SVG is rasterized to PNG. Recording a caller's declared type against re-encoded
 * bytes leaves a file whose `type` misdescribes its own contents, and that type is later handed
 * to providers verbatim as `media_type`/`mimeType`, so it has to describe the bytes on disk.
 *
 * Returns `undefined` when the bytes cannot be named confidently — a format with no media type of
 * its own, or a heif container whose compression sharp did not report — leaving the caller to fall
 * back to what it already knows. Naming one of those anyway would be the guess this exists to stop.
 */
export function resolveImageMimeType(metadata: EncodedImageMetadata): string | undefined {
  const { format } = metadata;
  if (!format) {
    return undefined;
  }
  if (format === 'heif') {
    if (metadata.compression === 'av1') {
      return 'image/avif';
    }
    return metadata.compression === 'hevc' ? 'image/heic' : undefined;
  }
  return SHARP_FORMAT_MIME_TYPES[format];
}
