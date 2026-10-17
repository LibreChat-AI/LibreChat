import sharp from 'sharp';
import { resolveImageMimeType, sniffImageMimeType } from './mime';

const encode = async (format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff'): Promise<Buffer> =>
  await sharp({
    create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
  })
    [format]()
    .toBuffer();

describe('resolveImageMimeType', () => {
  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['tiff', 'image/tiff'],
  ] as const)('reads %s bytes back as %s', async (format, expected) => {
    const metadata = await sharp(await encode(format)).metadata();
    expect(resolveImageMimeType(metadata)).toBe(expected);
  });

  it('reports the rasterized format for an SVG, not the source format', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8">' +
        '<rect width="8" height="8" fill="red"/></svg>',
    );
    const rasterized = await sharp(svg).resize({ width: 8 }).toBuffer();

    expect((await sharp(svg).metadata()).format).toBe('svg');
    expect(resolveImageMimeType(await sharp(rasterized).metadata())).toBe('image/png');
  });

  it('distinguishes AVIF from HEIC, which share the heif container', () => {
    expect(resolveImageMimeType({ format: 'heif', compression: 'av1' })).toBe('image/avif');
    expect(resolveImageMimeType({ format: 'heif', compression: 'hevc' })).toBe('image/heic');
  });

  it('returns undefined for a format with no media type of its own', () => {
    expect(resolveImageMimeType({ format: 'svg' })).toBeUndefined();
    expect(resolveImageMimeType({ format: 'raw' })).toBeUndefined();
  });

  it('declines to name a heif container whose compression sharp did not report', () => {
    expect(resolveImageMimeType({ format: 'heif' })).toBeUndefined();
    expect(resolveImageMimeType({ format: 'heif', compression: undefined })).toBeUndefined();
  });
});

describe('sniffImageMimeType', () => {
  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['tiff', 'image/tiff'],
  ] as const)('names %s bytes %s without decoding them', async (format, expected) => {
    expect(sniffImageMimeType(await encode(format))).toBe(expected);
  });

  it('agrees with what sharp reads back out of the same bytes', async () => {
    for (const format of ['png', 'jpeg', 'webp', 'gif', 'tiff'] as const) {
      const buffer = await encode(format);
      expect(sniffImageMimeType(buffer)).toBe(resolveImageMimeType(await sharp(buffer).metadata()));
    }
  });

  it('reads the brand of an ISO base media container rather than the container itself', () => {
    const ftyp = (brand: string) =>
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x20]),
        Buffer.from('ftyp', 'latin1'),
        Buffer.from(brand, 'latin1'),
      ]);

    expect(sniffImageMimeType(ftyp('avif'))).toBe('image/avif');
    expect(sniffImageMimeType(ftyp('heic'))).toBe('image/heic');
    expect(sniffImageMimeType(ftyp('mif1'))).toBe('image/heic');
    /** `isom` is a plain MP4; naming it an image is the guess this declines to make. */
    expect(sniffImageMimeType(ftyp('isom'))).toBeUndefined();
  });

  it('names a file by its bytes, not by the extension it was given', async () => {
    const jpegNamedPng = await encode('jpeg');

    expect(sniffImageMimeType(jpegNamedPng)).toBe('image/jpeg');
  });

  it('returns undefined rather than naming bytes it does not recognize', () => {
    expect(sniffImageMimeType(Buffer.from('not an image at all'))).toBeUndefined();
    expect(sniffImageMimeType(Buffer.alloc(0))).toBeUndefined();
    /** Shorter than the longest signature, so there is nothing to match against. */
    expect(sniffImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });

  it('does not mistake a RIFF container that is not a WebP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('WAVE', 'latin1'),
    ]);

    expect(sniffImageMimeType(wav)).toBeUndefined();
  });
});
