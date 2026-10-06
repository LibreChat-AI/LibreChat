import fs from 'fs';
import os from 'os';
import path from 'path';
import { logger } from '@librechat/data-schemas';
import type { EndpointFileConfig, FiltersConfig, TextDerivation } from 'librechat-data-provider';
import type { ResolveUploadReadingInput, ResolvedUploadReading } from './upload';
import {
  logUploadReading,
  acquireUploadText,
  orderToolsForReading,
  resolveUploadReading,
  getUploadReadingMetadata,
  ExtractorUnavailableError,
  resolveUploadCodePossible,
} from './upload';
import { UninspectableFileError, ContentFilterInputTooLargeError } from '~/protection/files';
import { extractFileContent } from '~/protection/adapters/submissions';
import { UnsupportedProviderAudioError } from '~/files/upload/errors';
import { MAX_STORED_EXTRACTED_TEXT_BYTES } from '~/files/extract';
import { ContentFilterError } from '~/middleware/contentFilter';
import { ZipBombError } from '~/files/documents/zipSafety';
import { parseDocument } from '~/files/documents/crud';
import { inspectContent } from '~/protection/runtime';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PDF = 'application/pdf';
const CSV = 'text/csv';

const automatic: EndpointFileConfig = { llmDeliveryPolicy: 'automatic' };
const extractedTextBlock: FiltersConfig = {
  files: { pii: { fields: ['extracted_text'], starterPatterns: [], uninspectable: 'block' } },
};
const contentAndTextBlock: FiltersConfig = {
  files: {
    pii: { fields: ['content', 'extracted_text'], starterPatterns: [], uninspectable: 'block' },
  },
};
const privateTokenFilters: FiltersConfig = {
  files: {
    pii: {
      fields: ['extracted_text'],
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private token', regex: 'PRIVATE-[A-Z]+' }],
    },
  },
};

function decide(
  overrides: Partial<ResolveUploadReadingInput> & Pick<ResolveUploadReadingInput, 'mimeType'>,
  codePossible = true,
) {
  const resolveCodePossible = jest.fn(async () => codePossible);
  const reading = resolveUploadReading({
    endpoint: 'openAI',
    endpointConfig: automatic,
    isMessageAttachment: true,
    resolveCodePossible,
    ...overrides,
  });
  return { reading, resolveCodePossible };
}

describe('resolveUploadReading', () => {
  it('leaves a workbook to Run Code when code is possible, deferring its text', async () => {
    const { reading, resolveCodePossible } = decide({ mimeType: XLSX });

    await expect(reading).resolves.toEqual({
      path: 'none',
      policy: 'automatic',
      category: 'tabular',
      reason: 'code_preferred',
      codePreferred: true,
      needsCodeAvailability: false,
      keepOriginalOnExtractionFailure: false,
      deferredMarker: true,
      mimeType: XLSX,
    });
    expect(resolveCodePossible).toHaveBeenCalledTimes(1);
  });

  it('extracts a workbook at upload when code is not possible, keeping it on failure', async () => {
    const { reading, resolveCodePossible } = decide({ mimeType: XLSX }, false);

    await expect(reading).resolves.toMatchObject({
      path: 'text',
      reason: 'code_unavailable',
      codePreferred: false,
      keepOriginalOnExtractionFailure: true,
      deferredMarker: false,
    });
    expect(resolveCodePossible).toHaveBeenCalledTimes(1);
  });

  it('never asks about code for documents, which keep their original on failure', async () => {
    for (const mimeType of [PDF, DOCX, 'application/zip']) {
      const { reading, resolveCodePossible } = decide({ mimeType });
      await expect(reading).resolves.toMatchObject({
        reason: 'automatic_default',
        category: 'document',
        codePreferred: false,
        keepOriginalOnExtractionFailure: true,
        deferredMarker: false,
      });
      expect(resolveCodePossible).not.toHaveBeenCalled();
    }
  });

  it('extracts at upload, and rejects on failure, where extraction is the inspection', async () => {
    for (const mimeType of [XLSX, DOCX]) {
      const { reading, resolveCodePossible } = decide({ mimeType, filters: extractedTextBlock });
      await expect(reading).resolves.toMatchObject({
        path: 'text',
        codePreferred: false,
        keepOriginalOnExtractionFailure: false,
        deferredMarker: false,
      });
      expect(resolveCodePossible).not.toHaveBeenCalled();
    }
    await expect(
      decide({ mimeType: XLSX, filters: extractedTextBlock }).reading,
    ).resolves.toMatchObject({ reason: 'inspection_requires_text' });
  });

  it('still defers where a blocked content field, not extraction, is the inspection', async () => {
    await expect(
      decide({ mimeType: XLSX, filters: contentAndTextBlock }).reading,
    ).resolves.toMatchObject({ reason: 'code_preferred', codePreferred: true });
    await expect(
      decide({ mimeType: XLSX, filters: privateTokenFilters }).reading,
    ).resolves.toMatchObject({ reason: 'code_preferred', codePreferred: true });
  });

  it('keeps a classic row classic without asking about code', async () => {
    const { reading, resolveCodePossible } = decide({ mimeType: XLSX, endpointConfig: undefined });

    await expect(reading).resolves.toMatchObject({
      reason: 'classic_policy',
      codePreferred: false,
      keepOriginalOnExtractionFailure: false,
      deferredMarker: false,
    });
    expect(resolveCodePossible).not.toHaveBeenCalled();
  });
});

