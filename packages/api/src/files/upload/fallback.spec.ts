import fs from 'fs';
import os from 'os';
import path from 'path';
import type { FiltersConfig } from 'librechat-data-provider';
import type { UploadFallbackTextExtractors } from './fallback';
import {
  UPLOAD_FALLBACK_TEXT_PLANS,
  getUploadFallbackTextPlan,
  resolveUploadFallbackText,
} from './fallback';
import { MAX_STORED_EXTRACTED_TEXT_BYTES } from '~/files/extract';
import { parseDocument } from '~/files/documents/crud';
import { parseTextNative } from '~/files/text';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const csvRoute = {
  deliveryPath: 'none' as const,
  destinationChosen: false,
  isMessageAttachment: true,
  mimeType: 'text/csv',
  endpointConfig: { textFallbackWithoutTools: true },
};

describe('getUploadFallbackTextPlan', () => {
  it('reads a natively textual file left to tools', () => {
    expect(getUploadFallbackTextPlan(csvRoute)).toBe(UPLOAD_FALLBACK_TEXT_PLANS.nativeText);
  });

  it('parses a spreadsheet with the built-in document parser', () => {
    expect(getUploadFallbackTextPlan({ ...csvRoute, mimeType: XLSX_MIME })).toBe(
      UPLOAD_FALLBACK_TEXT_PLANS.documentParser,
    );
  });

  it('runs nothing for a type no built-in extractor can read', () => {
    expect(getUploadFallbackTextPlan({ ...csvRoute, mimeType: 'image/png' })).toBeNull();
    expect(getUploadFallbackTextPlan({ ...csvRoute, mimeType: 'application/zip' })).toBeNull();
  });

  it('runs nothing where the upload endpoint has not enabled the fallback', () => {
    expect(getUploadFallbackTextPlan({ ...csvRoute, endpointConfig: undefined })).toBeNull();
    expect(
      getUploadFallbackTextPlan({
        ...csvRoute,
        endpointConfig: { textFallbackWithoutTools: false },
      }),
    ).toBeNull();
  });

  it('runs nothing for an upload that already reaches the model', () => {
    expect(getUploadFallbackTextPlan({ ...csvRoute, deliveryPath: 'text' })).toBeNull();
    expect(getUploadFallbackTextPlan({ ...csvRoute, deliveryPath: 'provider' })).toBeNull();
  });

  it('runs nothing for a destination the user chose, which no turn re-resolves', () => {
    expect(getUploadFallbackTextPlan({ ...csvRoute, destinationChosen: true })).toBeNull();
  });

  it('runs nothing for a file kept on an agent, which no turn delivers as text', () => {
    expect(getUploadFallbackTextPlan({ ...csvRoute, isMessageAttachment: false })).toBeNull();
  });
});

