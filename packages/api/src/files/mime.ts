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

/** ISO base media file format brands, read from bytes 8..12 of an `ftyp` box. */
const ISO_BMFF_BRAND_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heim: 'image/heic',
  heis: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  mif1: 'image/heic',
  msf1: 'image/heic',
};

/**
 * Reads the media type of an image out of its leading bytes.
 *
 * {@link resolveImageMimeType} answers the same question, but only where sharp has already decoded
 * the image and reported what it found. The encode path has neither: it holds raw bytes, and it
 * holds them for every image of every turn, so paying for a decode to name a format that the first
 * twelve bytes already state would be a cost per message rather than per upload.
 *
 * Returns `undefined` when nothing matches. An unrecognized container is not evidence that the
 * stored type is wrong, so the caller keeps what it already has rather than guessing.
 */
export function sniffImageMimeType(buffer: Buffer): string | undefined {
  if (buffer.length < 12) {
    return undefined;
  }
  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(4) === 0x0d0a1a0a) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  const leading = buffer.toString('latin1', 0, 12);
  if (leading.startsWith('GIF87a') || leading.startsWith('GIF89a')) {
    return 'image/gif';
  }
  /** A WebP is a RIFF container whose form type, at bytes 8..12, names the payload. */
  if (leading.startsWith('RIFF') && leading.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (leading.slice(4, 8) === 'ftyp') {
    return ISO_BMFF_BRAND_MIME_TYPES[leading.slice(8, 12).toLowerCase()];
  }
  if (leading.startsWith('II\x2a\x00') || leading.startsWith('MM\x00\x2a')) {
    return 'image/tiff';
  }
  return undefined;
}
