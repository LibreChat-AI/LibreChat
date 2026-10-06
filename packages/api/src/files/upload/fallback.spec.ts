import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@librechat/data-schemas';
import { excelFileTypes, fullMimeTypesList, selectBuiltInTextPlan } from 'librechat-data-provider';
import type { FiltersConfig, TextDerivation } from 'librechat-data-provider';
import type { UploadFallbackTextExtractors } from './fallback';
import {
  extractBoundedText,
  UPLOAD_FALLBACK_TEXT_PLANS,
  getUploadFallbackTextPlan,
  matchExtractionFailure,
  resolveUploadFallbackText,
  classifyExtractionFailure,
} from './fallback';
import { DOCUMENT_PARSER_MAX_FILE_SIZE, parseDocument } from '~/files/documents/crud';
import { MAX_STORED_EXTRACTED_TEXT_BYTES } from '~/files/extract';
import { ZipBombError } from '~/files/documents/zipSafety';
import { parseTextNative } from '~/files/text';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
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

  it('runs nothing for an upload left to Run Code, whose text a turn derives later', () => {
    const codePreferred = { reading: { codePreferred: true } };
    expect(getUploadFallbackTextPlan({ ...csvRoute, ...codePreferred })).toBeNull();
    expect(
      getUploadFallbackTextPlan({ ...csvRoute, mimeType: XLSX_MIME, ...codePreferred }),
    ).toBeNull();
    expect(getUploadFallbackTextPlan({ ...csvRoute, reading: { codePreferred: false } })).toBe(
      UPLOAD_FALLBACK_TEXT_PLANS.nativeText,
    );
  });

  it('runs nothing for an upload whose text acquisition kept the original with a marker', () => {
    const failed: TextDerivation = { outcome: 'failed', reason: 'parser', at: 1 };
    const deferred: TextDerivation = { outcome: 'deferred', reason: 'extractor_unavailable' };
    for (const textDerivation of [failed, deferred]) {
      expect(
        getUploadFallbackTextPlan({
          ...csvRoute,
          reading: { codePreferred: false },
          textDerivation,
        }),
      ).toBeNull();
    }
  });

  it('picks the extractor turn-time derivation picks, for every supported type', () => {
    const mimeTypes = new Set([
      ...fullMimeTypesList,
      ...excelFileTypes,
      'text/csv',
      'text/tab-separated-values',
    ]);
    const plans = new Set<string>();
    for (const mimeType of mimeTypes) {
      const plan = getUploadFallbackTextPlan({ ...csvRoute, mimeType });
      expect({ mimeType, plan }).toEqual({ mimeType, plan: selectBuiltInTextPlan(mimeType) });
      if (plan != null) {
        plans.add(plan);
      }
    }
    expect([...plans].sort()).toEqual(Object.values(UPLOAD_FALLBACK_TEXT_PLANS).sort());
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

    await expect(
      resolveUploadFallbackText({ ...route, file, fileId: 'file-1', extractors }),
    ).resolves.toBe('Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n');
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

  it('extracts nothing for a deferred upload', async () => {
    const extractors = spiedExtractors();

    await expect(
      resolveUploadFallbackText({
        ...route,
        reading: { codePreferred: true },
        file: csvUpload('deferred.csv', 'region,total'),
        fileId: 'file-1',
        extractors,
      }),
    ).resolves.toBeUndefined();
    expect(extractors.parseTextNative).not.toHaveBeenCalled();
  });

  it('warns as before for each kind of failure, and stays silent for empty text', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const oversized: UploadFallbackTextExtractors = {
      parseDocument,
      parseTextNative: async () => ({ text: 'a'.repeat(MAX_STORED_EXTRACTED_TEXT_BYTES + 1) }),
    };
    try {
      await resolveUploadFallbackText({ ...route, file: csvUpload('gone.csv'), fileId: 'f1' });
      await resolveUploadFallbackText({
        ...route,
        file: csvUpload('big.csv', 'a'),
        fileId: 'f2',
        extractors: oversized,
      });
      await resolveUploadFallbackText({ ...route, file: csvUpload('none.csv', ' '), fileId: 'f3' });

      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        '[resolveUploadFallbackText] No fallback text for "gone.csv": extraction failed',
        '[resolveUploadFallbackText] No fallback text for "big.csv": extracted text exceeds the storage limit',
      ]);
    } finally {
      warn.mockRestore();
    }
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

describe('extractBoundedText', () => {
  const documentsDir = path.join(__dirname, '../documents');
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounded-text-'));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function upload(name: string, mimetype: string, content: string): Express.Multer.File {
    const filePath = path.join(workDir, name);
    fs.writeFileSync(filePath, content);
    return {
      originalname: name,
      path: filePath,
      mimetype,
      size: Buffer.byteLength(content),
    } as Express.Multer.File;
  }

  const fixture = (name: string, mimetype: string): Express.Multer.File =>
    ({ originalname: name, path: path.join(documentsDir, name), mimetype }) as Express.Multer.File;

  it('returns text within every cap', async () => {
    await expect(
      extractBoundedText({
        file: fixture('sample.xlsx', XLSX_MIME),
        plan: UPLOAD_FALLBACK_TEXT_PLANS.documentParser,
      }),
    ).resolves.toEqual({
      text: 'Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n',
    });
  });

  it('fails empty for blank text and for a document the parser finds no text in', async () => {
    await expect(
      extractBoundedText({
        file: upload('blank.csv', 'text/csv', ' \n '),
        plan: UPLOAD_FALLBACK_TEXT_PLANS.nativeText,
      }),
    ).resolves.toEqual({ failure: 'empty' });
    await expect(
      extractBoundedText({
        file: fixture('empty.docx', DOCX_MIME),
        plan: UPLOAD_FALLBACK_TEXT_PLANS.documentParser,
      }),
    ).resolves.toMatchObject({ failure: 'empty', error: expect.any(Error) });
  });

  it('fails parser for a document the parser cannot read', async () => {
    await expect(
      extractBoundedText({
        file: upload('broken.docx', DOCX_MIME, 'not a zip archive'),
        plan: UPLOAD_FALLBACK_TEXT_PLANS.documentParser,
      }),
    ).resolves.toMatchObject({ failure: 'parser', error: expect.any(Error) });
  });

  it('fails too_large past the parser input cap and past the stored-text cap', async () => {
    await expect(
      extractBoundedText({
        file: { ...fixture('sample.docx', DOCX_MIME), size: DOCUMENT_PARSER_MAX_FILE_SIZE + 1 },
        plan: UPLOAD_FALLBACK_TEXT_PLANS.documentParser,
      }),
    ).resolves.toMatchObject({ failure: 'too_large' });
    await expect(
      extractBoundedText({
        file: upload('huge.csv', 'text/csv', 'a'),
        plan: UPLOAD_FALLBACK_TEXT_PLANS.nativeText,
        extractors: {
          parseDocument,
          parseTextNative: async () => ({ text: 'a'.repeat(MAX_STORED_EXTRACTED_TEXT_BYTES + 1) }),
        },
      }),
    ).resolves.toEqual({ failure: 'too_large' });
  });

  it('fails expansion_limit when the zip guard refuses the archive', async () => {
    const bomb = new ZipBombError('sheet: entry exceeds the 25MB per-entry decompressed cap');

    await expect(
      extractBoundedText({
        file: upload('bomb.xlsx', XLSX_MIME, 'x'),
        plan: UPLOAD_FALLBACK_TEXT_PLANS.documentParser,
        extractors: { parseDocument: () => Promise.reject(bomb), parseTextNative },
      }),
    ).resolves.toEqual({ failure: 'expansion_limit', error: bomb });
  });

  it('refuses text a content policy flags, and text a blocking policy cannot inspect', async () => {
    const flagging: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private token', regex: 'PRIVATE-[A-Z]+' }],
        },
      },
    };
    const blocking: FiltersConfig = {
      files: { pii: { fields: ['extracted_text'], starterPatterns: [], uninspectable: 'block' } },
    };

    await expect(
      extractBoundedText({
        file: upload('flagged.csv', 'text/csv', 'token,PRIVATE-SECRET'),
        filters: flagging,
        plan: UPLOAD_FALLBACK_TEXT_PLANS.nativeText,
      }),
    ).resolves.toEqual({
      failure: 'policy',
      finding: expect.objectContaining({ ruleId: expect.any(String), field: 'extracted_text' }),
    });
    await expect(
      extractBoundedText({
        file: upload('blank-blocked.csv', 'text/csv', ''),
        filters: blocking,
        plan: UPLOAD_FALLBACK_TEXT_PLANS.nativeText,
      }),
    ).resolves.toMatchObject({ failure: 'uninspectable' });
  });
});

