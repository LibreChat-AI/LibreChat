jest.mock('uuid', () => ({ v4: jest.fn(() => 'mock-uuid') }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  runAsSystem: jest.fn((fn) => fn()),
  createChatExpirationDate: jest.fn(() => new Date('2030-01-01T00:00:00.000Z')),
}));

jest.mock('@librechat/agents', () => ({
  Providers: {
    XAI: 'xai',
    DEEPSEEK: 'deepseek',
    MOONSHOT: 'moonshot',
    OPENROUTER: 'openrouter',
    VERTEXAI: 'vertexai',
  },
}));

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    Providers: actual.Providers,
    RetentionMode: actual.RetentionMode ?? { ALL: 'all', TEMPORARY: 'temporary' },
    documentParserMimeTypes: actual.documentParserMimeTypes ?? [
      /^application\/pdf$/,
      /^application\/vnd\.openxmlformats-officedocument\./,
      /^application\/vnd\.ms-excel$/,
      /^application\/vnd\.oasis\.opendocument\./,
      /^application\/(?:x-)?msexcel$/,
    ],
    mergeFileConfig: jest.fn(),
  };
});

jest.mock('@librechat/api', () => {
  const actualDataProvider = jest.requireActual('librechat-data-provider');
  const RetentionMode = actualDataProvider.RetentionMode ?? { ALL: 'all', TEMPORARY: 'temporary' };
  const getRetentionExpiry = jest.fn(() => ({}));
  const createCodeApiRateLimitBudget = jest.fn(() => ({
    limitMs: 20_000,
    waitedMs: 0,
    activeWaitEnds: new Set(),
  }));
  const getCodeApiUploadOptions = jest.fn(() => ({
    scope: 'default:user-1',
    concurrency: 3,
    retryWaitMs: 20_000,
  }));
  const withCodeApiUploadRecovery = jest.fn(async ({ openSource, upload }) => {
    try {
      return await upload(await openSource());
    } catch (error) {
      if (error?.response?.status !== 429) {
        throw error;
      }
      return upload(await openSource());
    }
  });
  const UPLOAD_EXTRACTED_TEXT_PLANS = {
    configuredOCR: 'configured_ocr',
    configuredRAG: 'configured_rag',
    documentParser: 'document_parser',
  };
  const hasActiveFileFieldPolicy = jest.fn((filters, candidates) => {
    const pii = filters?.files?.pii;
    if (pii == null) {
      return false;
    }
    const fieldSelected = candidates.some(
      (field) => pii.fields == null || pii.fields.includes(field),
    );
    const hasPatterns =
      pii.starterPatterns == null ||
      pii.starterPatterns.length > 0 ||
      (pii.customPatterns?.length ?? 0) > 0;
    const failClosed =
      pii.uninspectable === 'block' &&
      candidates.some(
        (field) =>
          ['content', 'extracted_text', 'transcript'].includes(field) &&
          (pii.fields == null || pii.fields.includes(field)),
      );
    return (hasPatterns && fieldSelected) || failClosed;
  });
  const hasActiveFilePolicy = jest.fn((filters) =>
    hasActiveFileFieldPolicy(filters, ['name', 'content', 'extracted_text', 'transcript']),
  );
  const getSafeErrorMetadata = jest.fn((error) => ({
    type: error instanceof Error ? 'Error' : 'UnknownError',
    ...(Number.isInteger(error?.response?.status) && { status: error.response.status }),
  }));
  const getFileExtractionLogDetails = jest.fn(({ filters, filename, fileId, error }) => {
    const contentProtected = hasActiveFilePolicy(filters);
    return {
      contentProtected,
      fileLabel: contentProtected ? `file_id=${fileId}` : `"${filename}"`,
      errorMetadata: contentProtected ? getSafeErrorMetadata(error) : error,
    };
  });
  /**
   * Stands in for the real planner in `packages/api`, whose own suite owns its
   * precedence rules. What these specs exercise is what `process.js` does with the
   * answer, so the mock reproduces only the decisions the route branches on.
   */
  const planDocumentExtraction = jest.fn(
    ({ mimeType, fileName, fileConfig, ocrConfigured, ragConfigured }) => {
      const checkType = fileConfig.checkType;
      const parserMimeTypes =
        fileConfig.documentParser?.supportedMimeTypes ?? actualDataProvider.documentParserMimeTypes;
      const isKnownDocumentType = actualDataProvider.documentParserMimeTypes.some((pattern) =>
        pattern.test(mimeType),
      );
      const parserEligible = checkType(mimeType, parserMimeTypes);
      const plan = (() => {
        if (ocrConfigured && checkType(mimeType, fileConfig.ocr?.supportedMimeTypes ?? [])) {
          return UPLOAD_EXTRACTED_TEXT_PLANS.configuredOCR;
        }
        if (!isKnownDocumentType && !parserEligible) {
          return null;
        }
        if (
          ragConfigured &&
          !actualDataProvider.isPermissiveMimeConfig(fileConfig.text?.supportedMimeTypes) &&
          checkType(mimeType, fileConfig.text?.supportedMimeTypes ?? [])
        ) {
          return UPLOAD_EXTRACTED_TEXT_PLANS.configuredRAG;
        }
        return parserEligible ? UPLOAD_EXTRACTED_TEXT_PLANS.documentParser : null;
      })();
      const useConfiguredText = plan === UPLOAD_EXTRACTED_TEXT_PLANS.configuredRAG;
      const isAlias = !isKnownDocumentType && parserEligible;
      const parserMimeType = isAlias
        ? actualDataProvider.resolveEffectiveMimeType(fileName ?? '', '')
        : mimeType;
      const aliasSupportsOCR =
        isAlias &&
        !useConfiguredText &&
        checkType(parserMimeType, fileConfig.ocr?.supportedMimeTypes ?? []);
      return {
        plan,
        parserMimeType,
        isBuiltInDocumentType: isKnownDocumentType,
        parserEligible,
        useConfiguredText,
        useConfiguredOCR:
          ocrConfigured && (plan === UPLOAD_EXTRACTED_TEXT_PLANS.configuredOCR || aliasSupportsOCR),
        useDocumentParser: !useConfiguredText && parserEligible,
      };
    },
  );
  /**
   * The same arrangement for the extraction chain: `packages/api` owns the order the
   * engines run in and its own suite proves it, and this reproduces the outcomes so
   * these specs stay about what the route hands in and does with the answer.
   */
  const isPartialDocumentText = (result) =>
    !!result?.pagesNeedingOcr?.length || result?.mayOmitContent === true;
  const isDelimitedTextType = (mimeType) => /^(?:text|application)\/csv$/i.test(mimeType ?? '');
  const errorMatches = (error, code, name) => error?.code === code || error?.name === name;
  const isNoDocumentTextError = (error) =>
    errorMatches(error, 'NO_DOCUMENT_TEXT', 'NoDocumentTextError');
  const isDocumentParserRefusal = (error) =>
    errorMatches(error, 'ZIP_BOMB', 'ZipBombError') ||
    errorMatches(error, 'ARCHIVE_INVALID', 'ArchiveValidationError') ||
    errorMatches(error, 'PDF_PAGE_LIMIT', 'PdfPageLimitError') ||
    errorMatches(error, 'CONCURRENCY_LIMIT', 'ConcurrencyLimitError') ||
    errorMatches(error, 'PARSER_INPUT_LIMIT', 'ParserInputLimitError') ||
    errorMatches(error, 'PARSER_OUTPUT_LIMIT', 'ParserOutputLimitError');
  const resolveDocumentExtraction = jest.fn(
    async ({ delimitedText, parse, runConfiguredOCR, readRawText, assertPartialTextAllowed }) => {
      let parsed;
      try {
        parsed = await parse();
      } catch (error) {
        if (errorMatches(error, 'PARSER_OUTPUT_LIMIT', 'ParserOutputLimitError') && delimitedText) {
          const raw = await readRawText?.();
          if (raw) {
            return raw;
          }
        }
        throw error;
      }
      const hasText = !!parsed?.text?.trim();
      const needsOCR = !hasText || isPartialDocumentText(parsed);
      if (hasText && !needsOCR) {
        return parsed;
      }
      if (needsOCR && runConfiguredOCR) {
        const ocr = await runConfiguredOCR({ throwOnMissingCapability: !hasText });
        if (ocr?.text?.trim()) {
          return ocr;
        }
      }
      if (hasText) {
        assertPartialTextAllowed();
        return parsed;
      }
      return delimitedText ? await readRawText?.() : undefined;
    },
  );
  /**
   * The shared admission predicate both upload gates call. `packages/api` owns its rules
   * and proves them; this reproduces the answer so these specs stay about the scope
   * `filterFile` hands in.
   */
  const isAdmissibleUploadType = jest.fn(
    ({ mimeType, fileConfig, endpointMimeTypes, admitParserTypes }) => {
      const checkType = fileConfig.checkType;
      if (checkType == null) {
        return false;
      }
      if (checkType(mimeType, endpointMimeTypes ?? [])) {
        return true;
      }
      const parserMimeTypes = fileConfig.documentParser?.supportedMimeTypes;
      return admitParserTypes && parserMimeTypes != null
        ? checkType(mimeType, parserMimeTypes)
        : false;
    },
  );
  return {
    sanitizeFilename: jest.fn((n) => n),
    /** Grants both; these specs vary the capability set, not the role. */
    resolveToolRoleGrants: jest.fn(async () => ({ runCode: true, fileSearch: true })),
    parseText: jest.fn().mockResolvedValue({ text: '', bytes: 0 }),
    /** Stores no fallback text unless a test opts in; its own rules are covered in packages/api. */
    resolveUploadFallbackText: jest.fn(async () => undefined),
    MAX_STORED_EXTRACTED_TEXT_BYTES: 15 * 1024 * 1024,
    parseTextNative: jest.fn().mockResolvedValue({ text: '', bytes: 0 }),
    processAudioFile: jest.fn(),
    extractInspectableFileText: jest.fn(async ({ extract }) => extract()),
    assertExtractedTextInspectable: jest.fn(),
    planDocumentExtraction,
    isAdmissibleUploadType,
    resolveDocumentExtraction,
    isDocumentParserRefusal,
    isNoDocumentTextError,
    isPartialDocumentText,
    isDelimitedTextType,
    UPLOAD_EXTRACTED_TEXT_PLANS,
    getFileExtractionLogDetails,
    getSafeErrorMetadata,
    hasActiveFilePolicy,
    inspectContent: jest.fn(),
    extractFileContent: jest.fn((input) => [input]),
    hasActiveFileFieldPolicy,
    contentFilterBlockResponse: jest.fn((finding) => ({
      error: 'content_filter_block',
      message: 'Submitted content contains a protected value. Remove it and try again.',
      source: finding.source,
      field: finding.field,
    })),
    sendUploadSuccess: jest.fn((res, sseStream, message, result) => {
      if (sseStream) {
        sseStream.sendData({ message, ...result });
        return;
      }
      res.status(200).json({ message, ...result });
    }),
    getStorageMetadata: jest.fn(() => ({})),
    /* Stub, deliberately not the production wording: the notice text is covered by
     * packages/api's own tests. What matters here is that process.js forwards the
     * pages it was given, so assertions target the call, not the string. */
    annotateMissingPages: jest.fn((text, pages) =>
      pages?.length ? `${text}\n[omitted:${pages.join(',')}]` : text,
    ),
    summarizeMissingPages: jest.fn((pages) => {
      const listed = pages.slice(0, 20);
      const remaining = pages.length - listed.length;
      return remaining ? `${listed.join(', ')} and ${remaining} more` : listed.join(', ');
    }),
    getRetentionExpiry,
    createCodeApiRateLimitBudget,
    getCodeApiUploadOptions,
    withCodeApiUploadRecovery,
    getAgentFileRetentionExpiry: jest.fn(({ req, messageAttachment, toolResource }) => {
      const interfaceConfig = req?.config?.interfaceConfig;
      if (
        !messageAttachment &&
        !!toolResource &&
        (interfaceConfig?.retentionMode !== RetentionMode.ALL ||
          interfaceConfig?.retainAgentFiles === true)
      ) {
        return {};
      }
      return getRetentionExpiry(req);
    }),
    sweepExpiredFiles: jest.fn().mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 }),
    startExpiredFileSweep: jest.fn().mockReturnValue('sweep-interval'),
    isLeader: jest.fn().mockResolvedValue(true),
  };
});

jest.mock('~/server/services/Files/images', () => ({
  convertImage: jest.fn(),
  resizeAndConvert: jest.fn(),
  resizeImageBuffer: jest.fn(),
}));

jest.mock('~/server/controllers/assistants/v2', () => ({
  addResourceFileId: jest.fn(),
  deleteResourceFileId: jest.fn(),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/models', () => ({
  createFile: jest.fn().mockResolvedValue({ file_id: 'created-file-id' }),
  updateFileUsage: jest.fn(),
  deleteFiles: jest.fn(),
  findFileById: jest.fn(),
  getConvo: jest.fn(),
  getExpiredFiles: jest.fn(),
  getAgent: jest.fn().mockResolvedValue(null),
  incrementFileDeletionAttempts: jest.fn(),
  deferExpiredFile: jest.fn(),
  addAgentResourceFile: jest.fn().mockResolvedValue({}),
  removeAgentResourceFiles: jest.fn(),
  removeAgentResourceFilesFromAllAgents: jest.fn(),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn().mockReturnValue('local'),
}));

