import { megabyte, EToolResources, fileConfig as defaultFileConfig } from 'librechat-data-provider';
import type { EndpointFileConfig, FileConfig } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { validateFiles, validateFileSizes, partitionUploads } from '../files';

const supportedMimeTypes = defaultFileConfig.endpoints.default.supportedMimeTypes;
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const VENDOR_SCAN = 'application/x-vendor-scan';

function makeEndpointConfig(overrides: Partial<EndpointFileConfig> = {}): EndpointFileConfig {
  return {
    fileLimit: 10,
    fileSizeLimit: 25 * megabyte,
    totalSizeLimit: 100 * megabyte,
    supportedMimeTypes,
    disabled: false,
    ...overrides,
  };
}

function makeFile(name: string, type: string, size: number): File {
  const content = new ArrayBuffer(size);
  return new File([content], name, { type });
}

/** Stands in for a file of any size without allocating its bytes, which only the size rules read. */
function makeSizedFile(name: string, type: string, size: number): File {
  const file = new File(['content'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function makeExtendedFile(overrides: Partial<ExtendedFile> = {}): ExtendedFile {
  return {
    file_id: 'ext-1',
    size: 1024,
    progress: 1,
    type: 'application/pdf',
    ...overrides,
  };
}

describe('validateFiles', () => {
  let setError: jest.Mock;
  let files: Map<string, ExtendedFile>;
  let endpointFileConfig: EndpointFileConfig;
  const fileConfig: FileConfig | null = null;

  beforeEach(() => {
    setError = jest.fn();
    files = new Map();
    endpointFileConfig = makeEndpointConfig();
  });

  it('returns true when all checks pass', () => {
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('rejects a type outside a restricted endpoint allowlist in unified mode', () => {
    endpointFileConfig = makeEndpointConfig({
      supportedMimeTypes: [/^image\/(jpeg|png)$/],
    });
    const fileList = [makeFile('notes.txt', 'text/plain', 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: defaultFileConfig,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('Unsupported file type: text/plain');
  });

  it('accepts a type the restricted endpoint allowlist permits in unified mode', () => {
    endpointFileConfig = makeEndpointConfig({
      supportedMimeTypes: [/^image\/(jpeg|png)$/],
    });
    const fileList = [makeFile('shot.png', 'image/png', 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: defaultFileConfig,
    });

    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('rejects when endpoint is disabled', () => {
    endpointFileConfig = makeEndpointConfig({ disabled: true });
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_ui_attach_error_disabled');
  });

  it('rejects empty files (zero bytes)', () => {
    const fileList = [makeFile('empty.pdf', 'application/pdf', 0)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_error_files_empty');
  });

  it('rejects when fileLimit would be exceeded', () => {
    endpointFileConfig = makeEndpointConfig({ fileLimit: 3 });
    files = new Map([
      ['f1', makeExtendedFile({ file_id: 'f1', filename: 'one.pdf', size: 2048 })],
      ['f2', makeExtendedFile({ file_id: 'f2', filename: 'two.pdf', size: 3072 })],
    ]);
    const fileList = [
      makeFile('a.pdf', 'application/pdf', 1024),
      makeFile('b.pdf', 'application/pdf', 2048),
    ];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('File limit reached: 3 files');
  });

  it('allows upload when exactly at fileLimit boundary', () => {
    endpointFileConfig = makeEndpointConfig({ fileLimit: 3 });
    files = new Map([
      ['f1', makeExtendedFile({ file_id: 'f1', filename: 'one.pdf', size: 2048 })],
      ['f2', makeExtendedFile({ file_id: 'f2', filename: 'two.pdf', size: 3072 })],
    ]);
    const fileList = [makeFile('a.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
  });

  it('rejects unsupported MIME type', () => {
    const fileList = [makeFile('data.xyz', 'application/x-unknown', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('Unsupported file type: application/x-unknown');
  });

  it('accepts a document-parser-only MIME type for context uploads', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [/^text\/plain$/] },
      ocr: { supportedMimeTypes: [] },
      documentParser: { supportedMimeTypes: [/^application\/rtf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('notes.rtf', 'application/rtf', 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('canonicalizes a generic document MIME before context validation', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [] },
      ocr: { supportedMimeTypes: [] },
      documentParser: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', 'application/octet-stream', 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(true);
    expect(fileList[0].type).toBe(DOCX);
    expect(setError).not.toHaveBeenCalled();
  });

  it('accepts configured OCR when the document-parser allowlist excludes the type', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/] },
      ocr: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)], enabled: true },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', DOCX, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  /**
   * The upload path routes a document to RAG when the admin names it in a narrowed text
   * allowlist and a RAG service exists, whether or not the local parser still claims the
   * type. Refusing it here would reject a file the server accepts.
   */
  it('accepts a locally excluded document that configured RAG text handles', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)], enabled: true },
      ocr: { supportedMimeTypes: [] },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', DOCX, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  /**
   * An operator who adds a vendor alias to the parser allowlist has told the server to
   * parse that type, and the server obeys the allowlist whether or not the type is one
   * it ships with. Gating the client on the built-in list refuses an upload the server
   * would have accepted.
   */
  it('accepts a vendor MIME alias the operator added to the parser allowlist', () => {
    const vendorType = 'application/vnd.vendor.word';
    const contextFileConfig = {
      text: { supportedMimeTypes: [] },
      ocr: { supportedMimeTypes: [] },
      documentParser: { supportedMimeTypes: [new RegExp(`^${vendorType}$`)] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', vendorType, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig: makeEndpointConfig({
        supportedMimeTypes: [new RegExp(`^${vendorType}$`)],
      }),
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  /**
   * The upload options already refuse this combination; validation did not, so an agent
   * without the OCR capability could still pick Context explicitly and be told by the
   * server what the client already knew.
   */
  it('rejects a configured-OCR document when the agent lacks the OCR capability', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [] },
      ocr: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)], enabled: true },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', DOCX, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
      ocrEnabled: false,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`Unsupported file type: ${DOCX}`);
  });

  it('accepts the same document when the agent may use OCR', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [] },
      ocr: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)], enabled: true },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', DOCX, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
      ocrEnabled: true,
    });

    expect(result).toBe(true);
  });

  it('rejects a non-document OCR type when the provider is disabled', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [] },
      ocr: { supportedMimeTypes: [new RegExp(`^${VENDOR_SCAN}$`)], enabled: false },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('page.scan', VENDOR_SCAN, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
      ocrEnabled: true,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`Unsupported file type: ${VENDOR_SCAN}`);
  });

  it('rejects a locally excluded document when no RAG service is configured', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)] },
      ocr: { supportedMimeTypes: [] },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', DOCX, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`Unsupported file type: ${DOCX}`);
  });

  it('rejects a locally excluded document when the text allowlist is the permissive default', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/], enabled: true },
      ocr: { supportedMimeTypes: [] },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', DOCX, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(false);
  });

  it('rejects a locally excluded document when OCR only has default type metadata', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/] },
      ocr: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)] },
      documentParser: { supportedMimeTypes: [/^application\/pdf$/] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', DOCX, 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`Unsupported file type: ${DOCX}`);
  });

  /**
   * A client that types uploads by magic bytes calls a `.docx` an archive. The server
   * routes it by the same resolution, so leaving the filename out here would reject an
   * upload the backend parses, or offer one it refuses.
   */
  it('resolves a zip-typed office document to its own type before validation', () => {
    const contextFileConfig = {
      text: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)] },
      ocr: { supportedMimeTypes: [] },
      documentParser: { supportedMimeTypes: [new RegExp(`^${DOCX}$`)] },
      stt: { supportedMimeTypes: [] },
    } as unknown as FileConfig;
    const fileList = [makeFile('report.docx', 'application/zip', 1024)];

    const result = validateFiles({
      files,
      fileList,
      setError,
      endpointFileConfig,
      fileConfig: contextFileConfig,
      toolResource: EToolResources.context,
    });

    expect(result).toBe(true);
    expect(fileList[0].type).toBe(DOCX);
    expect(setError).not.toHaveBeenCalled();
  });

  it('normalizes Windows ZIP MIME type before validation', () => {
    const fileList = [makeFile('archive.zip', 'application/x-zip-compressed', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
    expect(fileList[0].type).toBe('application/zip');
    expect(setError).not.toHaveBeenCalled();
  });

  it('infers ZIP MIME type when the browser does not provide one', () => {
    const fileList = [makeFile('archive.zip', '', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
    expect(fileList[0].type).toBe('application/zip');
    expect(setError).not.toHaveBeenCalled();
  });

  it('rejects when file size equals fileSizeLimit (>= comparison)', () => {
    const limit = 5 * megabyte;
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: limit });
    const fileList = [makeFile('exact.pdf', 'application/pdf', limit)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`File size limit exceeded: ${limit / megabyte} MB`);
  });

  it('allows file just under fileSizeLimit', () => {
    const limit = 5 * megabyte;
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: limit });
    const fileList = [makeFile('under.pdf', 'application/pdf', limit - 1)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
  });

  it('can defer size validation until after files are transformed', () => {
    const limit = 5 * megabyte;
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: limit });
    const fileList = [makeFile('photo.jpg', 'image/jpeg', limit + 1)];

    const metadataResult = validateFiles({
      files,
      fileList,
      setError,
      fileConfig,
      endpointFileConfig,
      skipSizeValidation: true,
    });
    const transformedResult = validateFileSizes({
      files,
      fileList: [makeFile('photo.jpg', 'image/jpeg', limit - 1)],
      setError,
      endpointFileConfig,
    });

    expect(metadataResult).toBe(true);
    expect(transformedResult).toBe(true);
    expect(setError).not.toHaveBeenCalled();
  });

  it('preserves the individual size error after transformation', () => {
    const limit = 5 * megabyte;
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: limit });

    const result = validateFileSizes({
      files,
      fileList: [makeFile('photo.jpg', 'image/jpeg', limit)],
      setError,
      endpointFileConfig,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`File size limit exceeded: ${limit / megabyte} MB`);
  });

  it('rejects when totalSizeLimit would be exceeded', () => {
    const limit = 10 * megabyte;
    endpointFileConfig = makeEndpointConfig({ totalSizeLimit: limit });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', size: 6 * megabyte })]]);
    const fileList = [makeFile('big.pdf', 'application/pdf', 5 * megabyte)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`Total file size limit exceeded: ${limit / megabyte} MB`);
  });

  it('allows when totalSizeLimit is exactly met', () => {
    const limit = 10 * megabyte;
    endpointFileConfig = makeEndpointConfig({ totalSizeLimit: limit });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', size: 5 * megabyte })]]);
    const fileList = [makeFile('fits.pdf', 'application/pdf', 5 * megabyte)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(true);
  });

  it('checks the total size across the transformed batch', () => {
    const limit = 10 * megabyte;
    endpointFileConfig = makeEndpointConfig({ totalSizeLimit: limit });

    const result = validateFileSizes({
      files,
      fileList: [
        makeFile('one.jpg', 'image/jpeg', 6 * megabyte),
        makeFile('two.jpg', 'image/jpeg', 5 * megabyte),
      ],
      setError,
      endpointFileConfig,
    });

    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith(`Total file size limit exceeded: ${limit / megabyte} MB`);
  });

  it('rejects duplicate files', () => {
    files = new Map([
      [
        'f1',
        makeExtendedFile({
          file_id: 'f1',
          file: makeFile('doc.pdf', 'application/pdf', 1024),
          filename: 'doc.pdf',
          size: 1024,
          type: 'application/pdf',
        }),
      ],
    ]);
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    const result = validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(result).toBe(false);
    expect(setError).toHaveBeenCalledWith('com_error_files_dupe');
  });

  it('enforces check ordering: disabled before fileLimit', () => {
    endpointFileConfig = makeEndpointConfig({ disabled: true, fileLimit: 1 });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', filename: 'existing.pdf' })]]);
    const fileList = [makeFile('doc.pdf', 'application/pdf', 1024)];
    validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(setError).toHaveBeenCalledWith('com_ui_attach_error_disabled');
  });

  it('enforces check ordering: fileLimit before fileSizeLimit', () => {
    const limit = 1;
    endpointFileConfig = makeEndpointConfig({ fileLimit: 1, fileSizeLimit: limit });
    files = new Map([['f1', makeExtendedFile({ file_id: 'f1', filename: 'existing.pdf' })]]);
    const fileList = [makeFile('huge.pdf', 'application/pdf', limit)];
    validateFiles({ files, fileList, setError, endpointFileConfig, fileConfig });
    expect(setError).toHaveBeenCalledWith('File limit reached: 1 files');
  });
});

