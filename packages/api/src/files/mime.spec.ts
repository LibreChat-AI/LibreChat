import sharp from 'sharp';
import { resolveImageMimeType, sniffImageMimeType } from './mime';

const encode = async (format: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff' | 'avif'): Promise<Buffer> =>
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
  const ftyp = (major: string, ...compatible: string[]): Buffer => {
    const buffer = Buffer.alloc(16 + compatible.length * 4);
    buffer.writeUInt32BE(buffer.length, 0);
    buffer.write('ftyp', 4, 'latin1');
    buffer.write(major, 8, 'latin1');
    compatible.forEach((brand, index) => buffer.write(brand, 16 + index * 4, 'latin1'));
    return buffer;
  };

  it.each([
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['tiff', 'image/tiff'],
  ] as const)('identifies real %s bytes as %s', async (format, expected) => {
    const bytes = await encode(format);
    expect(sniffImageMimeType(bytes)).toBe(expected);
    expect(sniffImageMimeType(bytes)).toBe(resolveImageMimeType(await sharp(bytes).metadata()));
  });

  it.each(['avif', 'avis'])('identifies the explicit AVIF brand %s', (brand) => {
    expect(sniffImageMimeType(ftyp(brand))).toBe('image/avif');
  });

  it.each(['heic', 'heix', 'hevc'])('identifies the explicit HEIC brand %s', (brand) => {
    expect(sniffImageMimeType(ftyp(brand))).toBe('image/heic');
  });

  it.each(['mif1', 'msf1'])('resolves AVIF compatibility behind the generic %s brand', (brand) => {
    expect(sniffImageMimeType(ftyp(brand, 'mif1', 'avif', 'miaf'))).toBe('image/avif');
  });

  it('identifies an encoded AVIF whose major brand is the generic HEIF brand', async () => {
    const buffer = await encode('avif');
    expect(sniffImageMimeType(buffer)).toBe('image/avif');
    const pixels = await sharp(buffer).raw().toBuffer();
    buffer.write('mif1', 8, 'latin1');
    expect(sniffImageMimeType(buffer)).toBe('image/avif');
    expect(await sharp(buffer).raw().toBuffer()).toEqual(pixels);
  });

  it('resolves HEIC compatibility behind a generic HEIF brand', () => {
    expect(sniffImageMimeType(ftyp('mif1', 'mif1', 'heic'))).toBe('image/heic');
  });

  it('does not guess a codec from generic HEIF brands', () => {
    expect(sniffImageMimeType(ftyp('mif1', 'mif1'))).toBeUndefined();
    expect(sniffImageMimeType(ftyp('msf1'))).toBeUndefined();
    expect(sniffImageMimeType(ftyp('isom', 'mp41'))).toBeUndefined();
  });

  it('does not read compatible brands past a truncated or undersized ftyp box', () => {
    const truncated = ftyp('mif1', 'avif');
    truncated.writeUInt32BE(truncated.length + 4, 0);
    const undersized = ftyp('mif1', 'avif');
    undersized.writeUInt32BE(12, 0);
    const trailing = Buffer.concat([ftyp('mif1'), Buffer.from('avif')]);
    expect(sniffImageMimeType(truncated)).toBeUndefined();
    expect(sniffImageMimeType(undersized)).toBeUndefined();
    expect(sniffImageMimeType(trailing)).toBeUndefined();
  });

  it('preserves the stored-type fallback for unknown, short, or non-image bytes', () => {
    expect(sniffImageMimeType(Buffer.from('not an image at all'))).toBeUndefined();
    expect(sniffImageMimeType(Buffer.alloc(0))).toBeUndefined();
    expect(sniffImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(sniffImageMimeType(Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'))).toBeUndefined();
  });
});