jest.mock('~/server/services/Config', () => ({
  checkCapability: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/server/utils/queue', () => ({
  LB_QueueAsyncCall: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

jest.mock('./VectorDB/crud', () => ({
  uploadVectors: jest.fn().mockResolvedValue({
    bytes: 42,
    filename: 'upload.bin',
    filepath: 'vectordb',
    embedded: true,
  }),
  deleteVectors: jest.fn(),
}));

jest.mock('~/server/utils', () => ({
  determineFileType: jest.fn(),
}));

jest.mock('~/server/services/Files/Audio/STTService', () => ({
  STTService: { getInstance: jest.fn() },
}));

jest.mock('./VectorDB/crud', () => ({
  uploadVectors: jest.fn().mockResolvedValue({ embedded: true, filename: 'embedded-upload.bin' }),
}));

const {
  getRetentionExpiry,
  getAgentFileRetentionExpiry,
  annotateMissingPages,
  summarizeMissingPages,
  sweepExpiredFiles: sweepExpiredFilesWithDeps,
  startExpiredFileSweep: startExpiredFileSweepWithDeps,
} = require('@librechat/api');
const {
  EModelEndpoint,
  EToolResources,
  DocumentParser,
  FileSources,
  FileContext,
  RetentionMode,
  AgentCapabilities,
} = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { mergeFileConfig } = require('librechat-data-provider');
const { checkCapability } = require('~/server/services/Config');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { uploadVectors } = require('./VectorDB/crud');
const db = require('~/models');
const {
  filterFile,
  processAgentFileUpload,
  processImageFile,
  processDeleteRequest,
  processFileUpload,
  processFileURL,
  retrieveAndProcessFile,
  sweepExpiredFiles,
  startExpiredFileSweep,
} = require('./process');
const {
  inspectContent,
  extractFileContent,
  processAudioFile,
  extractInspectableFileText,
  assertExtractedTextInspectable,
  contentFilterBlockResponse,
  createCodeApiRateLimitBudget,
  getCodeApiUploadOptions,
  withCodeApiUploadRecovery,
} = require('@librechat/api');

const PDF_MIME = 'application/pdf';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XLS_MIME = 'application/vnd.ms-excel';
const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';
const ODT_MIME = 'application/vnd.oasis.opendocument.text';
const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
const ODG_MIME = 'application/vnd.oasis.opendocument.graphics';

const makeUninspectableExtractedTextError = () =>
  Object.assign(new Error('Submitted file content could not be inspected.'), {
    code: 'content_filter_uninspectable',
    statusCode: 400,
    body: {
      error: 'content_filter_uninspectable',
      message: 'Submitted file content could not be inspected before processing.',
      source: 'file',
      field: 'extracted_text',
    },
  });

const makeReq = ({
  mimetype = PDF_MIME,
  originalname = 'upload.bin',
  ocrConfig = null,
  interfaceConfig,
  filters,
  speech,
  body,
} = {}) => ({
  user: { id: 'user-123', tenantId: 'tenant-a' },
  file: {
    path: '/tmp/upload.bin',
    originalname,
    filename: 'upload-uuid.bin',
    mimetype,
  },
  body: { model: 'gpt-4o', ...body },
  config: {
    fileConfig: {},
    fileStrategy: 'local',
    imageOutputType: 'webp',
    ocr: ocrConfig,
    ...(speech ? { speech } : {}),
    ...(filters ? { filters } : {}),
    ...(interfaceConfig ? { interfaceConfig } : {}),
  },
});

const makeMetadata = () => ({
  agent_id: 'agent-abc',
  tool_resource: EToolResources.context,
  file_id: 'file-uuid-123',
});

const mockRes = {
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnValue({}),
  /* The upload route cancels a parse when the connection closes, so the response has to
   * behave like one: an emitter it can subscribe to and unsubscribe from. */
  once: jest.fn().mockReturnThis(),
  off: jest.fn().mockReturnThis(),
};

const makeFileConfig = ({
  ocrSupportedMimeTypes = [],
  sttSupportedMimeTypes = [],
  textSupportedMimeTypes = [],
  documentParserSupportedMimeTypes,
} = {}) => ({
  checkType: (mime, types) =>
    (types ?? []).some((t) => (typeof t === 'string' ? t === mime : t.test(mime))),
  ocr: { supportedMimeTypes: ocrSupportedMimeTypes },
  stt: { supportedMimeTypes: sttSupportedMimeTypes },
  text: { supportedMimeTypes: textSupportedMimeTypes },
  ...(documentParserSupportedMimeTypes
    ? { documentParser: { supportedMimeTypes: documentParserSupportedMimeTypes } }
    : {}),
});

const setupStoredFileUpload = (result = {}) => {
  const handleFileUpload = jest.fn().mockResolvedValue({
    bytes: 42,
    filename: 'upload.bin',
    filepath: '/uploads/upload.bin',
    ...result,
  });
  getStrategyFunctions.mockReturnValue({ handleFileUpload });
  return handleFileUpload;
};

/**
 * `createTextFile` uploads the original document through the storage strategy, so the
 * extraction mock and the storage mock have to be separate: `getFileStrategy` is stubbed
 * to `'local'`, while parsing and configured OCR answer on their own sources.
 */
const setupDocumentStrategies = ({ documentParser, ocr } = {}) => {
  const storageUpload = jest.fn().mockResolvedValue({
    bytes: 4096,
    filename: 'upload.bin',
    filepath: '/uploads/user-1/upload.bin',
  });
  const extractionUpload = (source) =>
    source === FileSources.document_parser ? documentParser : ocr;
  getStrategyFunctions.mockImplementation((source) => ({
    handleFileUpload: source === 'local' ? storageUpload : extractionUpload(source),
  }));
  return storageUpload;
};

describe('upload retention scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRes.status.mockReturnThis();
    mockRes.json.mockReturnValue({});
  });

  it.each([false, true])(
    'resolves assistant file retention only for new records (existing=%s)',
    async (existing) => {
      const req = makeReq({ body: { endpoint: 'assistants' } });
      let resolveProvider;
      const retrieve = jest.fn(
        () =>
          new Promise((resolve) => {
            resolveProvider = resolve;
          }),
      );
      const openai = { req, baseURL: 'https://example.com', files: { retrieve } };
      const pending = retrieveAndProcessFile({
        openai,
        client: { req, attachedFileIds: new Set(existing ? ['file-1'] : []) },
        file_id: 'file-1',
        basename: 'output.txt',
      });
      expect(retrieve).toHaveBeenCalledTimes(1);
      if (existing) {
        expect(getRetentionExpiry).not.toHaveBeenCalled();
      } else {
        expect(getRetentionExpiry).toHaveBeenCalled();
      }
      resolveProvider({ filename: 'output.txt' });
      await pending;
      if (existing) {
        expect(getRetentionExpiry).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ['image', processImageFile, 'handleImageUpload'],
    ['file', processFileUpload, 'handleFileUpload'],
  ])(
    'overlaps the retention lookup with %s storage',
    async (_label, processUpload, strategyKey) => {
      let resolveRetention;
      let resolveStorage;
      getRetentionExpiry.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRetention = resolve;
        }),
      );
      const storage = jest.fn(
        () =>
          new Promise((resolve) => {
            resolveStorage = resolve;
          }),
      );
      getStrategyFunctions.mockReturnValue({ [strategyKey]: storage });
      const req = makeReq({ body: { endpoint: 'openAI' } });
      req.config.imageOutputType = 'webp';

      const pending = processUpload({
        req,
        res: mockRes,
        metadata: { endpoint: 'openAI', file_id: 'file-uuid-123' },
      });
      await Promise.resolve();

      expect(getRetentionExpiry).toHaveBeenCalledWith(req, expect.any(Object));
      expect(storage).toHaveBeenCalledTimes(1);
      resolveStorage({
        bytes: 42,
        filename: 'upload.bin',
        filepath: '/uploads/upload.bin',
        width: 10,
        height: 10,
      });
      resolveRetention({ expiredAt: new Date('2030-01-01T00:00:00.000Z') });
      await pending;
    },
  );
});