describe('resolveUploadCodePossible', () => {
  function resolvers({ capability = true, grant }: { capability?: boolean; grant?: boolean }) {
    return {
      checkCodeCapability: jest.fn(async () => capability),
      getRunCodeGrant: jest.fn(async () => grant),
    };
  }

  it.each([
    [['file_search', 'execute_code'], true],
    [['file_search'], false],
    [[], false],
  ])(
    'reads saved agent tools %p as %p, with no capability or role read',
    async (tools, expected) => {
      const saved = resolvers({});
      await expect(resolveUploadCodePossible({ agentTools: tools, ...saved })).resolves.toBe(
        expected,
      );
      expect(saved.checkCodeCapability).not.toHaveBeenCalled();
      expect(saved.getRunCodeGrant).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, undefined, true],
    [true, true, true],
    [true, false, false],
    [false, undefined, false],
    [false, true, false],
  ])(
    'reads an ephemeral agent from capability %p and grant %p as %p',
    async (capability, grant, expected) => {
      const ephemeral = resolvers({ capability, grant });
      await expect(resolveUploadCodePossible(ephemeral)).resolves.toBe(expected);
      expect(ephemeral.checkCodeCapability).toHaveBeenCalledTimes(1);
    },
  );
});

describe('orderToolsForReading', () => {
  const tools = ['file_search', 'execute_code', 'web_search'];

  it('files a code-preferred upload under Run Code first', () => {
    expect(orderToolsForReading({ codePreferred: true }, tools)).toEqual([
      'execute_code',
      'file_search',
      'web_search',
    ]);
  });

  it('leaves the order alone otherwise', () => {
    expect(orderToolsForReading({ codePreferred: false }, tools)).toBe(tools);
    const withoutCode = ['file_search'];
    expect(orderToolsForReading({ codePreferred: true }, withoutCode)).toBe(withoutCode);
    expect(orderToolsForReading({ codePreferred: true }, undefined)).toBeUndefined();
  });
});