describe('classifyExtractionFailure', () => {
  it.each([
    [new ZipBombError('archive: total decompressed size exceeds the 100MB cap'), 'expansion_limit'],
    [new Error('ODT content.xml exceeds the 50MB decompressed limit'), 'expansion_limit'],
    [new Error('File "a.pdf" exceeds the 15MB document parser limit (16MB).'), 'too_large'],
    [new Error('No text found in document'), 'empty'],
    [new Error('Unable to extract text from "a.pdf". It may be image-based.'), 'empty'],
    [new Error('Invalid PDF structure'), 'parser'],
    [Object.assign(new Error('Invalid PDF structure'), { code: 'ERR_OUT_OF_RANGE' }), 'parser'],
    ['not an error', 'parser'],
    [Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }), 'unavailable'],
    [Object.assign(new Error('i/o error'), { code: 'EIO' }), 'unavailable'],
    [Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }), 'unavailable'],
    [Object.assign(new Error('too many open files'), { code: 'EMFILE' }), 'unavailable'],
    [Object.assign(new Error('try again'), { code: 'EAGAIN' }), 'unavailable'],
    [Object.assign(new Error('read failed'), { errno: -5, syscall: 'read' }), 'unavailable'],
    [
      Object.assign(new Error('incorrect header check'), { errno: -3, code: 'Z_DATA_ERROR' }),
      'parser',
    ],
    [
      Object.assign(new ZipBombError('archive: total decompressed size exceeds the 100MB cap'), {
        code: 'EIO',
      }),
      'expansion_limit',
    ],
  ])('classifies %p as %s', (error, reason) => {
    expect(classifyExtractionFailure(error)).toBe(reason);
  });

  it('recognizes only the failures it can name, leaving the rest unclassified', () => {
    expect(matchExtractionFailure(new Error('No text found in document'))).toBe('empty');
    expect(matchExtractionFailure(new Error('Invalid PDF structure'))).toBeUndefined();
    expect(matchExtractionFailure('not an error')).toBeUndefined();
  });
});