describe('processAgentFileUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRes.status.mockReturnThis();
    mockRes.json.mockReturnValue({});
    checkCapability.mockResolvedValue(true);
    loadAuthValues.mockResolvedValue({ CODE_API_KEY: 'code-key' });
    uploadVectors.mockResolvedValue({ embedded: true, filename: 'embedded-upload.bin' });
    setupDocumentStrategies({
      documentParser: jest.fn().mockResolvedValue({
        text: 'extracted text',
        bytes: 42,
        filepath: FileSources.document_parser,
      }),
    });
    mergeFileConfig.mockReturnValue(makeFileConfig());
    inspectContent.mockReturnValue(null);
  });

  describe('content filtering for extracted context', () => {
    const filters = { files: { pii: {} } };
    const extractedTextFinding = {
      label: 'protected value',
      source: 'file',
      field: 'extracted_text',
    };

    it('blocks extracted document text before agent-resource and file persistence', async () => {
      inspectContent.mockReturnValueOnce(extractedTextFinding);
      const req = makeReq({ filters });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(extractFileContent).toHaveBeenCalledWith({ extractedText: 'extracted text' });
      expect(inspectContent).toHaveBeenCalledWith([{ extractedText: 'extracted text' }], {
        filters,
      });
      expect(contentFilterBlockResponse).toHaveBeenCalledWith(extractedTextFinding);
      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'content_filter_block',
        message: 'Submitted content contains a protected value. Remove it and try again.',
        source: 'file',
        field: 'extracted_text',
      });
      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    it('emits a metadata-safe SSE error when extracted text is blocked after streaming starts', async () => {
      inspectContent.mockReturnValueOnce(extractedTextFinding);
      const req = makeReq({ filters });
      const sseStream = { sendError: jest.fn() };

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: makeMetadata(),
        sseStream,
      });

      expect(sseStream.sendError).toHaveBeenCalledWith({
        error: 'content_filter_block',
        message: 'Submitted content contains a protected value. Remove it and try again.',
        source: 'file',
        field: 'extracted_text',
        code: 400,
        temp_file_id: null,
        tool_resource: EToolResources.context,
        display_to_user: true,
      });
      expect(mockRes.status).not.toHaveBeenCalled();
      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    it('classifies STT output as a transcript before persistence', async () => {
      const transcriptFinding = {
        label: 'protected value',
        source: 'file',
        field: 'transcript',
      };
      inspectContent.mockReturnValueOnce(transcriptFinding);
      mergeFileConfig.mockReturnValue(makeFileConfig({ sttSupportedMimeTypes: ['audio/webm'] }));
      const sttService = {};
      const { STTService } = require('~/server/services/Files/Audio/STTService');
      STTService.getInstance.mockResolvedValueOnce(sttService);
      processAudioFile.mockResolvedValueOnce({ text: 'submitted transcript', bytes: 20 });
      const req = makeReq({ mimetype: 'audio/webm', filters });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(processAudioFile).toHaveBeenCalledWith({
        req,
        file: req.file,
        sttService,
      });
      expect(extractFileContent).toHaveBeenCalledWith({ transcript: 'submitted transcript' });
      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    it('persists the original audio MIME type as transcript provenance', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ sttSupportedMimeTypes: ['audio/webm'] }));
      const sttService = {};
      const { STTService } = require('~/server/services/Files/Audio/STTService');
      STTService.getInstance.mockResolvedValueOnce(sttService);
      processAudioFile.mockResolvedValueOnce({ text: 'submitted transcript', bytes: 20 });
      const req = makeReq({ mimetype: 'audio/webm' });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'audio/webm',
          llmDeliveryPath: 'text',
          text: 'submitted transcript',
        }),
        true,
      );
    });

    it('does not persist context audio when STT cannot produce a strict-policy transcript', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ sttSupportedMimeTypes: ['audio/webm'] }));
      const { STTService } = require('~/server/services/Files/Audio/STTService');
      STTService.getInstance.mockResolvedValueOnce({});
      processAudioFile.mockRejectedValueOnce(new Error('transcription unavailable'));
      const req = makeReq({
        mimetype: 'audio/webm',
        filters: {
          files: {
            pii: {
              fields: ['transcript'],
              uninspectable: 'block',
            },
          },
        },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('transcription unavailable');

      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    it('preserves the default-off path without inspecting extracted text', async () => {
      const req = makeReq();

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(inspectContent).not.toHaveBeenCalled();
      expect(db.addAgentResourceFile).toHaveBeenCalledTimes(1);
      expect(db.createFile).toHaveBeenCalledTimes(1);
    });

    it('preserves extracted text when the selected file policy has no active patterns', async () => {
      const inactiveFilters = {
        files: {
          pii: { fields: ['extracted_text'], starterPatterns: [], customPatterns: [] },
        },
      };
      const req = makeReq({ filters: inactiveFilters });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(inspectContent).not.toHaveBeenCalled();
      expect(db.addAgentResourceFile).toHaveBeenCalledTimes(1);
      expect(db.createFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('local document extraction and OCR selection', () => {
    /**
     * AnyDoc has no page numbers to report, so a DOCX whose content is a scanned image
     * comes back looking complete. Embedded artwork is the signal that its Markdown may
     * be missing something, and a configured OCR service is exactly what recovers it.
     */
    test('escalates to configured OCR when the local parser reports embedded media', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [DOCX_MIME] }));
      const localUpload = jest.fn().mockResolvedValue({
        text: 'text layer only',
        bytes: 15,
        filepath: DocumentParser.anydoc,
        mayOmitContent: true,
      });
      const remoteOCR = jest.fn().mockResolvedValue({
        text: 'text layer plus the scanned page',
        bytes: 31,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteOCR });
      const req = makeReq({
        mimetype: DOCX_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(localUpload).toHaveBeenCalledTimes(1);
      expect(remoteOCR).toHaveBeenCalledTimes(1);
      expect(db.createFile.mock.calls[0][0].text).toBe('text layer plus the scanned page');
    });

    test('uses the canonical parser format to check OCR support for a configured MIME alias', async () => {
      const vendorMime = 'application/vnd.vendor.word';
      mergeFileConfig.mockReturnValue(
        makeFileConfig({
          documentParserSupportedMimeTypes: [vendorMime],
          ocrSupportedMimeTypes: [DOCX_MIME],
        }),
      );
      const localUpload = jest.fn().mockResolvedValue({
        text: 'text layer only',
        bytes: 15,
        filepath: DocumentParser.anydoc,
        mayOmitContent: true,
      });
      const remoteOCR = jest.fn().mockResolvedValue({
        text: 'text layer plus the scanned page',
        bytes: 31,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteOCR });
      const req = makeReq({
        mimetype: vendorMime,
        originalname: 'report.docx',
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(localUpload).toHaveBeenCalledTimes(1);
      expect(remoteOCR).toHaveBeenCalledTimes(1);
      expect(db.createFile.mock.calls[0][0].text).toBe('text layer plus the scanned page');
    });

    test('keeps the local text when embedded media is reported and no OCR is configured', async () => {
      const localUpload = jest.fn().mockResolvedValue({
        text: 'text layer only',
        bytes: 15,
        filepath: DocumentParser.anydoc,
        mayOmitContent: true,
      });
      setupDocumentStrategies({ documentParser: localUpload });
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(db.createFile.mock.calls[0][0]).toEqual(
        expect.objectContaining({ text: 'text layer only' }),
      );
    });

    test('does not escalate a document that embeds no media', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [DOCX_MIME] }));
      const localUpload = jest.fn().mockResolvedValue({
        text: 'the whole document',
        bytes: 18,
        filepath: DocumentParser.anydoc,
      });
      const remoteOCR = jest.fn();
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteOCR });
      const req = makeReq({
        mimetype: DOCX_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(remoteOCR).not.toHaveBeenCalled();
      expect(db.createFile.mock.calls[0][0].text).toBe('the whole document');
    });

    /* A user who removes the file from the composer closes the request while the parser
     * is still working: the archive walk and the native child both take this signal, and
     * without it they keep an admission slot until their deadline. */
    test('cancels the parse when the upload connection closes', async () => {
      let parsedSignal;
      const localUpload = jest.fn(async ({ signal }) => {
        parsedSignal = signal;
        return { text: 'the whole document', bytes: 18, filepath: DocumentParser.anydoc };
      });
      setupDocumentStrategies({ documentParser: localUpload });
      const closeHandlers = [];
      mockRes.once.mockImplementation((event, handler) => {
        if (event === 'close') {
          closeHandlers.push(handler);
        }
        return mockRes;
      });
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(parsedSignal).toBeInstanceOf(AbortSignal);
      expect(parsedSignal.aborted).toBe(false);
      expect(closeHandlers).toHaveLength(1);
      closeHandlers[0]();
      expect(parsedSignal.aborted).toBe(true);
      /* Removed once the parse is over, so a long-lived response does not accumulate one
       * listener per upload. */
      expect(mockRes.off).toHaveBeenCalledWith('close', closeHandlers[0]);
    });

    test.each([
      ['PDF', PDF_MIME],
      ['DOCX', DOCX_MIME],
      ['XLSX', XLSX_MIME],
      ['XLS', XLS_MIME],
      ['ODS', ODS_MIME],
      ['Excel variant (msexcel)', 'application/msexcel'],
      ['Excel variant (x-msexcel)', 'application/x-msexcel'],
    ])('uses document_parser automatically for %s when no OCR is configured', async (_, mime) => {
      mergeFileConfig.mockReturnValue(makeFileConfig());
      const req = makeReq({ mimetype: mime, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('routes a generic MIME through the parser when the filename identifies an allowed document', async () => {
      const req = makeReq({
        mimetype: 'application/octet-stream',
        originalname: 'report.docx',
        ocrConfig: null,
      });
      const { parseText } = require('@librechat/api');

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
      expect(parseText).not.toHaveBeenCalled();
      expect(db.createFile.mock.calls[0][0].type).toBe('application/octet-stream');
    });

    /**
     * OOXML/ODF/EPUB documents are zip containers, so a client that types uploads by
     * content announces a `.docx` as an archive. That is not a generic type, so nothing
     * re-infers it, and the file used to miss every parser check and land in text
     * parsing, which stores the archive's bytes as the model's copy of the document.
     */
    test('routes a zip-typed office document through the parser on its extension', async () => {
      const req = makeReq({
        mimetype: 'application/zip',
        originalname: 'report.docx',
        ocrConfig: null,
      });
      const { parseText } = require('@librechat/api');

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
      expect(parseText).not.toHaveBeenCalled();
      expect(db.createFile.mock.calls[0][0].type).toBe('application/zip');
    });

    test('leaves an ordinary archive alone', async () => {
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ textSupportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/] }),
      );
      const req = makeReq({
        mimetype: 'application/zip',
        originalname: 'bundle.zip',
        ocrConfig: null,
      });
      const { parseText } = require('@librechat/api');
      parseText.mockResolvedValueOnce({ text: 'archive listing', bytes: 15 });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).not.toHaveBeenCalledWith(FileSources.document_parser);
      expect(parseText).toHaveBeenCalled();
    });

    /**
     * The parser only reformats a delimited file as a Markdown table, and the pipes and
     * padding it adds to every cell can push a source file inside the storage limit past
     * it. Failing the upload would lose a document whose bytes were readable all along.
     */
    test('stores the raw bytes when the parser cannot convert a delimited file', async () => {
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ textSupportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/] }),
      );
      const parserError = Object.assign(
        new Error('anydoc failed: extracted 22MB of text, over the 15MB limit'),
        { name: 'ParserOutputLimitError', code: 'PARSER_OUTPUT_LIMIT' },
      );
      const parserUpload = jest.fn().mockRejectedValue(parserError);
      setupDocumentStrategies({ documentParser: parserUpload });
      const { parseText, parseTextNative } = require('@librechat/api');
      parseTextNative.mockResolvedValueOnce({ text: 'a,b\n1,2\n', bytes: 8 });
      const req = makeReq({ mimetype: 'text/csv', originalname: 'rows.csv', ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(db.createFile.mock.calls[0][0]).toEqual(
        expect.objectContaining({ text: 'a,b\n1,2\n', type: 'text/csv' }),
      );
      /* Read straight from disk: routing through the RAG path would spend a health check
       * and an extraction request to arrive back at the bytes, or return something else. */
      expect(parseText).not.toHaveBeenCalled();
    });

    /**
     * The same reformatting problem, reported as the refusal it is rather than swallowed.
     * The delimited file still falls back to its bytes; anything else has to surface,
     * since nothing downstream should rebuild the string the parser declined to hand over.
     */
    test('falls back to the bytes when a delimited conversion is refused on size', async () => {
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ textSupportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/] }),
      );
      const refusal = Object.assign(new Error('anydoc extracted 22MB of text'), {
        name: 'ParserOutputLimitError',
        code: 'PARSER_OUTPUT_LIMIT',
      });
      const parserUpload = jest.fn().mockRejectedValue(refusal);
      setupDocumentStrategies({ documentParser: parserUpload });
      const { parseText, parseTextNative } = require('@librechat/api');
      parseTextNative.mockResolvedValueOnce({ text: 'a,b\n1,2\n', bytes: 8 });
      const req = makeReq({ mimetype: 'text/csv', originalname: 'rows.csv', ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(db.createFile.mock.calls[0][0].text).toBe('a,b\n1,2\n');
      expect(parseText).not.toHaveBeenCalled();
    });

    /**
     * A configured alias admits the upload and anydoc routes it by extension, so the
     * same source file has to reach the same fallback. The alias itself never matches
     * the delimited predicate; only the canonical type the parser resolved does.
     */
    test('falls back to the bytes for a configured CSV alias refused on size', async () => {
      const vendorMime = 'application/vnd.example.csv';
      mergeFileConfig.mockReturnValue(
        makeFileConfig({
          documentParserSupportedMimeTypes: [vendorMime],
          textSupportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/],
        }),
      );
      const refusal = Object.assign(new Error('anydoc extracted 22MB of text'), {
        name: 'ParserOutputLimitError',
        code: 'PARSER_OUTPUT_LIMIT',
      });
      const parserUpload = jest.fn().mockRejectedValue(refusal);
      setupDocumentStrategies({ documentParser: parserUpload });
      const { parseText, parseTextNative } = require('@librechat/api');
      parseTextNative.mockResolvedValueOnce({ text: 'a,b\n1,2\n', bytes: 8 });
      const req = makeReq({ mimetype: vendorMime, originalname: 'rows.csv', ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(db.createFile.mock.calls[0][0].text).toBe('a,b\n1,2\n');
      expect(parseText).not.toHaveBeenCalled();
    });

    test('surfaces a size refusal for a document with no readable raw form', async () => {
      const refusal = Object.assign(new Error('pdf-inspector extracted 22MB of text'), {
        name: 'ParserOutputLimitError',
        code: 'PARSER_OUTPUT_LIMIT',
      });
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockRejectedValue(refusal),
      });
      const { parseText } = require('@librechat/api');
      const req = makeReq({ mimetype: PDF_MIME, originalname: 'huge.pdf', ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('pdf-inspector extracted 22MB of text');
      expect(parseText).not.toHaveBeenCalled();
    });

    test('still refuses a binary document the parser cannot read', async () => {
      /* The counterpart: a DOCX has no readable raw form, so storing its bytes would
       * hand the model an archive. The refusal is the honest outcome there. */
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ textSupportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/] }),
      );
      const parserUpload = jest.fn().mockRejectedValue(new Error('anydoc failed'));
      setupDocumentStrategies({ documentParser: parserUpload });
      const { parseText } = require('@librechat/api');
      const req = makeReq({ mimetype: DOCX_MIME, originalname: 'report.docx', ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('anydoc failed');
      expect(db.createFile).not.toHaveBeenCalled();
      expect(parseText).not.toHaveBeenCalled();
    });

    test('does not check OCR capability when using automatic document_parser fallback', async () => {
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('annotates the stored text when the parser reports pages needing OCR', async () => {
      const parserUpload = jest.fn().mockResolvedValue({
        text: 'page one text',
        bytes: 13,
        filepath: FileSources.document_parser,
        pagesNeedingOcr: [2, 3],
      });
      setupDocumentStrategies({ documentParser: parserUpload });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(annotateMissingPages).toHaveBeenCalledWith('page one text', [2, 3]);
      /* A part-scanned document must not be stored as if it were complete: the
       * persisted text carries the notice and bytes are recounted to match. */
      const created = db.createFile.mock.calls[0][0];
      expect(created.text).toBe('page one text\n[omitted:2,3]');
    });

    test('caps the missing-page list written to logs', async () => {
      const pagesNeedingOcr = Array.from({ length: 5000 }, (_, index) => index + 1);
      const parserUpload = jest.fn().mockResolvedValue({
        text: 'partial text',
        bytes: 12,
        filepath: FileSources.document_parser,
        pagesNeedingOcr,
      });
      setupDocumentStrategies({ documentParser: parserUpload });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(summarizeMissingPages).toHaveBeenCalledWith(pagesNeedingOcr);
      const warning = logger.warn.mock.calls.find(([message]) =>
        message.includes('has no extractable text'),
      )?.[0];
      expect(warning).toContain('20 and 4980 more');
      expect(warning).not.toContain('21, 22');
      expect(warning.length).toBeLessThan(300);
    });

    test("stores the parsed record with the document's real MIME type", async () => {
      /* Stored as text/plain, the record forgets what kind of document it was,
       * and the client's extracted-text affordances key on that type. Model
       * routing is unaffected: BaseClient short-circuits on source === text. */
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(db.createFile.mock.calls[0][0].type).toBe(PDF_MIME);
    });

    test.each([DocumentParser.pdf_inspector, DocumentParser.anydoc])(
      'keeps the real MIME type for documents parsed by %s',
      async (marker) => {
        /* The request MIME is retained regardless of which local parser produced the
         * extracted text; production multer has already normalized it upstream. */
        const parserUpload = jest
          .fn()
          .mockResolvedValue({ text: 'parsed', bytes: 6, filepath: marker });
        setupDocumentStrategies({ documentParser: parserUpload });
        const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

        await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

        expect(db.createFile.mock.calls[0][0].type).toBe(PDF_MIME);
      },
    );

    test('an admin document-parser allowlist overrides the built-in defaults', async () => {
      /* The one extraction list that had no admin surface. Narrowing it must be able
       * to take a type out of the parser's reach, the same way `fileConfig.ocr` and
       * `fileConfig.text` already can. */
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ documentParserSupportedMimeTypes: ['application/vnd.ms-excel'] }),
      );
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow();
    });

    test('keeps the admin parser allowlist authoritative for a generic document MIME', async () => {
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ documentParserSupportedMimeTypes: [PDF_MIME] }),
      );
      const req = makeReq({
        mimetype: 'application/octet-stream',
        originalname: 'report.docx',
        ocrConfig: null,
      });
      const { parseText } = require('@librechat/api');

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow(`File type ${DOCX_MIME} is not enabled for document parsing.`);

      expect(getStrategyFunctions).not.toHaveBeenCalled();
      expect(parseText).not.toHaveBeenCalled();
    });

    test('falls back to the built-in defaults when no admin allowlist is set', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig());
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(db.createFile.mock.calls[0][0].type).toBe(PDF_MIME);
    });

    test('keeps the request MIME type for a configured OCR result on an image', async () => {
      const mime = 'image/png';
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [mime] }));
      const ocrUpload = jest.fn().mockResolvedValue({
        text: 'ocr text',
        bytes: 8,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ ocr: ocrUpload });
      const req = makeReq({ mimetype: mime, ocrConfig: { strategy: FileSources.mistral_ocr } });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      /* Production multer normalizes the request MIME upstream; this unit test bypasses
       * multer, so the record keeps the MIME carried by the request. */
      const created = db.createFile.mock.calls[0][0];
      expect(created.type).toBe(mime);
    });

    test('keeps an OCR fallback result on the request MIME type for a partially readable PDF', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const localUpload = jest.fn().mockResolvedValue({
        text: 'local page one',
        bytes: 14,
        filepath: DocumentParser.pdf_inspector,
        pagesNeedingOcr: [2],
      });
      const remoteUpload = jest.fn().mockResolvedValue({
        text: 'OCR recovered both pages',
        bytes: 24,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      const created = db.createFile.mock.calls[0][0];
      expect(created.type).toBe(PDF_MIME);
      expect(created.text).toBe('OCR recovered both pages');
    });

    test('leaves extracted text untouched when every page was extracted', async () => {
      const localUpload = jest.fn().mockResolvedValue({
        text: 'complete text',
        bytes: 42,
        filepath: FileSources.document_parser,
      });
      setupDocumentStrategies({ documentParser: localUpload });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      const created = db.createFile.mock.calls[0][0];
      expect(created.text).toBe('complete text');
    });

    test('uses local document extraction before configured OCR for a text-based PDF', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const localUpload = jest.fn().mockResolvedValue({
        text: 'local PDF text',
        bytes: 14,
        filepath: DocumentParser.pdf_inspector,
      });
      const remoteOCR = jest.fn().mockResolvedValue({
        text: 'remote OCR text',
        bytes: 15,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteOCR });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(localUpload).toHaveBeenCalledTimes(1);
      expect(remoteOCR).not.toHaveBeenCalled();
      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(db.createFile.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          text: 'local PDF text',
          type: PDF_MIME,
        }),
      );
    });

    test.each([
      FileSources.mistral_ocr,
      FileSources.azure_mistral_ocr,
      FileSources.vertexai_mistral_ocr,
    ])(
      'uses configured OCR service %s after local extraction reports a missing page',
      async (strategy) => {
        mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
        const localUpload = jest.fn().mockResolvedValue({
          text: 'local page one',
          bytes: 14,
          filepath: DocumentParser.pdf_inspector,
          pagesNeedingOcr: [2],
        });
        const remoteUpload = jest.fn().mockResolvedValue({
          text: 'OCR recovered both pages',
          bytes: 24,
          filepath: strategy,
        });
        setupDocumentStrategies({ documentParser: localUpload, ocr: remoteUpload });
        const req = makeReq({
          mimetype: PDF_MIME,
          ocrConfig: { strategy },
        });

        await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

        expect(getStrategyFunctions).toHaveBeenNthCalledWith(1, FileSources.document_parser);
        expect(getStrategyFunctions).toHaveBeenNthCalledWith(2, strategy);
        expect(localUpload).toHaveBeenCalledTimes(1);
        expect(remoteUpload).toHaveBeenCalledTimes(1);
        expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      },
    );

    test('defaults missing OCR strategy to Mistral after local extraction needs OCR', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const localUpload = jest.fn().mockResolvedValue({
        text: '',
        bytes: 0,
        filepath: FileSources.document_parser,
        pagesNeedingOcr: [1],
      });
      const remoteUpload = jest.fn().mockResolvedValue({
        text: 'OCR text',
        bytes: 8,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { supportedMimeTypes: [PDF_MIME] },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenNthCalledWith(1, FileSources.document_parser);
      expect(getStrategyFunctions).toHaveBeenNthCalledWith(2, FileSources.mistral_ocr);
    });

    test('throws when OCR is needed but the agent capability is not enabled', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      /* Only OCR is under test here; disabling every capability would trip the
       * separate context guard first. */
      checkCapability.mockImplementation(
        async (_req, capability) => capability !== AgentCapabilities.ocr,
      );
      const localUpload = jest.fn().mockResolvedValue({
        text: '',
        bytes: 0,
        filepath: FileSources.document_parser,
        pagesNeedingOcr: [1],
      });
      const remoteUpload = jest.fn();
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('OCR capability is not enabled for Agents');
    });

    test('preserves partial local text when configured OCR capability is not enabled', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      checkCapability.mockImplementation(
        async (_req, capability) => capability !== AgentCapabilities.ocr,
      );
      const localUpload = jest.fn().mockResolvedValue({
        text: 'local page one',
        bytes: 14,
        filepath: DocumentParser.pdf_inspector,
        pagesNeedingOcr: [2],
      });
      const remoteUpload = jest.fn().mockResolvedValue({
        text: 'remote OCR text',
        bytes: 15,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(remoteUpload).not.toHaveBeenCalled();
      expect(db.createFile.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          text: 'local page one\n[omitted:2]',
          type: PDF_MIME,
        }),
      );
    });

    test.each([
      ['missing PDF pages', PDF_MIME, DocumentParser.pdf_inspector, { pagesNeedingOcr: [2] }],
      ['embedded document media', DOCX_MIME, DocumentParser.anydoc, { mayOmitContent: true }],
    ])(
      'fails closed when strict extracted-text policy cannot inspect %s',
      async (_label, mimetype, filepath, incompleteResult) => {
        mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [mimetype] }));
        checkCapability.mockImplementation(
          async (_req, capability) => capability !== AgentCapabilities.ocr,
        );
        const localUpload = jest.fn().mockResolvedValue({
          text: 'local partial text',
          bytes: 18,
          filepath,
          ...incompleteResult,
        });
        const remoteOCR = jest.fn();
        setupDocumentStrategies({ documentParser: localUpload, ocr: remoteOCR });
        assertExtractedTextInspectable.mockImplementationOnce(({ text }) => {
          expect(text).toBeUndefined();
          throw makeUninspectableExtractedTextError();
        });
        const req = makeReq({
          mimetype,
          originalname: mimetype === PDF_MIME ? 'mixed.pdf' : 'scanned.docx',
          ocrConfig: { strategy: FileSources.mistral_ocr },
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                uninspectable: 'block',
              },
            },
          },
        });

        await expect(
          processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
        ).rejects.toMatchObject({
          code: 'content_filter_uninspectable',
          body: { field: 'extracted_text' },
        });

        expect(localUpload).toHaveBeenCalledTimes(1);
        expect(remoteOCR).not.toHaveBeenCalled();
        expect(db.addAgentResourceFile).not.toHaveBeenCalled();
        expect(db.createFile).not.toHaveBeenCalled();
      },
    );

    test('uses document_parser (no capability check) when OCR capability returns false but no OCR config', async () => {
      /* Only OCR is under test here; disabling every capability would trip the
       * separate context guard first. */
      checkCapability.mockImplementation(
        async (_req, capability) => capability !== AgentCapabilities.ocr,
      );
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('uses document_parser when OCR is configured but the file type is not in OCR supported types', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const req = makeReq({
        mimetype: DOCX_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
      expect(getStrategyFunctions).not.toHaveBeenCalledWith(FileSources.mistral_ocr);
    });

    test('does not invoke any OCR strategy for unsupported MIME types without OCR config', async () => {
      const req = makeReq({ mimetype: 'text/plain', ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('File type text/plain is not supported for text parsing.');

      expect(getStrategyFunctions).not.toHaveBeenCalled();
    });

    test.each([
      ['ODT', ODT_MIME],
      ['ODP', ODP_MIME],
    ])('extracts %s locally before considering configured OCR', async (_, mime) => {
      mergeFileConfig.mockReturnValue(
        makeFileConfig({
          ocrSupportedMimeTypes: [mime],
          documentParserSupportedMimeTypes: [mime],
        }),
      );
      const req = makeReq({
        mimetype: mime,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
      expect(getStrategyFunctions).not.toHaveBeenCalledWith(FileSources.mistral_ocr);
      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
    });

    test('routes ODG directly through configured OCR because it is not a local document type', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [ODG_MIME] }));
      const ocrUpload = jest.fn().mockResolvedValue({
        text: 'OCR text',
        bytes: 8,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ ocr: ocrUpload });
      const req = makeReq({
        mimetype: ODG_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledTimes(2);
      expect(getStrategyFunctions).toHaveBeenNthCalledWith(1, FileSources.mistral_ocr);
      expect(getStrategyFunctions).toHaveBeenNthCalledWith(2, 'local');
    });

    test('throws instead of falling back to parseText when document_parser fails for a document MIME type', async () => {
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockRejectedValue(new Error('No text found in document')),
      });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
      const { parseText } = require('@librechat/api');

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('No text found in document');

      expect(parseText).not.toHaveBeenCalled();
    });

    test('fails closed without persistence when strict extracted text cannot be produced', async () => {
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockRejectedValue(new Error('PRIVATE parser failure')),
      });
      extractInspectableFileText.mockImplementationOnce(async ({ extract }) => {
        try {
          await extract();
        } catch {
          throw makeUninspectableExtractedTextError();
        }
      });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              uninspectable: 'block',
            },
          },
        },
      });
      req.file.originalname = 'PRIVATE-report.pdf';

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: {
          error: 'content_filter_uninspectable',
          source: 'file',
          field: 'extracted_text',
        },
      });

      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('file_id=file-uuid-123'), {
        type: 'Error',
      });
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('PRIVATE');
    });

    test('fails closed without persistence when strict extracted text is blank', async () => {
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest
          .fn()
          .mockResolvedValue({ text: '   ', bytes: 3, filepath: 'doc://empty' }),
      });
      assertExtractedTextInspectable.mockImplementationOnce(() => {
        throw makeUninspectableExtractedTextError();
      });
      const req = makeReq({
        mimetype: DOCX_MIME,
        ocrConfig: null,
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              uninspectable: 'block',
            },
          },
        },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: { field: 'extracted_text' },
      });

      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    test('fails closed when generic configured text extraction throws', async () => {
      const customMime = 'application/x-private-document';
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: [customMime] }));
      const { parseText } = require('@librechat/api');
      parseText.mockRejectedValueOnce(new Error('PRIVATE native extraction failure'));
      extractInspectableFileText.mockImplementationOnce(async ({ extract }) => {
        try {
          await extract();
        } catch {
          throw makeUninspectableExtractedTextError();
        }
      });
      const req = makeReq({
        mimetype: customMime,
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              uninspectable: 'block',
            },
          },
        },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: { field: 'extracted_text' },
      });

      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    test('uses configured OCR when local extraction returns no text for a document MIME type', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const localUpload = jest.fn().mockResolvedValue({
        text: '',
        bytes: 0,
        filepath: DocumentParser.pdf_inspector,
        pagesNeedingOcr: [1],
      });
      const remoteUpload = jest.fn().mockResolvedValue({
        text: 'OCR text',
        bytes: 8,
        filepath: FileSources.mistral_ocr,
      });
      setupDocumentStrategies({ documentParser: localUpload, ocr: remoteUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).resolves.not.toThrow();

      expect(getStrategyFunctions).toHaveBeenNthCalledWith(1, FileSources.document_parser);
      expect(getStrategyFunctions).toHaveBeenNthCalledWith(2, FileSources.mistral_ocr);
      expect(db.createFile.mock.calls[0][0]).toEqual(expect.objectContaining({ text: 'OCR text' }));
    });

    test('propagates a ZIP-bomb refusal without sending the archive to configured OCR', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [DOCX_MIME] }));
      const zipBombError = Object.assign(new Error('zip bomb suspected'), {
        name: 'ZipBombError',
        code: 'ZIP_BOMB',
      });
      const localUpload = jest.fn().mockRejectedValue(zipBombError);
      const remoteUpload = jest.fn().mockResolvedValue({
        text: 'remote OCR text',
        bytes: 15,
        filepath: FileSources.mistral_ocr,
      });
      getStrategyFunctions.mockImplementation((source) => ({
        handleFileUpload: source === FileSources.document_parser ? localUpload : remoteUpload,
      }));
      const req = makeReq({
        mimetype: DOCX_MIME,
        originalname: 'hostile.docx',
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toBe(zipBombError);

      expect(localUpload).toHaveBeenCalledTimes(1);
      expect(remoteUpload).not.toHaveBeenCalled();
      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
    });

    test('propagates a parser input-limit refusal without sending the file to configured OCR', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [DOCX_MIME] }));
      const inputLimitError = Object.assign(new Error('report.docx exceeds the 15MB limit'), {
        name: 'ParserInputLimitError',
        code: 'PARSER_INPUT_LIMIT',
        userErrorStatusCode: 413,
      });
      const localUpload = jest.fn().mockRejectedValue(inputLimitError);
      const remoteUpload = jest.fn().mockResolvedValue({
        text: 'remote OCR text',
        bytes: 15,
        filepath: FileSources.mistral_ocr,
      });
      getStrategyFunctions.mockImplementation((source) => ({
        handleFileUpload: source === FileSources.document_parser ? localUpload : remoteUpload,
      }));
      const req = makeReq({
        mimetype: DOCX_MIME,
        originalname: 'report.docx',
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toBe(inputLimitError);

      expect(localUpload).toHaveBeenCalledTimes(1);
      expect(remoteUpload).not.toHaveBeenCalled();
      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
    });

    test('propagates a PDF page-limit refusal without sending the PDF to configured OCR', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const pageLimitError = Object.assign(
        new Error('PDF contains 4000 pages, exceeding the 250-page fallback limit'),
        {
          name: 'PdfPageLimitError',
          code: 'PDF_PAGE_LIMIT',
        },
      );
      const localUpload = jest.fn().mockRejectedValue(pageLimitError);
      const remoteUpload = jest.fn().mockResolvedValue({
        text: 'remote OCR text',
        bytes: 15,
        filepath: FileSources.mistral_ocr,
      });
      getStrategyFunctions.mockImplementation((source) => ({
        handleFileUpload: source === FileSources.document_parser ? localUpload : remoteUpload,
      }));
      const req = makeReq({
        mimetype: PDF_MIME,
        originalname: 'page-flood.pdf',
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toBe(pageLimitError);

      expect(localUpload).toHaveBeenCalledTimes(1);
      expect(remoteUpload).not.toHaveBeenCalled();
      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
    });

    test('does not bypass the document-parser allowlist when configured OCR fails', async () => {
      mergeFileConfig.mockReturnValue(
        makeFileConfig({
          ocrSupportedMimeTypes: [PDF_MIME],
          documentParserSupportedMimeTypes: [DOCX_MIME],
        }),
      );
      const failingUpload = jest.fn().mockRejectedValue(new Error('OCR API returned 500'));
      getStrategyFunctions.mockReturnValue({ handleFileUpload: failingUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow(/configured OCR service/);

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.mistral_ocr);
      expect(getStrategyFunctions).not.toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('throws when both local extraction and configured OCR fail', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockRejectedValue(new Error('failure')),
      });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });
      const { parseText } = require('@librechat/api');

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('failure');

      expect(parseText).not.toHaveBeenCalled();
    });
  });

  describe('configured text (RAG) routing for document MIME types', () => {
    const DOCX_TEXT_REGEX = [
      /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
    ];
    let originalRagUrl;

    beforeEach(() => {
      originalRagUrl = process.env.RAG_API_URL;
    });

    afterEach(() => {
      if (originalRagUrl === undefined) {
        delete process.env.RAG_API_URL;
      } else {
        process.env.RAG_API_URL = originalRagUrl;
      }
    });

    test('routes a document type to RAG /text (no native fallback) when admin narrows text config and RAG is set', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: DOCX_TEXT_REGEX }));
      const { parseText } = require('@librechat/api');
      parseText.mockResolvedValueOnce({ text: 'rag extracted', bytes: 13 });
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(parseText).toHaveBeenCalledWith(
        expect.objectContaining({ allowNativeFallback: false }),
      );
      expect(getStrategyFunctions).not.toHaveBeenCalledWith(FileSources.document_parser);
    });

    /**
     * Naming a type in the text allowlist while removing it from the parser allowlist is
     * how an admin says "RAG handles this one". Reading local-parser eligibility to decide
     * the RAG route turned that pair of settings into a refused upload.
     */
    test('routes to RAG /text for a type the admin removed from the local parser', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(
        makeFileConfig({
          textSupportedMimeTypes: DOCX_TEXT_REGEX,
          documentParserSupportedMimeTypes: [/^application\/pdf$/],
        }),
      );
      const { parseText } = require('@librechat/api');
      parseText.mockResolvedValueOnce({ text: 'rag extracted', bytes: 13 });
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(parseText).toHaveBeenCalledWith(
        expect.objectContaining({ allowNativeFallback: false }),
      );
      expect(db.createFile.mock.calls[0][0].text).toBe('rag extracted');
    });

    test('keeps the built-in document parser when text config is the permissive default', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ textSupportedMimeTypes: [/^[\w.-]+\/[\w.-]+$/] }),
      );
      const { parseText } = require('@librechat/api');
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
      expect(parseText).not.toHaveBeenCalled();
    });

    test('keeps the built-in document parser when RAG_API_URL is not configured', async () => {
      delete process.env.RAG_API_URL;
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: DOCX_TEXT_REGEX }));
      const { parseText } = require('@librechat/api');
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
      expect(parseText).not.toHaveBeenCalled();
    });

    test('falls back to the built-in document parser (not native text) when RAG is unavailable', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: DOCX_TEXT_REGEX }));
      const { parseText } = require('@librechat/api');
      parseText.mockRejectedValueOnce(new Error('native fallback is disabled'));
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).resolves.not.toThrow();

      expect(parseText).toHaveBeenCalledWith(
        expect.objectContaining({ allowNativeFallback: false }),
      );
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('fails closed when RAG and its document-parser fallback cannot extract text', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: DOCX_TEXT_REGEX }));
      const { parseText } = require('@librechat/api');
      parseText.mockRejectedValueOnce(new Error('PRIVATE RAG failure'));
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockRejectedValue(new Error('PRIVATE parser failure')),
      });
      extractInspectableFileText.mockImplementationOnce(async ({ extract }) => {
        try {
          await extract();
        } catch {
          throw makeUninspectableExtractedTextError();
        }
      });
      const req = makeReq({
        mimetype: DOCX_MIME,
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              uninspectable: 'block',
            },
          },
        },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: { field: 'extracted_text' },
      });

      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    test('annotates omitted pages and keeps the real MIME type on the RAG fallback', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: DOCX_TEXT_REGEX }));
      const { parseText } = require('@librechat/api');
      parseText.mockRejectedValueOnce(new Error('native fallback is disabled'));
      const parserUpload = jest.fn().mockResolvedValue({
        text: 'page one text',
        bytes: 13,
        filepath: FileSources.document_parser,
        pagesNeedingOcr: [2, 3],
      });
      setupDocumentStrategies({ documentParser: parserUpload });
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      /* The extraction result supplies the annotation and MIME remains the request's
       * effective type; storage fields come from the separate local upload. */
      expect(annotateMissingPages).toHaveBeenCalledWith('page one text', [2, 3]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('page(s) 2, 3'));
      const created = db.createFile.mock.calls[0][0];
      expect(created.text).toBe('page one text\n[omitted:2,3]');
      expect(created.type).toBe(DOCX_MIME);
    });

    /**
     * The fallback's own partial result: RAG is gone, this route configures no OCR
     * service to complete the text with, and the parser read only part of the document.
     * A nonempty string is not evidence the document was inspected, so the strict
     * policy has to refuse it here exactly as it does on the primary parser path.
     */
    test('fails closed when the RAG fallback can only extract part of the document', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: DOCX_TEXT_REGEX }));
      const { parseText } = require('@librechat/api');
      parseText.mockRejectedValueOnce(new Error('native fallback is disabled'));
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockResolvedValue({
          text: 'page one text',
          bytes: 13,
          filepath: FileSources.document_parser,
          pagesNeedingOcr: [2, 3],
        }),
      });
      assertExtractedTextInspectable.mockImplementationOnce(({ text }) => {
        expect(text).toBeUndefined();
        throw makeUninspectableExtractedTextError();
      });
      const req = makeReq({
        mimetype: DOCX_MIME,
        ocrConfig: null,
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              uninspectable: 'block',
            },
          },
        },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toMatchObject({
        code: 'content_filter_uninspectable',
        body: { field: 'extracted_text' },
      });

      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
      expect(db.createFile).not.toHaveBeenCalled();
    });

    test('surfaces a persistence failure without retrying via the document parser', async () => {
      process.env.RAG_API_URL = 'http://rag-api.test';
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: DOCX_TEXT_REGEX }));
      const { parseText } = require('@librechat/api');
      parseText.mockResolvedValueOnce({ text: 'rag extracted', bytes: 13 });
      // RAG extraction succeeds, but persisting the result fails.
      db.createFile.mockRejectedValueOnce(new Error('DB down'));
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('DB down');

      // The persistence failure must not trigger a second extraction via the built-in parser.
      expect(getStrategyFunctions).not.toHaveBeenCalledWith(FileSources.document_parser);
    });
  });

  describe('text size guard', () => {
    test('throws before writing to MongoDB when extracted text exceeds 15MB', async () => {
      const oversizedText = 'x'.repeat(15 * 1024 * 1024 + 1);
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockResolvedValue({
          text: oversizedText,
          bytes: Buffer.byteLength(oversizedText, 'utf8'),
          filepath: FileSources.document_parser,
        }),
      });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
      const { createFile } = require('~/models');

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow(/exceeds the 15MB storage limit/);

      expect(createFile).not.toHaveBeenCalled();
    });

    test('succeeds when extracted text is within the 15MB limit', async () => {
      const okText = 'x'.repeat(1024);
      getStrategyFunctions.mockReturnValue({
        handleFileUpload: jest.fn().mockResolvedValue({
          text: okText,
          bytes: Buffer.byteLength(okText, 'utf8'),
          filepath: FileSources.document_parser,
        }),
      });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).resolves.not.toThrow();
    });
  });

  describe('retention for agent resource uploads', () => {
    test('skips retention metadata for persistent agent context files outside all-data retention when retainAgentFiles is disabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.TEMPORARY, retainAgentFiles: false },
        body: { conversationId: 'temporary-convo', isTemporary: true },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getAgentFileRetentionExpiry).toHaveBeenCalledWith(
        {
          req,
          messageAttachment: false,
          toolResource: EToolResources.context,
        },
        expect.any(Object),
      );
      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('skips retention metadata for persistent agent context files outside all-data retention when retainAgentFiles is enabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.TEMPORARY, retainAgentFiles: true },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('applies all-data retention metadata to persistent agent context files when retainAgentFiles is disabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.ALL, retainAgentFiles: false },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.agents,
        }),
        true,
      );
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('skips all-data retention metadata for persistent agent context files when retainAgentFiles is enabled', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.ALL, retainAgentFiles: true },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(getAgentFileRetentionExpiry).toHaveBeenCalledWith(
        {
          req,
          messageAttachment: false,
          toolResource: EToolResources.context,
        },
        expect.any(Object),
      );
      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          context: FileContext.agents,
        }),
        true,
      );
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
    });

    test('applies retention metadata to context files uploaded as message attachments', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { ...makeMetadata(), message_file: true },
      });

      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.message_attachment,
        }),
        true,
      );
      expect(db.addAgentResourceFile).not.toHaveBeenCalled();
    });

    test('skips retention metadata for persistent agent file-search files outside all-data retention', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      setupStoredFileUpload();
      const req = makeReq({ mimetype: 'text/plain', ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { ...makeMetadata(), tool_resource: EToolResources.file_search },
      });

      expect(uploadVectors).toHaveBeenCalled();
      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.file_search,
        }),
      );
    });

    test('applies all-data retention metadata to persistent agent file-search files', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      setupStoredFileUpload();
      const req = makeReq({
        mimetype: 'text/plain',
        ocrConfig: null,
        interfaceConfig: { retentionMode: RetentionMode.ALL },
      });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { ...makeMetadata(), tool_resource: EToolResources.file_search },
      });

      expect(uploadVectors).toHaveBeenCalled();
      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.agents,
        }),
        true,
      );
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.file_search,
        }),
      );
    });
  });

  /* Phase C / option α regression: the upload must persist its sandbox
   * pointer under `metadata.codeEnvRef` (the post-cutover schema). The
   * legacy `metadata.fileIdentifier` key is silently stripped by mongoose
   * strict mode and downstream readers (`primeFiles`, `getCodeFilesByIds`,
   * `categorizeFileForToolResources`, controller filtering) only check
   * `codeEnvRef`. Storing under the legacy key would orphan the file —
   * priming would skip it on subsequent code-execution turns and the
   * sandbox copy would never re-mount. */
  describe('execute_code uploads persist codeEnvRef metadata', () => {
    const fs = require('fs');
    const { Readable } = require('stream');
    let createReadStreamSpy;

    beforeEach(() => {
      /* `processAgentFileUpload` opens the multer-staged temp file via
       * `fs.createReadStream`. The test fixture path doesn't exist, so
       * stub it to a tiny in-memory stream. */
      createReadStreamSpy = jest
        .spyOn(fs, 'createReadStream')
        .mockImplementation(() => Readable.from(Buffer.from('')));
    });

    afterEach(() => {
      createReadStreamSpy.mockRestore();
    });

    const setupCodeEnvUpload = (uploaded) => {
      /* `processAgentFileUpload` calls `getStrategyFunctions` twice:
       * once with `execute_code` for the codeapi upload, then again with
       * the on-disk strategy (`local`) for the standard storage step that
       * runs in the same flow. Both must return a working
       * `handleFileUpload`. */
      const codeEnvUpload = jest.fn().mockResolvedValue(uploaded);
      const localUpload = jest.fn().mockResolvedValue({
        bytes: 0,
        filename: 'upload.bin',
        filepath: '/uploads/upload.bin',
      });
      getStrategyFunctions.mockImplementation((src) =>
        src === FileSources.execute_code
          ? { handleFileUpload: codeEnvUpload }
          : {
              handleFileUpload: localUpload,
              getDownloadStream: jest.fn(async () => Readable.from(Buffer.from('stored'))),
              saveBuffer: jest.fn(),
            },
      );
      return codeEnvUpload;
    };

    const agentsZipReq = () => {
      const req = makeReq({ mimetype: 'application/zip', ocrConfig: null });
      req.body.endpoint = EModelEndpoint.agents;
      return req;
    };

    it('leaves a promoted code destination for deferred provisioning', async () => {
      /* No explicit choice stands behind a promotion, and the agent's code deployment is
       * resolved per turn, so uploading now names the default route and has to be
       * uploaded again where the turn actually runs. */
      const codeEnvUpload = setupCodeEnvUpload({ storage_session_id: 'sess-x', file_id: 'fid-x' });

      await processAgentFileUpload({
        req: agentsZipReq(),
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          file_id: 'file-promoted',
          agentTools: [EToolResources.execute_code],
        },
      }).catch(() => {});

      expect(codeEnvUpload).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.not.objectContaining({ codeEnvRef: expect.anything() }),
        }),
        true,
      );
    });

    it('still uploads eagerly when the user chose the code destination', async () => {
      const codeEnvUpload = setupCodeEnvUpload({ storage_session_id: 'sess-y', file_id: 'fid-y' });

      await processAgentFileUpload({
        req: agentsZipReq(),
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-chosen',
        },
      }).catch(() => {});

      expect(codeEnvUpload).toHaveBeenCalled();
    });

    it('retries a throttled eager upload with a fresh persisted stream', async () => {
      const rateLimited = Object.assign(new Error('rate limited'), {
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': '1' } },
      });
      const codeEnvUpload = setupCodeEnvUpload({ storage_session_id: 'sess-y', file_id: 'fid-y' });
      codeEnvUpload
        .mockRejectedValueOnce(rateLimited)
        .mockResolvedValueOnce({ storage_session_id: 'sess-retry', file_id: 'fid-retry' });

      await processAgentFileUpload({
        req: agentsZipReq(),
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-throttled',
        },
      }).catch(() => {});

      expect(getCodeApiUploadOptions).toHaveBeenCalledTimes(1);
      expect(withCodeApiUploadRecovery).toHaveBeenCalledTimes(1);
      expect(createCodeApiRateLimitBudget).toHaveBeenCalledTimes(1);
      expect(codeEnvUpload).toHaveBeenCalledTimes(2);
      expect(codeEnvUpload.mock.calls[0][0].stream).not.toBe(codeEnvUpload.mock.calls[1][0].stream);
    });

    it('defers an inferred file-search destination until tool execution', async () => {
      const { uploadVectors } = require('~/server/services/Files/VectorDB/crud');
      setupStoredFileUpload();
      /* A type file search can read and no extractor can: a presentation itself is
       * parsed to text now, which would route it to context instead of deferring. */
      const req = makeReq({
        mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.template',
        ocrConfig: null,
      });
      req.body.endpoint = EModelEndpoint.agents;

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          file_id: 'file-inferred-search',
          agentTools: [EToolResources.file_search],
        },
      });

      expect(uploadVectors).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          llmDeliveryPath: 'none',
          metadata: expect.not.objectContaining({ embeddedEntities: expect.anything() }),
        }),
        true,
      );
    });

    it('uploads converted image bytes under the converted extension', async () => {
      const codeEnvUpload = jest
        .fn()
        .mockResolvedValue({ storage_session_id: 'sess-image', file_id: 'fid-image' });
      const convertedStream = Readable.from(Buffer.from('webp'));
      getStrategyFunctions.mockImplementation((src) =>
        src === FileSources.execute_code
          ? { handleFileUpload: codeEnvUpload }
          : {
              handleImageUpload: jest.fn().mockResolvedValue({
                filepath: '/images/photo.webp',
                bytes: 4,
                width: 10,
                height: 10,
              }),
              getDownloadStream: jest.fn().mockResolvedValue(convertedStream),
            },
      );
      const req = makeReq({ mimetype: 'image/jpeg', ocrConfig: null });
      req.file.originalname = 'photo.jpg';
      req.body.endpoint = EModelEndpoint.agents;

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-image',
        },
      });

      expect(codeEnvUpload).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'photo.webp', stream: convertedStream }),
      );
    });

    it('removes durable storage when an eager code upload fails', async () => {
      const deleteFile = jest.fn().mockResolvedValue(undefined);
      getStrategyFunctions.mockImplementation((src) =>
        src === FileSources.execute_code
          ? { handleFileUpload: jest.fn().mockRejectedValue(new Error('code unavailable')) }
          : {
              handleFileUpload: jest.fn().mockResolvedValue({
                filepath: '/uploads/user-123/stored.bin',
                bytes: 4,
              }),
              getDownloadStream: jest.fn(async () => Readable.from(Buffer.from('stored'))),
              deleteFile,
            },
      );

      await expect(
        processAgentFileUpload({
          req: agentsZipReq(),
          res: mockRes,
          metadata: {
            agent_id: 'agent-abc',
            tool_resource: EToolResources.execute_code,
            file_id: 'file-cleanup',
          },
        }),
      ).rejects.toThrow('code unavailable');

      expect(deleteFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          file_id: 'file-cleanup',
          filepath: '/uploads/user-123/stored.bin',
        }),
      );
      expect(db.createFile).not.toHaveBeenCalled();
    });

    it('persists kind:user codeEnvRef for chat attachments (messageAttachment=true)', async () => {
      setupCodeEnvUpload({ storage_session_id: 'sess-1', file_id: 'fid-1' });
      const req = makeReq();
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
          message_file: true,
        },
      });

      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            codeEnvRef: {
              kind: 'user',
              id: 'user-123',
              storage_session_id: 'sess-1',
              file_id: 'fid-1',
              executionProfile: 'default',
              provisionedAt: expect.any(Number),
            },
            codeEnvRefs: {
              default: {
                kind: 'user',
                id: 'user-123',
                storage_session_id: 'sess-1',
                file_id: 'fid-1',
                executionProfile: 'default',
                provisionedAt: expect.any(Number),
              },
            },
          }),
        }),
        true,
      );
    });

    it('persists kind:agent codeEnvRef for agent setup files (messageAttachment=false)', async () => {
      setupCodeEnvUpload({ storage_session_id: 'sess-2', file_id: 'fid-2' });
      const req = makeReq();
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
        },
      });

      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            codeEnvRef: {
              kind: 'agent',
              id: 'agent-abc',
              storage_session_id: 'sess-2',
              file_id: 'fid-2',
              executionProfile: 'default',
              provisionedAt: expect.any(Number),
            },
            codeEnvRefs: {
              default: {
                kind: 'agent',
                id: 'agent-abc',
                storage_session_id: 'sess-2',
                file_id: 'fid-2',
                executionProfile: 'default',
                provisionedAt: expect.any(Number),
              },
            },
          }),
        }),
        true,
      );
    });

    it('skips retention metadata for persistent agent execute_code files outside all-data retention', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      setupCodeEnvUpload({ storage_session_id: 'sess-4', file_id: 'fid-4' });
      const req = makeReq();

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
        },
      });

      expect(getRetentionExpiry).not.toHaveBeenCalled();
      expect(db.createFile).toHaveBeenCalledWith(expect.not.objectContaining({ expiredAt }), true);
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
        }),
      );
    });

    it('applies all-data retention metadata to persistent agent execute_code files', async () => {
      const expiredAt = new Date('2030-01-01T00:00:00.000Z');
      getRetentionExpiry.mockResolvedValueOnce({ expiredAt });
      setupCodeEnvUpload({ storage_session_id: 'sess-5', file_id: 'fid-5' });
      const req = makeReq({ interfaceConfig: { retentionMode: RetentionMode.ALL } });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
        },
      });

      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      expect(getRetentionExpiry.mock.calls[0][0]).toBe(req);
      expect(db.createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          expiredAt,
          context: FileContext.agents,
          metadata: expect.objectContaining({
            codeEnvRef: {
              kind: 'agent',
              id: 'agent-abc',
              storage_session_id: 'sess-5',
              file_id: 'fid-5',
              executionProfile: 'default',
              provisionedAt: expect.any(Number),
            },
            codeEnvRefs: {
              default: {
                kind: 'agent',
                id: 'agent-abc',
                storage_session_id: 'sess-5',
                file_id: 'fid-5',
                executionProfile: 'default',
                provisionedAt: expect.any(Number),
              },
            },
          }),
        }),
        true,
      );
      expect(db.addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
        }),
      );
    });

    it('does not persist legacy fileIdentifier key (mongoose strict drops it)', async () => {
      setupCodeEnvUpload({ storage_session_id: 'sess-3', file_id: 'fid-3' });
      const req = makeReq();
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'file-uuid',
          message_file: true,
        },
      });

      const persisted = db.createFile.mock.calls[0][0];
      expect(persisted.metadata).not.toHaveProperty('fileIdentifier');
    });
  });

  describe('text delivery storage', () => {
    test('stores the original file durably for plain text delivery records', async () => {
      const { parseText } = require('@librechat/api');
      const { createFile } = require('~/models');
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      mergeFileConfig.mockReturnValue(makeFileConfig({ textSupportedMimeTypes: ['text/plain'] }));
      parseText.mockResolvedValueOnce({ text: 'plain extracted text', bytes: 20 });
      getStrategyFunctions.mockReturnValue({ handleFileUpload: storageUpload });
      const req = makeReq({ mimetype: 'text/plain', ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(storageUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          file_id: 'file-uuid-123',
          file: expect.objectContaining({ originalname: 'upload.bin' }),
        }),
      );
      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'plain extracted text',
          bytes: 128,
          filepath: '/uploads/user-123/file-uuid-123__upload.bin',
          source: FileSources.local,
          filename: 'upload.bin',
          type: 'text/plain',
          llmDeliveryPath: 'text',
        }),
        true,
      );
    });

    test('stores the original file durably for OCR delivery records', async () => {
      const { createFile } = require('~/models');
      const documentUpload = jest.fn().mockResolvedValue({
        text: 'ocr extracted text',
        bytes: 42,
        filepath: 'document_parser',
      });
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 4096,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockImplementation((source) => {
        if (source === FileSources.document_parser) {
          return { handleFileUpload: documentUpload };
        }
        return { handleFileUpload: storageUpload };
      });
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(documentUpload).toHaveBeenCalled();
      expect(storageUpload).toHaveBeenCalled();
      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'ocr extracted text',
          bytes: 4096,
          filepath: '/uploads/user-123/file-uuid-123__upload.bin',
          source: FileSources.local,
          filename: 'upload.bin',
          type: PDF_MIME,
          llmDeliveryPath: 'text',
        }),
        true,
      );
    });
  });

  describe('explicit legacy tool delivery path', () => {
    test('persists llmDeliveryPath none for explicit file_search uploads', async () => {
      const { createFile } = require('~/models');
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockReturnValue({ handleFileUpload: storageUpload });
      mergeFileConfig.mockReturnValue({
        ...makeFileConfig(),
        defaultLLMDeliveryPath: {
          fallback: 'text',
        },
      });
      const req = makeReq({ mimetype: 'text/markdown', ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          ...makeMetadata(),
          tool_resource: EToolResources.file_search,
        },
      });

      expect(checkCapability).toHaveBeenCalledWith(
        expect.anything(),
        AgentCapabilities.file_search,
      );
      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filepath: '/uploads/user-123/file-uuid-123__upload.bin',
          source: FileSources.local,
          type: 'text/markdown',
          embedded: true,
          llmDeliveryPath: 'none',
        }),
        true,
      );
    });

    test('persists llmDeliveryPath provider for legacy provider uploads without tool_resource', async () => {
      const { createFile } = require('~/models');
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockReturnValue({ handleFileUpload: storageUpload });
      mergeFileConfig.mockReturnValue({
        ...makeFileConfig(),
        endpoints: {
          [EModelEndpoint.agents]: { legacyFileUploadUX: true },
        },
        defaultLLMDeliveryPath: {
          fallback: 'none',
        },
      });
      const req = makeReq({ mimetype: 'text/markdown', ocrConfig: null });
      req.body.endpoint = EModelEndpoint.agents;

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          message_file: 'true',
          file_id: 'file-uuid-123',
        },
      });

      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filepath: '/uploads/user-123/file-uuid-123__upload.bin',
          source: FileSources.local,
          type: 'text/markdown',
          llmDeliveryPath: 'provider',
        }),
        true,
      );
    });

    test('rejects ordinary chat audio when no speech provider can consume it', async () => {
      /* Transcription needs exactly one non-empty provider block. A schema holding only
       * allowedAddresses reports STT present while the service refuses it, so routing
       * audio to text there sends the upload to a transcription that cannot run. */
      const { createFile } = require('~/models');
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockReturnValue({ handleFileUpload: storageUpload });
      mergeFileConfig.mockReturnValue(makeFileConfig());
      const req = makeReq({
        mimetype: 'audio/mpeg',
        ocrConfig: null,
        speech: { stt: { allowedAddresses: ['127.0.0.1'] } },
      });
      req.body.endpoint = EModelEndpoint.openAI;

      const error = await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { agent_id: 'agent-abc', message_file: 'true', file_id: 'file-uuid-123' },
      }).catch((thrown) => thrown);

      expect(error).toEqual(
        expect.objectContaining({ message: expect.stringMatching(/no agent/i) }),
      );
      expect(createFile).not.toHaveBeenCalled();
    });

    test('retains an auto-routed context upload as an agent resource', async () => {
      const { getAgentFileRetentionExpiry } = require('@librechat/api');
      mergeFileConfig.mockReturnValue(makeFileConfig());
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { agent_id: 'agent-abc', file_id: 'file-uuid-123' },
      }).catch(() => {});

      expect(getAgentFileRetentionExpiry).toHaveBeenCalledWith(
        expect.objectContaining({ toolResource: EToolResources.context }),
        expect.any(Object),
      );
    });

    test('plans extraction with the promoted context resource for auto-routed text uploads', async () => {
      const { planDocumentExtraction } = require('@librechat/api');
      mergeFileConfig.mockReturnValue(makeFileConfig());
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      /** The planner runs before extraction; downstream extraction is covered by the
       *  OCR strategy tests, so failures past this point must not mask the argument. */
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { agent_id: 'agent-abc', file_id: 'file-uuid-123' },
      }).catch(() => {});

      expect(planDocumentExtraction).toHaveBeenCalledWith(
        expect.objectContaining({ toolResource: EToolResources.context }),
      );
    });

    test('routes under the provider endpoint the caller resolved', async () => {
      /* The route resolves the agent's provider once, before validation, and hands it
       * down so acceptance and routing use one configuration. */
      const { createFile } = require('~/models');
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockReturnValue({ handleFileUpload: storageUpload });
      mergeFileConfig.mockReturnValue({
        ...makeFileConfig(),
        endpoints: {
          'Custom Provider': { defaultLLMDeliveryPath: { fallback: 'none' } },
        },
      });
      const req = makeReq({ mimetype: 'text/markdown', ocrConfig: null });
      req.body.endpoint = EModelEndpoint.agents;

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          message_file: 'true',
          file_id: 'file-uuid-123',
          effectiveEndpoint: 'Custom Provider',
        },
      });

      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({ llmDeliveryPath: 'none' }),
        true,
      );
    });

    test('persists llmDeliveryPath none for explicit execute_code uploads', async () => {
      const { createFile } = require('~/models');
      const codeUpload = jest
        .fn()
        .mockResolvedValue({ storage_session_id: 'sess-csv', file_id: 'fid-csv' });
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockImplementation((source) => {
        if (source === FileSources.execute_code) {
          return { handleFileUpload: codeUpload };
        }
        return { handleFileUpload: storageUpload };
      });
      mergeFileConfig.mockReturnValue({
        ...makeFileConfig(),
        defaultLLMDeliveryPath: {
          fallback: 'text',
        },
      });
      const req = makeReq({ mimetype: 'text/csv', ocrConfig: null });
      req.file.path = __filename;

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          ...makeMetadata(),
          tool_resource: EToolResources.execute_code,
        },
      });

      expect(checkCapability).toHaveBeenCalledWith(
        expect.anything(),
        AgentCapabilities.execute_code,
      );
      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          filepath: '/uploads/user-123/file-uuid-123__upload.bin',
          source: FileSources.local,
          type: 'text/csv',
          metadata: expect.objectContaining({
            codeEnvRef: {
              kind: 'agent',
              id: 'agent-abc',
              storage_session_id: 'sess-csv',
              file_id: 'fid-csv',
              executionProfile: 'default',
              provisionedAt: expect.any(Number),
            },
            codeEnvRefs: {
              default: {
                kind: 'agent',
                id: 'agent-abc',
                storage_session_id: 'sess-csv',
                file_id: 'fid-csv',
                executionProfile: 'default',
                provisionedAt: expect.any(Number),
              },
            },
          }),
          llmDeliveryPath: 'none',
        }),
        true,
      );
    });

    test('persists llmDeliveryPath text for explicit context uploads', async () => {
      const { parseText } = require('@librechat/api');
      const { createFile } = require('~/models');
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockReturnValue({ handleFileUpload: storageUpload });
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ textSupportedMimeTypes: ['text/markdown'] }),
      );
      parseText.mockResolvedValueOnce({ text: 'markdown text', bytes: 13 });
      const req = makeReq({ mimetype: 'text/markdown', ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          ...makeMetadata(),
          tool_resource: EToolResources.context,
        },
      });

      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'markdown text',
          filepath: '/uploads/user-123/file-uuid-123__upload.bin',
          source: FileSources.local,
          type: 'text/markdown',
          llmDeliveryPath: 'text',
        }),
        true,
      );
    });

    test('normalizes explicit ocr uploads to context text delivery', async () => {
      const { parseText } = require('@librechat/api');
      const { createFile, addAgentResourceFile } = require('~/models');
      const storageUpload = jest.fn().mockResolvedValue({
        filepath: '/uploads/user-123/file-uuid-123__upload.bin',
        bytes: 128,
        filename: 'upload.bin',
        embedded: false,
      });
      getStrategyFunctions.mockReturnValue({ handleFileUpload: storageUpload });
      mergeFileConfig.mockReturnValue(
        makeFileConfig({ textSupportedMimeTypes: ['text/markdown'] }),
      );
      parseText.mockResolvedValueOnce({ text: 'markdown text', bytes: 13 });
      const req = makeReq({ mimetype: 'text/markdown', ocrConfig: null });

      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          ...makeMetadata(),
          tool_resource: EToolResources.ocr,
        },
      });

      expect(addAgentResourceFile).toHaveBeenCalledWith(
        expect.objectContaining({
          file_id: 'file-uuid-123',
          agent_id: 'agent-abc',
          tool_resource: EToolResources.context,
        }),
      );
      expect(createFile).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'markdown text',
          source: FileSources.local,
          type: 'text/markdown',
          llmDeliveryPath: 'text',
        }),
        true,
      );
    });
  });
});

