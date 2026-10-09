import type { FiltersConfig } from 'librechat-data-provider';
import {
  assertExtractedTextInspectable,
  extractInspectableFileText,
  getFileExtractionLogDetails,
} from './extract';
import { UninspectableFileError } from '~/protection/files';

const strictExtractedTextFilters = {
  files: {
    pii: {
      fields: ['extracted_text'],
      uninspectable: 'block',
    },
  },
} as FiltersConfig;

describe('extracted file text inspection boundary', () => {
  it('removes submitted filenames and raw errors from protected extraction logs', () => {
    const rawFailure = Object.assign(new Error('PRIVATE provider response'), {
      response: { status: 502, data: 'PRIVATE document fragment' },
    });

    const protectedDetails = getFileExtractionLogDetails({
      filters: strictExtractedTextFilters,
      filename: 'PRIVATE-report.pdf',
      fileId: 'server-file-id',
      error: rawFailure,
    });

    expect(protectedDetails).toEqual({
      contentProtected: true,
      fileLabel: 'file_id=server-file-id',
      errorMetadata: { type: 'Error', status: 502 },
    });
    expect(JSON.stringify(protectedDetails)).not.toContain('PRIVATE');

    const compatibilityDetails = getFileExtractionLogDetails({
      filename: 'report.pdf',
      fileId: 'server-file-id',
      error: rawFailure,
    });
    expect(compatibilityDetails).toEqual({
      contentProtected: false,
      fileLabel: '"report.pdf"',
      errorMetadata: rawFailure,
    });
  });

  it('converts strict extraction failures into a stable raw-free policy error', async () => {
    const rawFailure = new Error('PRIVATE parser credential and document fragment');

    await expect(
      extractInspectableFileText({
        filters: strictExtractedTextFilters,
        extract: async () => {
          throw rawFailure;
        },
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      statusCode: 400,
      body: {
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'extracted_text',
      },
    });

    try {
      await extractInspectableFileText({
        filters: strictExtractedTextFilters,
        extract: async () => {
          throw rawFailure;
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(UninspectableFileError);
      expect(JSON.stringify((error as UninspectableFileError).body)).not.toContain('PRIVATE');
    }
  });

  it.each([null, undefined, '', '   '])(
    'fails closed when strict extraction returns %p',
    async (text) => {
      await expect(
        extractInspectableFileText({
          filters: strictExtractedTextFilters,
          extract: async () => (text == null ? text : { text, bytes: text.length }),
        }),
      ).rejects.toBeInstanceOf(UninspectableFileError);
    },
  );

  it('returns inspectable extracted text unchanged', async () => {
    const extracted = { text: 'inspectable text', bytes: 16, filepath: 'doc://result' };

    await expect(
      extractInspectableFileText({
        filters: strictExtractedTextFilters,
        extract: async () => extracted,
      }),
    ).resolves.toBe(extracted);
  });

  it('preserves extraction failures and empty results when fail-close is not selected', async () => {
    const rawFailure = new Error('legacy extraction failure');

    await expect(
      extractInspectableFileText({
        extract: async () => {
          throw rawFailure;
        },
      }),
    ).rejects.toBe(rawFailure);
    await expect(
      extractInspectableFileText({
        extract: async () => ({ text: '   ', bytes: 3 }),
      }),
    ).resolves.toEqual({ text: '   ', bytes: 3 });
  });

  it('guards successful extraction before persistence while preserving compatibility mode', () => {
    expect(() =>
      assertExtractedTextInspectable({
        filters: strictExtractedTextFilters,
        text: '   ',
      }),
    ).toThrow(UninspectableFileError);
    expect(() => assertExtractedTextInspectable({ text: '   ' })).not.toThrow();
    expect(() =>
      assertExtractedTextInspectable({
        filters: strictExtractedTextFilters,
        text: 'inspectable text',
      }),
    ).not.toThrow();
  });
});
