import sharp from 'sharp';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { GeneratedImageDependencies } from './generated';
import { saveGeneratedImage } from './generated';

describe('shared generated image File publisher', () => {
  const req = {
    config: { fileStrategy: FileSources.local } as AppConfig,
    user: { id: 'owner', tenantId: 'tenant' },
  };
  const options = {
    req,
    filename: 'generated',
    endpoint: 'google',
    context: FileContext.image_generation,
  };
  function fixture() {
    const saveBuffer = jest.fn(async () => '/images/owner/generated.png');
    const createFile: jest.MockedFunction<GeneratedImageDependencies['createFile']> = jest.fn(
      async (file, _disableTTL) => file,
    );
    const deps: GeneratedImageDependencies = {
      getExtension: (type) => type.split('/')[1],
      getRetentionExpiry: async () => ({ expiredAt: new Date('2099-01-01') }),
      getStrategy: () => ({ saveBuffer }),
      createFile,
    };
    return { deps, saveBuffer, createFile };
  }
  it('preserves native raster bytes, MIME and dimensions through the ordinary image_generation path', async () => {
    const bytes = await sharp({
      create: { width: 2200, height: 10, channels: 3, background: 'red' },
    })
      .png()
      .toBuffer();
    const { deps, saveBuffer, createFile } = fixture();
    const file = await saveGeneratedImage(
      `data:image/png;base64,${bytes.toString('base64')}`,
      { ...options, preserveOriginal: true },
      deps,
    );
    expect(saveBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', tenantId: 'tenant', buffer: bytes }),
    );
    expect(file).toMatchObject({
      type: 'image/png',
      width: 2200,
      height: 10,
      context: FileContext.image_generation,
      expiredAt: new Date('2099-01-01'),
    });
    expect(createFile).toHaveBeenCalledWith(
      expect.not.objectContaining({ buffer: expect.anything() }),
      true,
    );
    expect(file).not.toHaveProperty('mediaLifecycle');
  });
  it('keeps normal generated-image resizing and records encoded MIME for SVG input', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>',
    );
    const { deps } = fixture();
    const file = await saveGeneratedImage(
      `data:image/svg+xml;base64,${svg.toString('base64')}`,
      options,
      deps,
    );
    expect(file.type).toBe('image/png');
    expect(file.filename).toMatch(/\.png$/);
  });
  it.each([
    ['raw base64', (data: string) => data],
    ['a generic data URL', (data: string) => `data:application/octet-stream;base64,${data}`],
  ])('saves an ordinary generated image sent as %s', async (_label, encode) => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    const { deps } = fixture();
    const file = await saveGeneratedImage(encode(bytes.toString('base64')), options, deps);
    expect(file.type).toBe('image/png');
    expect(file.filename).toMatch(/\.png$/);
  });
  it('rejects active formats and mismatched declared native MIME before writing bytes', async () => {
    const { deps, saveBuffer } = fixture();
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await expect(
      saveGeneratedImage(
        `data:image/jpeg;base64,${bytes.toString('base64')}`,
        { ...options, preserveOriginal: true },
        deps,
      ),
    ).rejects.toThrow('raster MIME');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    await expect(
      saveGeneratedImage(
        `data:image/svg+xml;base64,${svg.toString('base64')}`,
        { ...options, preserveOriginal: true },
        deps,
      ),
    ).rejects.toThrow('raster MIME');
    await expect(
      saveGeneratedImage(bytes.toString('base64'), { ...options, preserveOriginal: true }, deps),
    ).rejects.toThrow('Invalid base64 image');
    expect(saveBuffer).not.toHaveBeenCalled();
  });
});