describe('processImageFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRes.status.mockReturnThis();
    mockRes.json.mockReturnValue({});
    mergeFileConfig.mockReturnValue(makeFileConfig());
  });

  test('persists resolved llmDeliveryPath for image uploads', async () => {
    const { createFile } = require('~/models');
    const handleImageUpload = jest.fn().mockResolvedValue({
      filepath: '/images/user-123/image.webp',
      bytes: 256,
      width: 100,
      height: 80,
    });
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      defaultLLMDeliveryPath: {
        overrides: { 'image/*': 'none' },
      },
    });
    getStrategyFunctions.mockReturnValue({ handleImageUpload });
    const req = makeReq({ mimetype: 'image/png', ocrConfig: null });

    await processImageFile({
      req,
      res: mockRes,
      metadata: {
        file_id: 'image-file-id',
        temp_file_id: 'temp-image-file-id',
        endpoint: EModelEndpoint.agents,
      },
    });

    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'image-file-id',
        temp_file_id: 'temp-image-file-id',
        filepath: '/images/user-123/image.webp',
        source: FileSources.local,
        type: 'image/webp',
        llmDeliveryPath: 'none',
      }),
      true,
    );
  });

  test('persists provider llmDeliveryPath for legacy image provider uploads', async () => {
    const { createFile } = require('~/models');
    const handleImageUpload = jest.fn().mockResolvedValue({
      filepath: '/images/user-123/image.webp',
      bytes: 256,
      width: 100,
      height: 80,
    });
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      endpoints: {
        [EModelEndpoint.agents]: { legacyFileUploadUX: true },
      },
      defaultLLMDeliveryPath: {
        overrides: { 'image/*': 'none' },
      },
    });
    getStrategyFunctions.mockReturnValue({ handleImageUpload });
    const req = makeReq({ mimetype: 'image/png', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processImageFile({
      req,
      res: mockRes,
      metadata: {
        file_id: 'image-file-id',
        temp_file_id: 'temp-image-file-id',
        endpoint: EModelEndpoint.agents,
      },
    });

    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file_id: 'image-file-id',
        temp_file_id: 'temp-image-file-id',
        filepath: '/images/user-123/image.webp',
        source: FileSources.local,
        type: 'image/webp',
        llmDeliveryPath: 'provider',
      }),
      true,
    );
  });

  test('routes an agent image under the provider endpoint the caller resolved', async () => {
    const { createFile } = require('~/models');
    const handleImageUpload = jest.fn().mockResolvedValue({
      filepath: '/images/user-123/image.webp',
      bytes: 256,
      width: 100,
      height: 80,
    });
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      endpoints: {
        'Custom Provider': { defaultLLMDeliveryPath: { overrides: { 'image/*': 'none' } } },
      },
    });
    getStrategyFunctions.mockReturnValue({ handleImageUpload });
    const req = makeReq({ mimetype: 'image/png', ocrConfig: null });

    await processImageFile({
      req,
      res: mockRes,
      metadata: {
        file_id: 'image-file-id',
        agent_id: 'agent-abc',
        endpoint: EModelEndpoint.agents,
        effectiveEndpoint: 'Custom Provider',
      },
    });

    /* Storage still keys off the request endpoint; only delivery routing follows the
     * resolved provider. */
    expect(handleImageUpload).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: EModelEndpoint.agents }),
    );
    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({ llmDeliveryPath: 'none' }),
      true,
    );
  });
});

