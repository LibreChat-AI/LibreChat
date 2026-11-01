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

const ISO_BMFF_BRAND_MIME_TYPES: Readonly<Record<string, string>> = {
  avif: 'image/avif',
  avis: 'image/avif',
  heic: 'image/heic',
  heim: 'image/heic',
  heis: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
};

/** Reads image signatures without decoding; unknown bytes retain the caller's stored type. */
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
  if (leading.startsWith('RIFF') && leading.slice(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (leading.slice(4, 8) === 'ftyp') {
    const majorType = ISO_BMFF_BRAND_MIME_TYPES[leading.slice(8, 12)];
    if (majorType) {
      return majorType;
    }
    // Generic HEIF brands (mif1/msf1) do not identify a codec. Check compatible brands.
    const boxSize = buffer.readUInt32BE(0);
    if (boxSize < 16 || boxSize > buffer.length) {
      return undefined;
    }
    for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
      const mediaType = ISO_BMFF_BRAND_MIME_TYPES[buffer.toString('latin1', offset, offset + 4)];
      if (mediaType) {
        return mediaType;
      }
    }
    return undefined;
  }
  if (leading.startsWith('II\x2a\x00') || leading.startsWith('MM\x00\x2a')) {
    return 'image/tiff';
  }
  return undefined;
}
