import sharp from 'sharp';
import { convertImageBuffer } from './format';

const jpeg = async (): Promise<Buffer> =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: '#d22' } })
    .jpeg()
    .toBuffer();

describe('convertImageBuffer', () => {
  it('converts JPEG bytes with a PNG filename into an actual PNG', async () => {
    const image = await convertImageBuffer({
      buffer: await jpeg(),
      type: 'image/jpeg',
      fileName: 'photo.png',
      outputType: 'png',
    });

    expect(image.fileName).toBe('photo.png');
    expect((await sharp(image.buffer).metadata()).format).toBe('png');
  });

  it('preserves the buffer when both its type and filename match', async () => {
    const buffer = await jpeg();
    const image = await convertImageBuffer({
      buffer,
      type: 'image/jpeg',
      fileName: 'photo.JPEG',
      outputType: 'jpeg',
    });

    expect(image).toEqual({ buffer, fileName: 'photo.JPEG' });
    expect(image.buffer).toBe(buffer);
  });

  it('converts when the resized format is unknown', async () => {
    const image = await convertImageBuffer({
      buffer: await jpeg(),
      fileName: 'photo.png',
      outputType: 'png',
    });

    expect((await sharp(image.buffer).metadata()).format).toBe('png');
  });

  it.each(['photo.jpg', 'photo', 'photo.png.jpg'])(
    'normalizes the filename %s',
    async (fileName) => {
      const image = await convertImageBuffer({
        buffer: await jpeg(),
        type: 'image/jpeg',
        fileName,
        outputType: 'webp',
      });

      expect(image.fileName).toBe(fileName === 'photo.png.jpg' ? 'photo.png.webp' : 'photo.webp');
      expect((await sharp(image.buffer).metadata()).format).toBe('webp');
    },
  );

  it('propagates unexpected conversion failures', async () => {
    await expect(
      convertImageBuffer({
        buffer: Buffer.from('invalid'),
        fileName: 'photo.png',
        outputType: 'png',
      }),
    ).rejects.toThrow();
  });
});