describe('processFileURL', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('throws and skips DB persistence when saveURL returns null', async () => {
    const saveURL = jest.fn().mockResolvedValue(null);
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await expect(
      processFileURL({
        fileStrategy: FileSources.local,
        userId: 'user-123',
        URL: 'https://example.com/image.png',
        fileName: 'image.png',
        basePath: 'images',
        context: FileContext.image_generation,
        tenantId: 'tenant-a',
      }),
    ).rejects.toThrow('Strategy "local" did not save "image.png"');

    expect(getFileURL).not.toHaveBeenCalled();
    expect(db.createFile).not.toHaveBeenCalled();
  });

  it('persists tenantId and strategy-returned filepath metadata', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
      dimensions: { width: 32, height: 64 },
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
    });

    expect(getFileURL).not.toHaveBeenCalled();
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-123',
        filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
        bytes: 512,
        filename: 'image.png',
        source: FileSources.cloudfront,
        type: 'image/png',
        context: FileContext.image_generation,
        tenantId: 'tenant-a',
        width: 32,
        height: 64,
      }),
      true,
    );
  });

  it('applies retention metadata for generated images when retention mode is all', async () => {
    getRetentionExpiry.mockResolvedValueOnce({
      expiredAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
      req: {
        user: { id: 'user-123', tenantId: 'tenant-a' },
        body: {},
        config: { interfaceConfig: { retentionMode: 'all', retainAgentFiles: true } },
      },
    });

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
      true,
    );
  });

  it('applies retention metadata for retained non-temporary conversations', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });
    getRetentionExpiry.mockResolvedValueOnce({
      expiredAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
      req: {
        user: { id: 'user-123', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-123' },
        config: { interfaceConfig: { retentionMode: RetentionMode.TEMPORARY } },
      },
    });

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
      true,
    );
  });

  it('keeps expired retained conversation files on the parent expiration', async () => {
    const parentExpiredAt = new Date('2020-01-01T00:00:00.000Z');
    const saveURL = jest.fn().mockResolvedValue({
      filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
      bytes: 512,
      type: 'image/png',
    });
    const getFileURL = jest.fn();
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });
    getRetentionExpiry.mockResolvedValueOnce({ expiredAt: parentExpiredAt });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
      req: {
        user: { id: 'user-123', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-123' },
        config: { interfaceConfig: { retentionMode: RetentionMode.TEMPORARY } },
      },
    });

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        expiredAt: parentExpiredAt,
      }),
      true,
    );
  });

  it('falls back to getFileURL with user and tenant context when metadata lacks filepath', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      bytes: 256,
      type: 'image/png',
    });
    const getFileURL = jest
      .fn()
      .mockResolvedValue('https://cdn.example.com/t/tenant-a/images/user-123/image.png');
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.cloudfront,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
    });

    expect(getFileURL).toHaveBeenCalledWith({
      userId: 'user-123',
      fileName: 'image.png',
      basePath: 'images',
      tenantId: 'tenant-a',
    });
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filepath: 'https://cdn.example.com/t/tenant-a/images/user-123/image.png',
        tenantId: 'tenant-a',
      }),
      true,
    );
  });

  it('preserves the user path segment for local fallback URLs', async () => {
    const saveURL = jest.fn().mockResolvedValue({
      bytes: 256,
      type: 'image/png',
    });
    const getFileURL = jest.fn().mockResolvedValue('/images/user-123/image.png');
    getStrategyFunctions.mockReturnValue({ saveURL, getFileURL });

    await processFileURL({
      fileStrategy: FileSources.local,
      userId: 'user-123',
      URL: 'https://example.com/image.png',
      fileName: 'image.png',
      basePath: 'images',
      context: FileContext.image_generation,
      tenantId: 'tenant-a',
    });

    expect(getFileURL).toHaveBeenCalledWith({
      userId: 'user-123',
      fileName: 'user-123/image.png',
      basePath: 'images',
      tenantId: 'tenant-a',
    });
    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filepath: '/images/user-123/image.png',
        tenantId: 'tenant-a',
      }),
      true,
    );
  });
});