describe('resolveUploadFallbackText', () => {
  const { mimeType: _mimeType, ...route } = csvRoute;
  const privateTokenFilters: FiltersConfig = {
    files: {
      pii: {
        fields: ['extracted_text'],
        starterPatterns: [],
        customPatterns: [{ id: 'private', label: 'private token', regex: 'PRIVATE-[A-Z]+' }],
      },
    },
  };
  let uploadDir: string;

  beforeAll(() => {
    uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-text-'));
  });

  afterAll(() => {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  });

  /** A CSV upload as multer leaves it; without content, its temporary file is already gone. */
  function csvUpload(name: string, content?: string): Express.Multer.File {
    const filePath = path.join(uploadDir, name);
    if (content != null) {
      fs.writeFileSync(filePath, content);
    }
    return {
      originalname: name,
      path: filePath,
      mimetype: 'text/csv',
      size: content != null ? Buffer.byteLength(content) : 0,
    } as Express.Multer.File;
  }

  /** The real built-in extractors, observed. */
  function spiedExtractors() {
    return {
      parseDocument: jest.fn(parseDocument),
      parseTextNative: jest.fn(parseTextNative),
    } satisfies UploadFallbackTextExtractors;
  }

  it('stores the native text of a CSV without running the document parser', async () => {
    const extractors = spiedExtractors();
    const file = csvUpload('sales.csv', 'region,total\nwest,4');

    await expect(
      resolveUploadFallbackText({ ...route, file, fileId: 'file-1', extractors }),
    ).resolves.toBe('region,total\nwest,4');
    expect(extractors.parseTextNative).toHaveBeenCalledWith(file);
    expect(extractors.parseDocument).not.toHaveBeenCalled();
  });

  it('stores the parsed text of a spreadsheet without decoding its bytes', async () => {
    const extractors = spiedExtractors();
    const file = {
      originalname: 'sample.xlsx',
      path: path.join(__dirname, '../documents/sample.xlsx'),
      mimetype: XLSX_MIME,
    } as Express.Multer.File;

    const text = await resolveUploadFallbackText({
      ...route,
      file,
      fileId: 'file-1',
      extractors,
    });
    /* The parser preserves the workbook's structure as markdown instead of flattening it. */
    expect(text).toContain('## Sheet One');
    expect(text).toContain('| Data | on | first | sheet |');
    expect(text).toContain('## Second Sheet');
    expect(text).toContain('| Second | Sheet |');
    expect(extractors.parseDocument).toHaveBeenCalledWith({ file });
    expect(extractors.parseTextNative).not.toHaveBeenCalled();
  });

  it('extracts nothing when no plan applies', async () => {
    const extractors = spiedExtractors();

    await expect(
      resolveUploadFallbackText({
        ...route,
        isMessageAttachment: false,
        file: csvUpload('kept.csv', 'region,total'),
        fileId: 'file-1',
        extractors,
      }),
    ).resolves.toBeUndefined();
    expect(extractors.parseDocument).not.toHaveBeenCalled();
    expect(extractors.parseTextNative).not.toHaveBeenCalled();
  });

  it('keeps the upload when extraction fails', async () => {
    await expect(
      resolveUploadFallbackText({ ...route, file: csvUpload('missing.csv'), fileId: 'file-1' }),
    ).resolves.toBeUndefined();
  });

  it('stores nothing for text with no content', async () => {
    await expect(
      resolveUploadFallbackText({ ...route, file: csvUpload('blank.csv', '  \n '), fileId: 'f' }),
    ).resolves.toBeUndefined();
  });

  it('stores nothing past the extracted-text storage cap', async () => {
    const extractors: UploadFallbackTextExtractors = {
      parseDocument,
      parseTextNative: async () => ({ text: 'a'.repeat(MAX_STORED_EXTRACTED_TEXT_BYTES + 1) }),
    };

    await expect(
      resolveUploadFallbackText({
        ...route,
        file: csvUpload('huge.csv', 'a'),
        fileId: 'file-1',
        extractors,
      }),
    ).resolves.toBeUndefined();
  });

  it('stores nothing a configured content policy flags, and keeps text it does not', async () => {
    await expect(
      resolveUploadFallbackText({
        ...route,
        file: csvUpload('flagged.csv', 'token,PRIVATE-SECRET'),
        fileId: 'file-1',
        filters: privateTokenFilters,
      }),
    ).resolves.toBeUndefined();
    await expect(
      resolveUploadFallbackText({
        ...route,
        file: csvUpload('clean.csv', 'region,total'),
        fileId: 'file-2',
        filters: privateTokenFilters,
      }),
    ).resolves.toBe('region,total');
  });

  it('stores nothing a blocking policy cannot inspect', async () => {
    const filters: FiltersConfig = {
      files: { pii: { fields: ['extracted_text'], starterPatterns: [], uninspectable: 'block' } },
    };

    await expect(
      resolveUploadFallbackText({
        ...route,
        file: csvUpload('empty.csv', ''),
        fileId: 'file-1',
        filters,
      }),
    ).resolves.toBeUndefined();
  });
});