describe('partitionUploads', () => {
  let files: Map<string, ExtendedFile>;
  let endpointFileConfig: EndpointFileConfig;

  beforeEach(() => {
    files = new Map();
    endpointFileConfig = makeEndpointConfig();
  });

  it('keeps the files that fit and skips only the ones over the individual limit', () => {
    const limit = 20 * megabyte;
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: limit });
    const fileList = [
      makeSizedFile('small.pdf', 'application/pdf', 1 * megabyte),
      makeSizedFile('huge.pdf', 'application/pdf', 21 * megabyte),
      makeSizedFile('medium.pdf', 'application/pdf', 5 * megabyte),
    ];

    const { keptIndices, skipped } = partitionUploads({ files, fileList, endpointFileConfig });

    expect(keptIndices).toEqual([0, 2]);
    expect(skipped).toEqual([{ index: 1, file: fileList[1], reason: 'fileSize' }]);
  });

  it('skips every file when all of them are over the individual limit', () => {
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: 1 * megabyte });
    const fileList = [
      makeSizedFile('one.pdf', 'application/pdf', 2 * megabyte),
      makeSizedFile('two.pdf', 'application/pdf', 3 * megabyte),
    ];

    const { keptIndices, skipped } = partitionUploads({ files, fileList, endpointFileConfig });

    expect(keptIndices).toEqual([]);
    expect(skipped.map(({ reason }) => reason)).toEqual(['fileSize', 'fileSize']);
  });

  it('treats a file matching an existing attachment as a duplicate without dropping the rest', () => {
    files = new Map([
      [
        'f1',
        makeExtendedFile({
          file_id: 'f1',
          filename: 'report.pdf',
          size: 1024,
          type: 'application/pdf',
        }),
      ],
    ]);
    const fileList = [
      makeSizedFile('report.pdf', 'application/pdf', 1024),
      makeSizedFile('notes.pdf', 'application/pdf', 2048),
    ];

    const { keptIndices, skipped } = partitionUploads({ files, fileList, endpointFileConfig });

    expect(keptIndices).toEqual([1]);
    expect(skipped).toEqual([{ index: 0, file: fileList[0], reason: 'duplicate' }]);
  });

  it('skips a file repeated within the same selection and keeps the first copy', () => {
    const fileList = [
      makeSizedFile('report.pdf', 'application/pdf', 1024),
      makeSizedFile('report.pdf', 'application/pdf', 1024),
    ];

    const { keptIndices, skipped } = partitionUploads({ files, fileList, endpointFileConfig });

    expect(keptIndices).toEqual([0]);
    expect(skipped).toEqual([{ index: 1, file: fileList[1], reason: 'duplicate' }]);
  });

  it('leaves size checks alone when they are deferred until after transformation', () => {
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: 1 * megabyte });
    const fileList = [makeSizedFile('huge.pdf', 'application/pdf', 21 * megabyte)];

    const { keptIndices, skipped } = partitionUploads({
      files,
      fileList,
      endpointFileConfig,
      skipSizeValidation: true,
    });

    expect(keptIndices).toEqual([0]);
    expect(skipped).toEqual([]);
  });

  it('keeps everything when no individual limit is configured', () => {
    endpointFileConfig = makeEndpointConfig({ fileSizeLimit: 0 });
    const fileList = [makeSizedFile('huge.pdf', 'application/pdf', 500 * megabyte)];

    const { keptIndices, skipped } = partitionUploads({ files, fileList, endpointFileConfig });

    expect(keptIndices).toEqual([0]);
    expect(skipped).toEqual([]);
  });

  it('leaves the batch-wide total limit to validateFileSizes', () => {
    endpointFileConfig = makeEndpointConfig({
      fileSizeLimit: 10 * megabyte,
      totalSizeLimit: 7 * megabyte,
    });
    const fileList = [
      makeSizedFile('one.pdf', 'application/pdf', 4 * megabyte),
      makeSizedFile('two.pdf', 'application/pdf', 4 * megabyte),
    ];

    const { keptIndices, skipped } = partitionUploads({ files, fileList, endpointFileConfig });

    expect(keptIndices).toEqual([0, 1]);
    expect(skipped).toEqual([]);
  });
});