describe('processDeleteRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('removes metadata when backing storage is already missing', async () => {
    const missingError = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const deleteFile = jest.fn().mockRejectedValue(missingError);
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });

    const result = await processDeleteRequest({
      req: {
        body: {},
        config: {},
        user: { id: 'user-123', tenantId: 'tenant-a' },
      },
      files: [
        {
          file_id: 'expired-file',
          filepath: '/images/user-123/expired.png',
          source: FileSources.local,
        },
      ],
    });

    expect(db.deleteFiles).toHaveBeenCalledWith(['expired-file']);
    expect(result).toEqual({ deletedFileIds: ['expired-file'], failedFileIds: [] });
  });

  it('does not treat unrelated not found messages as missing storage', async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error('Configuration not found'));
    getStrategyFunctions.mockReturnValue({ deleteFile });

    const result = await processDeleteRequest({
      req: {
        body: {},
        config: {},
        user: { id: 'user-123', tenantId: 'tenant-a' },
      },
      files: [
        {
          file_id: 'expired-file',
          filepath: '/images/user-123/expired.png',
          source: FileSources.local,
        },
      ],
    });

    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['expired-file'] });
  });

  it('throws metadata delete failures after storage deletion succeeds', async () => {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const metadataError = new Error('mongo unavailable');
    getStrategyFunctions.mockReturnValue({ deleteFile });
    db.deleteFiles.mockRejectedValue(metadataError);

    await expect(
      processDeleteRequest({
        req: {
          body: {},
          config: {},
          user: { id: 'user-123', tenantId: 'tenant-a' },
        },
        files: [
          {
            file_id: 'expired-file',
            filepath: '/images/user-123/expired.png',
            source: FileSources.local,
          },
        ],
      }),
    ).rejects.toThrow('mongo unavailable');

    expect(db.deleteFiles).toHaveBeenCalledWith(['expired-file']);
    expect(db.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
  });

  it('deletes vector storage before removing embedded file metadata', async () => {
    const primaryDelete = jest.fn().mockResolvedValue(undefined);
    const vectorDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).toHaveBeenCalledWith(['embedded-file']);
    expect(result).toEqual({ deletedFileIds: ['embedded-file'], failedFileIds: [] });
  });

  it('keeps embedded file metadata when vector deletion fails', async () => {
    const primaryDelete = jest.fn().mockResolvedValue(undefined);
    const vectorDelete = jest.fn().mockRejectedValue(new Error('rag unavailable'));
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['embedded-file'] });
  });

  it('keeps a failed agent file attached so the delete can be retried', async () => {
    const deleteFile = jest.fn().mockRejectedValue(new Error('rag unavailable'));
    getStrategyFunctions.mockReturnValue({ deleteFile });
    const req = {
      body: { agent_id: 'agent_1', tool_resource: 'file_search' },
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };

    const result = await processDeleteRequest({
      req,
      files: [
        {
          file_id: 'knowledge-file',
          filepath: '/uploads/knowledge.txt',
          source: FileSources.local,
        },
      ],
    });

    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['knowledge-file'] });
    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(db.removeAgentResourceFiles).not.toHaveBeenCalled();
    expect(db.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
  });

  it('strips agent references only for the files it deleted', async () => {
    getStrategyFunctions.mockReturnValue({
      deleteFile: jest
        .fn()
        .mockImplementation((_req, file) =>
          file.file_id === 'kept-file'
            ? Promise.reject(new Error('rag unavailable'))
            : Promise.resolve(undefined),
        ),
    });
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    const req = {
      body: { agent_id: 'agent_1', tool_resource: 'file_search' },
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };

    const result = await processDeleteRequest({
      req,
      files: [
        { file_id: 'gone-file', filepath: '/uploads/gone.txt', source: FileSources.local },
        { file_id: 'kept-file', filepath: '/uploads/kept.txt', source: FileSources.local },
      ],
    });

    expect(result).toEqual({ deletedFileIds: ['gone-file'], failedFileIds: ['kept-file'] });
    expect(db.removeAgentResourceFilesFromAllAgents).toHaveBeenCalledWith({
      file_ids: ['gone-file'],
    });
  });

  it('keeps agent references when the metadata delete fails', async () => {
    getStrategyFunctions.mockReturnValue({ deleteFile: jest.fn().mockResolvedValue(undefined) });
    db.deleteFiles.mockRejectedValue(new Error('mongo unavailable'));
    const req = {
      body: { agent_id: 'agent_1', tool_resource: 'file_search' },
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };

    await expect(
      processDeleteRequest({
        req,
        files: [
          {
            file_id: 'knowledge-file',
            filepath: '/uploads/knowledge.txt',
            source: FileSources.local,
          },
        ],
      }),
    ).rejects.toThrow('mongo unavailable');

    expect(db.removeAgentResourceFiles).not.toHaveBeenCalled();
    expect(db.removeAgentResourceFilesFromAllAgents).not.toHaveBeenCalled();
  });

  it('does not delete vector storage when primary embedded file deletion fails', async () => {
    const primaryDelete = jest.fn().mockRejectedValue(new Error('permission denied'));
    const vectorDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).not.toHaveBeenCalled();
    expect(db.deleteFiles).not.toHaveBeenCalled();
    expect(result).toEqual({ deletedFileIds: [], failedFileIds: ['embedded-file'] });
  });

  it('still deletes vector storage when primary embedded file storage is already missing', async () => {
    const missingError = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const primaryDelete = jest.fn().mockRejectedValue(missingError);
    const vectorDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.vectordb
        ? { deleteFile: vectorDelete }
        : { deleteFile: primaryDelete },
    );
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'embedded-file',
      filepath: '/uploads/embedded.txt',
      source: FileSources.local,
      embedded: true,
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(vectorDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).toHaveBeenCalledWith(['embedded-file']);
    expect(result).toEqual({ deletedFileIds: ['embedded-file'], failedFileIds: [] });
  });

  it('deletes code environment storage before removing code resource file metadata', async () => {
    const primaryDelete = jest.fn().mockResolvedValue(undefined);
    const codeDelete = jest.fn().mockResolvedValue(undefined);
    getStrategyFunctions.mockImplementation((source) =>
      source === FileSources.execute_code
        ? { deleteFile: codeDelete }
        : { deleteFile: primaryDelete },
    );
    db.deleteFiles.mockResolvedValue({ deletedCount: 1 });
    const req = {
      body: {},
      config: {},
      user: { id: 'user-123', tenantId: 'tenant-a' },
    };
    const file = {
      file_id: 'code-resource-file',
      filepath: '/uploads/code-resource.txt',
      source: FileSources.local,
      metadata: {
        codeEnvRef: {
          kind: 'agent',
          id: 'agent-abc',
          storage_session_id: 'sess-1',
          file_id: 'fid-1',
        },
      },
    };

    const result = await processDeleteRequest({ req, files: [file] });

    expect(primaryDelete).toHaveBeenCalledWith(req, file, undefined);
    expect(codeDelete).toHaveBeenCalledWith(req, file);
    expect(db.deleteFiles).toHaveBeenCalledWith(['code-resource-file']);
    expect(result).toEqual({ deletedFileIds: ['code-resource-file'], failedFileIds: [] });
  });
});

