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
  const getUploadExtractedTextPlan = jest.fn(
    ({ mimeType, fileConfig, ocrConfigured, ragConfigured }) => {
      const checkType = fileConfig.checkType;
      if (ocrConfigured && checkType(mimeType, fileConfig.ocr?.supportedMimeTypes ?? [])) {
        return UPLOAD_EXTRACTED_TEXT_PLANS.configuredOCR;
      }
      const isDocumentParserEligible = actualDataProvider.documentParserMimeTypes.some((pattern) =>
        pattern.test(mimeType),
      );
      if (!isDocumentParserEligible) {
        return null;
      }
      if (
        ragConfigured &&
        !actualDataProvider.isPermissiveMimeConfig(fileConfig.text?.supportedMimeTypes) &&
        checkType(mimeType, fileConfig.text?.supportedMimeTypes ?? [])
      ) {
        return UPLOAD_EXTRACTED_TEXT_PLANS.configuredRAG;
      }
      return UPLOAD_EXTRACTED_TEXT_PLANS.documentParser;
    },
  );
  return {
    sanitizeFilename: jest.fn((n) => n),
    /** Grants both; these specs vary the capability set, not the role. */
    resolveToolRoleGrants: jest.fn(async () => ({ runCode: true, fileSearch: true })),
    parseText: jest.fn().mockResolvedValue({ text: '', bytes: 0 }),
    processAudioFile: jest.fn(),
    extractInspectableFileText: jest.fn(async ({ extract }) => extract()),
    assertExtractedTextInspectable: jest.fn(),
    getUploadExtractedTextPlan,
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
  sweepExpiredFiles: sweepExpiredFilesWithDeps,
  startExpiredFileSweep: startExpiredFileSweepWithDeps,
} = require('@librechat/api');
const {
  EModelEndpoint,
  EToolResources,
  FileSources,
  FileContext,
  RetentionMode,
  AgentCapabilities,
} = require('librechat-data-provider');
const { mergeFileConfig } = require('librechat-data-provider');
const { checkCapability } = require('~/server/services/Config');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { uploadVectors } = require('./VectorDB/crud');
const { logger } = require('@librechat/data-schemas');
const db = require('~/models');
const {
  processAgentFileUpload,
  processImageFile,
  processDeleteRequest,
  processFileUpload,
  processFileURL,
  retrieveAndProcessFile,
  sweepExpiredFiles,
  startExpiredFileSweep,
  filterFile,
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
  ocrConfig = null,
  interfaceConfig,
  filters,
  speech,
  body,
} = {}) => ({
  user: { id: 'user-123', tenantId: 'tenant-a' },
  file: {
    path: '/tmp/upload.bin',
    originalname: 'upload.bin',
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
};

const makeFileConfig = ({
  ocrSupportedMimeTypes = [],
  sttSupportedMimeTypes = [],
  textSupportedMimeTypes = [],
} = {}) => ({
  checkType: (mime, types) =>
    (types ?? []).some((t) => (typeof t === 'string' ? t === mime : t.test(mime))),
  ocr: { supportedMimeTypes: ocrSupportedMimeTypes },
  stt: { supportedMimeTypes: sttSupportedMimeTypes },
  text: { supportedMimeTypes: textSupportedMimeTypes },
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
    getStrategyFunctions.mockReturnValue({
      handleFileUpload: jest
        .fn()
        .mockResolvedValue({ text: 'extracted text', bytes: 42, filepath: 'doc://result' }),
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

  describe('OCR strategy selection', () => {
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

    test('does not check OCR capability when using automatic document_parser fallback', async () => {
      const req = makeReq({ mimetype: PDF_MIME, ocrConfig: null });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).not.toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('uses the configured OCR strategy when OCR is set up for the file type', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.mistral_ocr);
    });

    test('uses document_parser as default when OCR is configured but no strategy is specified', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { supportedMimeTypes: [PDF_MIME] },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('throws when configured OCR capability is not enabled for the agent', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      /* Only OCR is under test here; disabling every capability would trip the
       * separate context guard first. */
      checkCapability.mockImplementation(
        async (_req, capability) => capability !== AgentCapabilities.ocr,
      );
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).rejects.toThrow('OCR capability is not enabled for Agents');
    });

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
      ['ODG', ODG_MIME],
    ])('routes %s through configured OCR when OCR supports the type', async (_, mime) => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [mime] }));
      const req = makeReq({
        mimetype: mime,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() });

      expect(checkCapability).toHaveBeenCalledWith(expect.anything(), AgentCapabilities.ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.mistral_ocr);
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

    test('falls back to document_parser when configured OCR fails for a document MIME type', async () => {
      mergeFileConfig.mockReturnValue(makeFileConfig({ ocrSupportedMimeTypes: [PDF_MIME] }));
      const failingUpload = jest.fn().mockRejectedValue(new Error('OCR API returned 500'));
      const fallbackUpload = jest
        .fn()
        .mockResolvedValue({ text: 'parsed text', bytes: 11, filepath: 'doc://result' });
      getStrategyFunctions
        .mockReturnValueOnce({ handleFileUpload: failingUpload })
        .mockReturnValueOnce({ handleFileUpload: fallbackUpload });
      const req = makeReq({
        mimetype: PDF_MIME,
        ocrConfig: { strategy: FileSources.mistral_ocr },
      });

      await expect(
        processAgentFileUpload({ req, res: mockRes, metadata: makeMetadata() }),
      ).resolves.not.toThrow();

      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.mistral_ocr);
      expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.document_parser);
    });

    test('throws when both configured OCR and document_parser fallback fail', async () => {
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
          filepath: 'doc://result',
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
          filepath: 'doc://result',
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
      const req = makeReq({
        mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
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
      const { getUploadExtractedTextPlan } = require('@librechat/api');
      mergeFileConfig.mockReturnValue(makeFileConfig());
      const req = makeReq({ mimetype: DOCX_MIME, ocrConfig: null });

      /** The planner runs before extraction; downstream extraction is covered by the
       *  OCR strategy tests, so failures past this point must not mask the argument. */
      await processAgentFileUpload({
        req,
        res: mockRes,
        metadata: { agent_id: 'agent-abc', file_id: 'file-uuid-123' },
      }).catch(() => {});

      expect(getUploadExtractedTextPlan).toHaveBeenCalledWith(
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