describe('acquireUploadText', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-reading-'));
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const keep = (mimeType: string): ResolvedUploadReading => ({
    path: 'text',
    policy: 'automatic',
    category: 'document',
    reason: 'automatic_default',
    codePreferred: false,
    needsCodeAvailability: false,
    keepOriginalOnExtractionFailure: true,
    deferredMarker: false,
    mimeType,
  });
  const classic = (mimeType: string): ResolvedUploadReading => ({
    ...keep(mimeType),
    policy: 'classic',
    reason: 'classic_policy',
    keepOriginalOnExtractionFailure: false,
  });

  /** The real document parser over a file written to disk. */
  function parse(name: string, mimetype: string, content: string | Buffer) {
    const filePath = path.join(workDir, name);
    fs.writeFileSync(filePath, content);
    const file = { originalname: name, path: filePath, mimetype } as Express.Multer.File;
    return async () => ({ text: (await parseDocument({ file })).text });
  }

  const failedWith = (reason: TextDerivation['reason'], extractor = 'document_parser') => ({
    textDerivation: { outcome: 'failed', extractor, reason, at: expect.any(Number) },
    path: 'none',
  });
  const deferredWith = (textDerivation: Omit<TextDerivation, 'outcome' | 'at'>) => ({
    textDerivation: { outcome: 'deferred', ...textDerivation, at: expect.any(Number) },
    path: 'none',
  });
  const fileId = 'file-1';

  it('passes text and errors through unchanged where failure rejects the upload', async () => {
    const acquired = { text: 'a'.repeat(MAX_STORED_EXTRACTED_TEXT_BYTES + 1) };
    await expect(
      acquireUploadText({ fileId, reading: classic('text/csv'), acquire: async () => acquired }),
    ).resolves.toBe(acquired);
    await expect(
      acquireUploadText({
        fileId,
        reading: classic(DOCX),
        acquire: parse('broken.docx', DOCX, 'no zip'),
      }),
    ).rejects.toThrow();
    const empty = { text: '' };
    await expect(
      acquireUploadText({ fileId, reading: classic('text/csv'), acquire: async () => empty }),
    ).resolves.toBe(empty);
  });

  it('returns acquired text within the caps unchanged', async () => {
    const acquired = { text: 'region,total', isTranscript: false };
    await expect(
      acquireUploadText({ fileId, reading: keep('text/csv'), acquire: async () => acquired }),
    ).resolves.toBe(acquired);
  });

  it('keeps the original, deferred for a later turn, when extraction fails unrecognized', async () => {
    const warn = jest.spyOn(logger, 'warn');
    try {
      await expect(
        acquireUploadText({
          fileId,
          reading: keep(DOCX),
          acquire: parse('broken.docx', DOCX, 'no zip'),
        }),
      ).resolves.toEqual(deferredWith({ reason: 'parser' }));
      await expect(
        acquireUploadText({
          fileId,
          reading: keep(PDF),
          acquire: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:8000')),
        }),
      ).resolves.toEqual(deferredWith({ reason: 'parser' }));
      expect(warn).toHaveBeenCalledWith(
        '[uploadReading] file_id=file-1 extraction=deferred failure=parser',
        expect.objectContaining({ type: expect.any(String) }),
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('10.0.0.5');
      await expect(
        acquireUploadText({
          fileId,
          reading: keep(PPTX),
          acquire: () => Promise.reject(new TypeError('cannot read properties of undefined')),
        }),
      ).resolves.toEqual(failedWith('parser', 'configured'));
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the original, marked failed, when a built-in extractor names its failure', async () => {
    await expect(
      acquireUploadText({
        fileId,
        reading: keep(DOCX),
        acquire: parse(
          'empty.docx',
          DOCX,
          fs.readFileSync(path.join(__dirname, '../documents/empty.docx')),
        ),
      }),
    ).resolves.toEqual(failedWith('empty'));
    await expect(
      acquireUploadText({
        fileId,
        reading: keep(XLSX),
        acquire: () => Promise.reject(new ZipBombError('sheet: entry exceeds the cap')),
      }),
    ).resolves.toEqual(failedWith('expansion_limit'));
  });

  it('treats the stored-text cap and empty text as soft failures', async () => {
    await expect(
      acquireUploadText({
        fileId,
        reading: keep('text/csv'),
        acquire: async () => ({ text: 'a'.repeat(MAX_STORED_EXTRACTED_TEXT_BYTES + 1) }),
      }),
    ).resolves.toEqual(failedWith('too_large', 'native_text'));
    await expect(
      acquireUploadText({
        fileId,
        reading: keep('text/csv'),
        acquire: async () => ({ text: ' \n' }),
      }),
    ).resolves.toEqual(failedWith('empty', 'native_text'));
  });

  it('defers when only a configured step was unavailable and a built-in extractor exists', async () => {
    await expect(
      acquireUploadText({
        fileId,
        reading: keep(PDF),
        acquire: () =>
          Promise.reject(
            new ExtractorUnavailableError(
              'OCR capability is not enabled for Agents',
              'extractor_unavailable',
            ),
          ),
      }),
    ).resolves.toEqual(deferredWith({ extractor: 'configured', reason: 'extractor_unavailable' }));
    await expect(
      acquireUploadText({
        fileId,
        reading: keep(PPTX),
        acquire: () =>
          Promise.reject(
            new ExtractorUnavailableError(
              `File type ${PPTX} is not supported for text parsing.`,
              'no_extractor',
            ),
          ),
      }),
    ).resolves.toEqual(failedWith('no_extractor', 'configured'));
    /* A type the text allowlist excludes stays failed even where a built-in extractor exists. */
    await expect(
      acquireUploadText({
        fileId,
        reading: keep(CSV),
        acquire: () =>
          Promise.reject(
            new ExtractorUnavailableError(
              `File type ${CSV} is not supported for text parsing.`,
              'no_extractor',
            ),
          ),
      }),
    ).resolves.toEqual(failedWith('no_extractor', 'configured'));
  });

  it('rejects an unavailable configured step unchanged where failure rejects the upload', async () => {
    const error = new ExtractorUnavailableError(
      'OCR capability is not enabled for Agents',
      'extractor_unavailable',
    );
    await expect(
      acquireUploadText({ fileId, reading: classic(PDF), acquire: () => Promise.reject(error) }),
    ).rejects.toBe(error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('OCR capability is not enabled for Agents');
  });

  it('fails closed on text a blocking policy cannot inspect before it counts as empty', async () => {
    for (const text of ['', '  \n']) {
      await expect(
        acquireUploadText({
          fileId,
          reading: keep(DOCX),
          filters: contentAndTextBlock,
          acquire: async () => ({ text }),
        }),
      ).rejects.toBeInstanceOf(UninspectableFileError);
    }
    await expect(
      acquireUploadText({
        fileId,
        reading: keep(DOCX),
        filters: privateTokenFilters,
        acquire: async () => ({ text: ' ' }),
      }),
    ).resolves.toEqual(failedWith('empty'));
  });

  it('still rejects inspection, content policy, audio and abort errors', async () => {
    const finding = inspectContent(extractFileContent({ extractedText: 'PRIVATE-SECRET' }), {
      filters: privateTokenFilters,
    });
    if (finding == null) {
      throw new Error('expected the private token to match');
    }
    const hardErrors = [
      new UninspectableFileError('extracted_text'),
      new ContentFilterError(finding),
      new ContentFilterInputTooLargeError('extracted_text'),
      new UnsupportedProviderAudioError(),
      AbortSignal.abort().reason,
    ];
    for (const error of hardErrors) {
      await expect(
        acquireUploadText({ fileId, reading: keep(DOCX), acquire: () => Promise.reject(error) }),
      ).rejects.toBe(error);
    }
  });
});

describe('getUploadReadingMetadata', () => {
  const marker: TextDerivation = { outcome: 'failed', reason: 'parser', at: 1 };

  it('writes nothing under the classic policy', () => {
    expect(getUploadReadingMetadata({ policy: 'classic', deferredMarker: false })).toEqual({});
    expect(getUploadReadingMetadata({ policy: 'classic', deferredMarker: true }, marker)).toEqual(
      {},
    );
  });

  it('writes the acquisition marker, or a deferred marker for an upload left to Run Code', () => {
    expect(
      getUploadReadingMetadata({ policy: 'automatic', deferredMarker: false }, marker),
    ).toEqual({ textDerivation: marker });
    expect(getUploadReadingMetadata({ policy: 'automatic', deferredMarker: true })).toEqual({
      textDerivation: { outcome: 'deferred', at: expect.any(Number) },
    });
    expect(getUploadReadingMetadata({ policy: 'automatic', deferredMarker: false })).toEqual({});
  });
});

describe('logUploadReading', () => {
  let debug: jest.SpyInstance;
  let info: jest.SpyInstance;

  beforeEach(() => {
    debug = jest.spyOn(logger, 'debug');
    info = jest.spyOn(logger, 'info');
  });

  afterEach(() => {
    debug.mockRestore();
    info.mockRestore();
  });

  it('logs a deferred upload at debug with codes only', async () => {
    const reading = await decide({ mimeType: XLSX }).reading;
    logUploadReading('file-1', reading);

    expect(debug).toHaveBeenCalledWith(
      '[uploadReading] file_id=file-1 policy=automatic category=tabular path=none reason=code_preferred extraction=deferred',
    );
  });

  it('logs a kept original at info', async () => {
    const reading = await decide({ mimeType: DOCX }).reading;
    logUploadReading(
      'file-2',
      { ...reading, path: 'none' },
      { outcome: 'failed', reason: 'parser' },
    );

    expect(info).toHaveBeenCalledWith(
      '[uploadReading] file_id=file-2 policy=automatic category=document path=none reason=automatic_default extraction=failed failure=parser kept=original',
    );
  });

  it('stays silent under the classic policy', async () => {
    const reading = await decide({ mimeType: XLSX, endpointConfig: undefined }).reading;
    logUploadReading('file-3', reading);

    expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('[uploadReading]'));
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('[uploadReading]'));
  });
});