describe('sweepExpiredFiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates expired file sweeping to the shared package with backend dependencies', async () => {
    const options = {
      appConfig: { paths: { publicPath: '/tmp/public', uploads: '/tmp/uploads' } },
      limit: 1,
    };
    sweepExpiredFilesWithDeps.mockResolvedValue({ scanned: 1, deleted: 1, failed: 0 });

    const result = await sweepExpiredFiles(options);

    expect(sweepExpiredFilesWithDeps).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        getExpiredFiles: db.getExpiredFiles,
        processDeleteRequest: expect.any(Function),
        incrementFileDeletionAttempts: db.incrementFileDeletionAttempts,
        deferExpiredFile: db.deferExpiredFile,
        logger: expect.objectContaining({
          error: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      }),
    );
    expect(result).toEqual({ scanned: 1, deleted: 1, failed: 0 });
  });
});

describe('startExpiredFileSweep', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates background sweep startup to the shared package with system context', () => {
    const options = {
      appConfig: { paths: { publicPath: '/tmp/public', uploads: '/tmp/uploads' } },
    };

    const interval = startExpiredFileSweep(options);

    expect(startExpiredFileSweepWithDeps).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        sweepExpiredFiles: expect.any(Function),
        runAsSystem: expect.any(Function),
        isLeader: expect.any(Function),
        logger: expect.objectContaining({
          error: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      }),
    );
    expect(interval).toBe('sweep-interval');
  });
});

describe('uploads with no consumer on the agent record', () => {
  test('accepts a type the record shows no tool for', async () => {
    /* Skills contribute file search and code execution for a turn without being written
     * to agent.tools, so an empty list is not evidence that nothing will read the file.
     * Reaching storage, which this suite leaves unwired, proves it was not refused. */
    const req = makeReq({ mimetype: 'application/zip', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;
    getStrategyFunctions.mockClear();

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        message_file: 'true',
        file_id: 'file-uuid-zip',
        agentTools: [],
      },
    }).catch(() => {});

    expect(getStrategyFunctions).toHaveBeenCalled();
  });

  test('accepts a standard-chat attachment for a tool enabled later', async () => {
    const req = makeReq({ mimetype: 'application/zip', ocrConfig: null });
    req.body.endpoint = 'Custom Provider';
    getStrategyFunctions.mockClear();

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        endpoint: 'Custom Provider',
        message_file: 'true',
        file_id: 'file-uuid-zip',
      },
    }).catch(() => {});

    expect(getStrategyFunctions).toHaveBeenCalled();
  });
});

describe('native text fallback', () => {
  /* The text matcher has to admit the type, or processing refuses before reaching the
   * reader at all. This mirrors a deployment whose text config accepts these types. */
  beforeEach(() => {
    mergeFileConfig.mockReturnValue(
      makeFileConfig({ textSupportedMimeTypes: [/^image\/png$/, /^text\/plain$/] }),
    );
    setupStoredFileUpload();
  });

  test('does not read a raster image as text when no extractor handles it', async () => {
    /* An administrator can route images to text; without OCR nothing parses them, and
     * reading the bytes directly would store mojibake as the file's text. */
    const { parseText } = require('@librechat/api');
    const req = makeReq({ mimetype: 'image/png', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        message_file: 'true',
        file_id: 'f-png',
        tool_resource: 'context',
      },
    }).catch(() => {});

    const call = parseText.mock.calls.at(-1)?.[0];
    expect(call?.allowNativeFallback).toBe(false);
  });

  test('still reads a text file directly', async () => {
    const { parseText } = require('@librechat/api');
    const req = makeReq({ mimetype: 'text/plain', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        message_file: 'true',
        file_id: 'f-txt',
        tool_resource: 'context',
      },
    }).catch(() => {});

    const call = parseText.mock.calls.at(-1)?.[0];
    expect(call?.allowNativeFallback).toBe(true);
  });
});

