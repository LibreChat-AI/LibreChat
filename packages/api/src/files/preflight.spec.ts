import { EToolResources, mergeFileConfig } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import { assertUploadContentAllowed, MAX_FILTERABLE_TEXT_BYTES } from './preflight';
import { getContentFilterError } from '../middleware/contentFilter';

const pattern = { id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' };

function filters(
  fields: NonNullable<NonNullable<FiltersConfig['files']>['pii']>['fields'],
  uninspectable?: 'allow' | 'block',
): FiltersConfig {
  return {
    files: {
      pii: { fields, starterPatterns: [], customPatterns: [pattern], uninspectable },
    },
  };
}

const baseInput = {
  fileConfig: mergeFileConfig(undefined),
  ocrConfigured: false,
  ragConfigured: false,
};

describe('upload content preflight', () => {
  it('materializes inspectable upload text once and blocks before processing', async () => {
    const readFile = jest.fn().mockResolvedValue(Buffer.from('contains PRIVATE-TOKEN'));

    await expect(
      assertUploadContentAllowed({
        ...baseInput,
        filters: filters(['content']),
        file: {
          originalname: 'safe.txt',
          mimetype: 'application/octet-stream',
          path: '/tmp/upload',
          size: 64,
        },
        readFile,
      }),
    ).rejects.toMatchObject({ code: 'content_filter_block' });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it('fails closed without reading bytes when the route declares the file opaque', async () => {
    const readFile = jest.fn();

    await expect(
      assertUploadContentAllowed({
        ...baseInput,
        filters: filters(['content'], 'block'),
        file: {
          originalname: 'image.png',
          mimetype: 'image/png',
          path: '/tmp/image',
          size: 64,
        },
        rawFileMode: 'opaque',
        readFile,
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('returns the typed 413 policy error for oversized textual input', async () => {
    let thrown: unknown;
    try {
      await assertUploadContentAllowed({
        ...baseInput,
        filters: filters(['content'], 'block'),
        file: {
          originalname: 'large.txt',
          mimetype: 'text/plain; charset=utf-8',
          path: '/tmp/large',
          size: MAX_FILTERABLE_TEXT_BYTES + 1,
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(getContentFilterError(thrown)).toMatchObject({
      statusCode: 413,
      body: { error: 'content_filter_input_too_large', field: 'content' },
    });
  });

  it('defers supported context-document extraction without reading binary bytes', async () => {
    const readFile = jest.fn();

    await expect(
      assertUploadContentAllowed({
        ...baseInput,
        filters: filters(['extracted_text'], 'block'),
        endpoint: 'agents',
        toolResource: EToolResources.context,
        file: {
          originalname: 'report.pdf',
          mimetype: 'application/pdf',
          path: '/tmp/report',
          size: 64,
        },
        rawFileMode: 'opaque',
        readFile,
      }),
    ).resolves.toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('classifies transcript deferral through the merged STT configuration', async () => {
    await expect(
      assertUploadContentAllowed({
        ...baseInput,
        filters: filters(['transcript'], 'block'),
        endpoint: 'agents',
        toolResource: EToolResources.context,
        file: { originalname: 'audio.mp3', mimetype: 'audio/mpeg' },
      }),
    ).resolves.toBeUndefined();

    await expect(
      assertUploadContentAllowed({
        ...baseInput,
        filters: filters(['transcript'], 'block'),
        endpoint: 'agents',
        toolResource: EToolResources.file_search,
        file: { originalname: 'audio.mp3', mimetype: 'audio/mpeg' },
      }),
    ).rejects.toMatchObject({ code: 'content_filter_uninspectable' });
  });

  it('does not read file bytes for a name-only policy', async () => {
    const readFile = jest.fn();

    await expect(
      assertUploadContentAllowed({
        ...baseInput,
        filters: filters(['name']),
        file: {
          originalname: 'safe.txt',
          mimetype: 'text/plain',
          path: '/tmp/upload',
          size: 64,
        },
        readFile,
      }),
    ).resolves.toBeUndefined();
    expect(readFile).not.toHaveBeenCalled();
  });
});
