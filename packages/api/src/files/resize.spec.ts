import sharp from 'sharp';
import { resizeImageToFit } from './resize';

/** Fills a raw RGB buffer with incompressible noise so the encoded PNG stays large. */
function randomRawBuffer(width: number, height: number, channels: 3 | 4 = 3): Buffer {
  const raw = Buffer.allocUnsafe(width * height * channels);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = Math.floor(Math.random() * 256);
  }
  return raw;
}

/** Encodes a noisy PNG large enough to exceed `minBytes`. */
async function createLargePng(minBytes: number): Promise<Buffer> {
  let size = 512;
  for (let attempt = 0; attempt < 6; attempt++) {
    const channels = 3;
    const png = await sharp(randomRawBuffer(size, size, channels), {
      raw: { width: size, height: size, channels },
    })
      .png()
      .toBuffer();
    if (png.length >= minBytes) {
      return png;
    }
    size *= 2;
  }
  throw new Error('Unable to build a sufficiently large PNG fixture');
}

async function createSmallPng(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

describe('resizeImageToFit', () => {
  it('returns the original buffer untouched when it already fits', async () => {
    const small = await createSmallPng();
    const result = await resizeImageToFit(small, 5 * 1024 * 1024);
    expect(result).toBe(small);
  });

  it('returns the original buffer when the limit is not positive', async () => {
    const small = await createSmallPng();
    expect(await resizeImageToFit(small, 0)).toBe(small);
  });

  it('downscales an oversized image to fit within the byte limit', async () => {
    const maxBytes = 200 * 1024;
    const large = await createLargePng(maxBytes * 4);
    expect(large.length).toBeGreaterThan(maxBytes);

    const result = await resizeImageToFit(large, maxBytes);

    expect(result.length).toBeLessThanOrEqual(maxBytes);
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe('png');
    expect(metadata.width).toBeGreaterThan(0);
    expect(metadata.height).toBeGreaterThan(0);
  });

  it('preserves the original aspect ratio while downscaling', async () => {
    const maxBytes = 150 * 1024;
    const width = 1600;
    const height = 800;
    const large = await sharp(randomRawBuffer(width, height), {
      raw: { width, height, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(large.length).toBeGreaterThan(maxBytes);

    const result = await resizeImageToFit(large, maxBytes);
    const metadata = await sharp(result).metadata();

    expect(result.length).toBeLessThanOrEqual(maxBytes);
    const originalRatio = width / height;
    const resizedRatio = (metadata.width ?? 0) / (metadata.height ?? 1);
    expect(Math.abs(resizedRatio - originalRatio)).toBeLessThan(0.1);
  });

  it('returns the input unchanged when it cannot be decoded as an image', async () => {
    const notAnImage = Buffer.from('this is definitely not an image payload', 'utf-8');
    const result = await resizeImageToFit(notAnImage, 4);
    expect(result).toBe(notAnImage);
  });
});
