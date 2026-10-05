import sharp from 'sharp';
import { EModelEndpoint } from 'librechat-data-provider';
import { createImageTransform, resizeAndConvert, resizeImageBuffer } from './resize';

const image = () =>
  sharp({ create: { width: 2400, height: 1200, channels: 3, background: 'white' } })
    .png()
    .toBuffer();

describe('shared image transforms', () => {
  it.each([
    ['low', 512, 256],
    ['high', 1536, 768],
  ] as const)(
    'preserves existing %s chat image bounds and encoded MIME',
    async (resolution, width, height) => {
      const result = await resizeImageBuffer(await image(), resolution, EModelEndpoint.openAI);
      expect(result).toMatchObject({ width, height, type: 'image/png' });
      expect(result.bytes).toBe(result.buffer.length);
    },
  );

  it('preserves SVG rasterization and configurable output encoding', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
    );
    const raster = await resizeImageBuffer(svg, 'low', EModelEndpoint.openAI);
    expect(raster).toMatchObject({ width: 20, height: 10, type: 'image/png' });
    const converted = await resizeAndConvert({
      inputBuffer: raster.buffer,
      desiredFormat: 'webp',
      width: 10,
    });
    expect(await sharp(converted.buffer).metadata()).toMatchObject({
      format: 'webp',
      width: 10,
      height: 5,
    });
  });

  it('uses the same transform for bounded streaming derivatives without enlarging small originals', async () => {
    const source = await sharp({
      create: { width: 20, height: 10, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const transform = createImageTransform({
      rotate: true,
      resize: { width: 320, height: 320, fit: 'inside', withoutEnlargement: true },
      format: 'jpeg',
      timeoutMs: 1000,
    });
    transform.end(source);
    expect(await sharp(await transform.toBuffer()).metadata()).toMatchObject({
      format: 'jpeg',
      width: 20,
      height: 10,
    });
  });
});