describe('permanent unified uploads and unknown tool sets', () => {
  const zipReq = () => {
    const req = makeReq({ mimetype: 'application/zip', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;
    return req;
  };

  test('does not refuse when the agent tools are unknown', async () => {
    /* An ephemeral agent has no record to read, so the route reports no tool set and
     * processing must not conclude that nothing can consume the file. */
    const error = await processAgentFileUpload({
      req: zipReq(),
      res: mockRes,
      metadata: { agent_id: 'agent-abc', message_file: 'true', file_id: 'f-eph' },
    }).catch((thrown) => thrown);

    expect(String(error?.message ?? '')).not.toMatch(/code interpreter or file search/i);
  });

  test('files a permanent upload under the tool that will consume it', async () => {
    const { addAgentResourceFile } = require('~/models');
    setupStoredFileUpload();
    /* The code-env branch streams the upload from disk after this assertion resolves, and
     * an unhandled stream error would take down the worker. Left in place rather than
     * cleaned up, since the read happens later than the test body. */
    jest.requireActual('fs').writeFileSync('/tmp/upload.bin', 'zip');

    await processAgentFileUpload({
      req: zipReq(),
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        file_id: 'f-perm',
        agentTools: [EToolResources.execute_code],
      },
    }).catch(() => {});

    expect(addAgentResourceFile).toHaveBeenCalledWith(
      expect.objectContaining({ tool_resource: EToolResources.execute_code }),
    );
  });

  test('records the converted image format rather than the upload type', async () => {
    /* The stored bytes are the converted image. Keeping the upload's type leaves a later
     * reprovision handing the sandbox webp bytes under a .jpg name, which the rename
     * cannot catch because the extension already matches the stale type. */
    const handleImageUpload = jest.fn().mockResolvedValue({
      filepath: '/uploads/photo.webp',
      bytes: 64,
      width: 10,
      height: 10,
    });
    const storedFileUpload = jest.fn().mockResolvedValue({
      bytes: 4096,
      filename: 'photo.jpg',
      filepath: '/uploads/photo.jpg',
    });
    getStrategyFunctions.mockReturnValue({
      handleImageUpload,
      handleFileUpload: storedFileUpload,
    });
    const req = makeReq({ mimetype: 'image/jpeg', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: { agent_id: 'agent-abc', message_file: 'true', file_id: 'f-image' },
    }).catch(() => {});

    expect(db.createFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ file_id: 'f-image', type: 'image/webp' }),
      true,
    );
    /* The conversion runs under an id of its own, so persisting it too would leave a
     * message-attachment row referenced by nothing beside the record above. */
    expect(db.createFile).toHaveBeenCalledTimes(1);
    /* And the conversion is the only storage write: uploading the original first left a
     * second object nothing references. */
    expect(handleImageUpload).toHaveBeenCalledTimes(1);
    expect(storedFileUpload).not.toHaveBeenCalled();
    /* Size and dimensions describe the bytes actually stored, which the persistent-file
     * screening later charges against the agent's allowance. */
    expect(db.createFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ bytes: 64, width: 10, height: 10 }),
      true,
    );
  });

  test('treats an explicit message_file of "false" as a permanent upload', async () => {
    /* Multipart form values arrive as strings, so the truthy reading made "false" mean
     * message attachment while the route had already classified it as permanent. The
     * upload reported success and filed nothing against the agent. */
    const { addAgentResourceFile } = require('~/models');
    setupStoredFileUpload();

    await processAgentFileUpload({
      req: zipReq(),
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        message_file: 'false',
        file_id: 'f-explicit-false',
        agentTools: [EToolResources.execute_code],
      },
    }).catch(() => {});

    expect(addAgentResourceFile).toHaveBeenCalledWith(
      expect.objectContaining({ tool_resource: EToolResources.execute_code }),
    );
  });

  test('skips a consumer whose capability is disabled', async () => {
    /* Otherwise the choice depends on the persisted tool order: code execution listed
     * first would be selected and then rejected, while file search could have kept it. */
    const { addAgentResourceFile } = require('~/models');
    setupStoredFileUpload();
    checkCapability.mockImplementation(
      async (_req, capability) => capability !== AgentCapabilities.execute_code,
    );

    /* A searchable type routed off the model path, since a consumer is only chosen for a
     * file kept off it, and only one that can read the file. */
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      defaultLLMDeliveryPath: { overrides: { [PDF_MIME]: 'none' } },
    });
    const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        file_id: 'f-disabled',
        agentTools: [EToolResources.execute_code, EToolResources.file_search],
      },
    }).catch(() => {});

    expect(addAgentResourceFile).toHaveBeenCalledWith(
      expect.objectContaining({ tool_resource: EToolResources.file_search }),
    );
    checkCapability.mockResolvedValue(true);
  });

  test('chooses an authorized consumer before routing an inferred destination', async () => {
    const { addAgentResourceFile } = require('~/models');
    const { resolveToolRoleGrants } = require('@librechat/api');
    setupStoredFileUpload();
    resolveToolRoleGrants.mockResolvedValueOnce({ runCode: false, fileSearch: true });
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      defaultLLMDeliveryPath: { overrides: { [PDF_MIME]: 'none' } },
    });
    const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        file_id: 'f-role-filtered',
        agentTools: [EToolResources.execute_code, EToolResources.file_search],
      },
    });

    expect(addAgentResourceFile).toHaveBeenCalledWith(
      expect.objectContaining({ tool_resource: EToolResources.file_search }),
    );
    expect(resolveToolRoleGrants).toHaveBeenCalledTimes(1);
  });

  test('records a named destination as chosen in unified mode', async () => {
    /* The marker asks whether the user named a destination, not which endpoint mode was
     * on. Recording the mode treats an explicitly sandbox-only upload as inferred, and
     * delivery then re-resolves it onto the model path. */
    setupStoredFileUpload();
    const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        tool_resource: EToolResources.file_search,
        file_id: 'f-named',
      },
    }).catch(() => {});

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ destinationChosen: true }),
      }),
      true,
    );
  });

  test('records the agent namespace on an eagerly embedded file', async () => {
    /* Vectors go in under entity_id, and priming asks which namespaces hold them rather
     * than reading the root flag, so omitting this re-embeds on the first search and
     * aborts that search when RAG is briefly unavailable. */
    setupStoredFileUpload();
    const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await processAgentFileUpload({
      req,
      res: mockRes,
      metadata: {
        agent_id: 'agent-abc',
        tool_resource: EToolResources.file_search,
        file_id: 'f-embedded',
      },
    }).catch(() => {});

    expect(db.createFile).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ embeddedEntities: ['agent-abc'] }),
      }),
      true,
    );
  });

  test('names the destination that refused the file, not file search', async () => {
    /* The message is the only thing telling the reader which tool rejected the upload,
     * and reporting an image sent to file search for an audio file sent to the code
     * interpreter describes neither the file nor the destination. */
    const req = makeReq({ mimetype: 'audio/mpeg', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await expect(
      processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          tool_resource: EToolResources.execute_code,
          file_id: 'f-audio',
        },
      }),
    ).rejects.toThrow(/audio\/mpeg.*code interpreter/i);
  });

  test('refuses a permanent upload that would land on no agent resource', async () => {
    /* Delivered straight to the model, with no agent resource to hold it, storing it
     * would report success while leaving the agent without a reference. */
    const req = makeReq({ mimetype: 'image/png', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;

    await expect(
      processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { agent_id: 'agent-abc', file_id: 'f-orphan', agentTools: [] },
      }),
    ).rejects.toThrow(/cannot be saved to an agent on their own/i);
  });
});

describe('filterFile endpoint resolution', () => {
  /* getEndpointFileConfig consults endpointType ahead of endpoint, so a composer upload
   * carrying `agents` would keep the Agents policy and shadow the provider the caller
   * resolved. */
  /* mergeFileConfig is mocked here, so these are raw byte values rather than the
   * megabytes an admin would write. The agents policy refuses the file on size and the
   * provider policy accepts it, which makes the assertions read as which one governed. */
  const policyConfig = {
    ...makeFileConfig(),
    endpoints: {
      default: {
        disabled: false,
        fileLimit: 10,
        fileSizeLimit: 1_000_000,
        totalSizeLimit: 1_000_000,
        supportedMimeTypes: [/^image\/png$/],
      },
      agents: { fileSizeLimit: 1 },
      'Custom Provider': { fileSizeLimit: 1_000_000 },
    },
  };

  const makeFilterReq = (endpointType) => ({
    body: {
      endpoint: EModelEndpoint.agents,
      ...(endpointType ? { endpointType } : {}),
      file_id: '00000000-0000-4000-8000-000000000000',
      width: 1,
      height: 1,
    },
    file: { size: 10, mimetype: 'image/png', originalname: 'a.png' },
    config: {},
  });

  beforeEach(() => {
    mergeFileConfig.mockReturnValue(policyConfig);
  });

  test('applies the resolved provider policy even when the request names an endpoint type', () => {
    expect(() =>
      filterFile({ req: makeFilterReq('agents'), image: true, endpoint: 'Custom Provider' }),
    ).not.toThrow();
  });

  test('keeps the request endpoint type when no override is given', () => {
    expect(() => filterFile({ req: makeFilterReq('agents'), image: true })).toThrow(/size limit/i);
  });

  test('rejects endpoint uploads when the resolved provider disables files', () => {
    policyConfig.endpoints['Disabled Provider'] = {
      ...policyConfig.endpoints.default,
      disabled: true,
    };

    expect(() =>
      filterFile({ req: makeFilterReq('agents'), image: true, endpoint: 'Disabled Provider' }),
    ).toThrow(/uploads are disabled/i);
  });

  test('does not apply an endpoint disabled flag to avatars', () => {
    policyConfig.endpoints['Disabled Provider'] = {
      ...policyConfig.endpoints.default,
      disabled: true,
    };
    const req = makeFilterReq();
    req.body.endpoint = 'Disabled Provider';

    expect(() => filterFile({ req, image: true, isAvatar: true })).not.toThrow();
  });
});

describe('fallback text for uploads left to tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRes.status.mockReturnThis();
    mockRes.json.mockReturnValue({});
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      endpoints: {
        'Custom Provider': {
          defaultLLMDeliveryPath: { fallback: 'none' },
          textFallbackWithoutTools: true,
        },
      },
    });
  });

  const uploadCsv = (metadata) => {
    const req = makeReq({ mimetype: 'text/csv', ocrConfig: null });
    req.body.endpoint = EModelEndpoint.agents;
    return {
      req,
      upload: processAgentFileUpload({
        req,
        res: mockRes,
        metadata: {
          agent_id: 'agent-abc',
          message_file: 'true',
          file_id: 'file-uuid-csv',
          effectiveEndpoint: 'Custom Provider',
          ...metadata,
        },
      }),
    };
  };

  test('stores the text a turn without a reading tool can fall back to', async () => {
    const { createFile } = require('~/models');
    const { resolveUploadFallbackText } = require('@librechat/api');
    setupStoredFileUpload();
    resolveUploadFallbackText.mockResolvedValueOnce('region,total');

    const { req, upload } = uploadCsv();
    await upload;

    expect(resolveUploadFallbackText).toHaveBeenCalledWith(
      expect.objectContaining({
        file: req.file,
        fileId: 'file-uuid-csv',
        deliveryPath: 'none',
        destinationChosen: false,
        isMessageAttachment: true,
        endpointConfig: expect.objectContaining({ textFallbackWithoutTools: true }),
      }),
    );
    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({ llmDeliveryPath: 'none', text: 'region,total' }),
      true,
    );
  });

  test('marks a legacy chooser upload as chosen, so no fallback text is extracted for it', async () => {
    const { resolveUploadFallbackText } = require('@librechat/api');
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      endpoints: {
        'Custom Provider': {
          defaultLLMDeliveryPath: { fallback: 'none' },
          textFallbackWithoutTools: true,
          legacyFileUploadUX: true,
        },
      },
    });
    setupStoredFileUpload();

    const { upload } = uploadCsv();
    await upload;

    expect(resolveUploadFallbackText).toHaveBeenCalledWith(
      expect.objectContaining({ destinationChosen: true, isMessageAttachment: true }),
    );
  });

  test('stores fallback text for an attachment filed under a tool a later turn may not run', async () => {
    const { createFile } = require('~/models');
    const { resolveUploadFallbackText } = require('@librechat/api');
    setupStoredFileUpload();
    resolveUploadFallbackText.mockResolvedValueOnce('region,total');

    const { upload } = uploadCsv({ agentTools: [EToolResources.execute_code] });
    await upload;

    expect(resolveUploadFallbackText).toHaveBeenCalledWith(
      expect.objectContaining({ destinationChosen: false, isMessageAttachment: true }),
    );
    expect(createFile).toHaveBeenCalledWith(
      expect.objectContaining({ llmDeliveryPath: 'none', text: 'region,total' }),
      true,
    );
  });
});

/**
 * The authoritative MIME gate. Multer's filter runs while the file part is still
 * streaming, so it cannot read a `tool_resource` sent after the file; this one has the
 * complete body and runs before any provider is handed the upload.
 */
describe('filterFile', () => {
  const VENDOR_MIME = 'application/vnd.vendor.word';

  const makeFilterReq = (toolResource) => ({
    file: { size: 1024, mimetype: VENDOR_MIME, originalname: 'report.docx' },
    body: {
      endpoint: 'agents',
      file_id: '11111111-1111-4111-8111-111111111111',
      ...(toolResource ? { tool_resource: toolResource } : {}),
    },
    config: { fileConfig: {} },
  });

  beforeEach(() => {
    mergeFileConfig.mockReturnValue({
      ...makeFileConfig(),
      documentParser: { supportedMimeTypes: [new RegExp(`^${VENDOR_MIME}$`)] },
      endpoints: { default: { supportedMimeTypes: [/^application\/pdf$/] } },
    });
  });

  it('admits a parser-named MIME for a context upload', () => {
    expect(() => filterFile({ req: makeFilterReq(EToolResources.context) })).not.toThrow();
  });

  it.each([
    ['a different tool resource', 'file_search'],
    ['no tool resource at all', undefined],
  ])('refuses a parser-named MIME for %s', (_label, toolResource) => {
    expect(() => filterFile({ req: makeFilterReq(toolResource) })).toThrow('Unsupported file type');
  });
});
