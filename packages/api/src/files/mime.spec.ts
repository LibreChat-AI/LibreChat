import sharp from 'sharp';
import { resolveImageMimeType } from './mime';

describe('resolveImageMimeType', () => {
  const encode = async (format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff'): Promise<Buffer> =>
    await sharp({
      create: { width: 8, height: 8, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } },
    })
      [format]()
      .toBuffer();

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
