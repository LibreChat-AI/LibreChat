// Configurable file size limit for tests - use a getter so it can be changed per test
const fileSizeLimitConfig = { value: 20 * 1024 * 1024 }; // Default 20MB

// Mock librechat-data-provider with configurable file size limit
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    mergeFileConfig: jest.fn((config) => {
      const merged = actual.mergeFileConfig(config);
      // Override the serverFileSizeLimit with our test value
      return {
        ...merged,
        get serverFileSizeLimit() {
          return fileSizeLimitConfig.value;
        },
      };
    }),
    getEndpointFileConfig: jest.fn((options) => {
      const config = actual.getEndpointFileConfig(options);
      // Override fileSizeLimit with our test value
      return {
        ...config,
        get fileSizeLimit() {
          return fileSizeLimitConfig.value;
        },
      };
    }),
  };
});

const { ErrorTypes, FileContext, ResourceType } = require('librechat-data-provider');

// Mock uuid
jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-1234'),
}));

// Mock axios — process.js now uses createAxiosInstance() from @librechat/api
const mockAxios = jest.fn();
mockAxios.post = jest.fn();
mockAxios.isAxiosError = jest.fn(() => false);

const mockClassifyCodeArtifact = jest.fn(() => 'other');
const mockExtractCodeArtifactRawText = jest.fn(() => null);
const mockExtractCodeArtifactInspectionText = jest.fn(async () => ({
  text: null,
  complete: false,
}));
const mockExtractCodeArtifactText = jest.fn(async () => null);
const mockExecuteWorkspaceTool = jest.fn();
const mockGetExtractedTextFormat = jest.fn((_name, _mime, text) => (text == null ? null : 'text'));
/* `hasOfficeHtmlPath` gates the persist-then-render split: when true, processCodeOutput
 * returns `{ file, finalize }` with the file persisted at `status: 'pending'`
 * and `finalize` runs the background extraction. Default false here so the
 * legacy single-phase tests below (txt/png/etc) exercise the inline path
 * unchanged. The dedicated office/finalize describe block toggles it on. */
const mockHasOfficeHtmlPath = jest.fn(() => false);
/* Stands in for the real chunk parser so a transport test can decide what
 * one `/exec` response means without reaching into `packages/api`. */
const mockParseSandboxImageChunk = jest.fn((response) => response);
/* Pass-through `withTimeout`: tests don't drive timeouts here (those live
 * in promise.spec.ts and the finalizePreview unit tests below). */
const passthroughWithTimeout = async (promise) => promise;
jest.mock('@librechat/api', () => {
  return {
    processCodeOutput: jest.requireActual('@librechat/api').processCodeOutput,
    prepareCodeOutputBufferForInspection:
      jest.requireActual('@librechat/api').prepareCodeOutputBufferForInspection,
    getCodeFileContextLine: jest.requireActual('@librechat/api').getCodeFileContextLine,
    appendCodeFileContextLine: jest.requireActual('@librechat/api').appendCodeFileContextLine,
    resolveDownloadPath: (file) => file.storageKey || file.filepath,
    logAxiosError: jest.fn(),
    /* Behaviourally identical to the real predicate in
     * `packages/api/src/files/code/errors.ts`, which owns the contract and
     * its own spec. Inlined because this factory replaces the whole module
     * and `requireActual` here would load the entire package. */
    isMissingSandboxPathError: (reason) =>
      /no such file or directory|cannot access|cannot find the path|enoent/i.test(reason),
    getBasePath: jest.fn(() => ''),
    sanitizeArtifactPath: jest.fn((name) => name),
    flattenArtifactPath: jest.fn((name) => name.replace(/\//g, '__')),
    createAxiosInstance: jest.fn(() => mockAxios),
    normalizeArtifactDeliveryFailure: (value) =>
      value?.code === 'artifact_delivery_failed'
        ? {
            code: value.code,
            status: value.status,
            attempted: value.attempted,
            delivered: value.delivered,
            failed: value.failed,
          }
        : undefined,
    executeWorkspaceTool: (...args) => mockExecuteWorkspaceTool(...args),
    getCodeApiAuthHeaders: jest.fn(async () => ({})),
    isAbortError: (error) =>
      error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.code === 'ERR_CANCELED',
    /* Windowing, sizing and rate-limit policy are real code in
     * `packages/api` with their own tests (`files/code/image.spec.ts`,
     * `utils/code.spec.ts`). These stand-ins are deliberately inert
     * passthroughs — they assert nothing about that behavior, so the
     * transport tests below cover only what this file still owns. */
    createCodeApiRateLimitBudget: jest.fn(() => ({
      limitMs: 20_000,
      waitedMs: 0,
      activeWaitEnds: new Set(),
    })),
    getCodeApiUploadOptions: jest.fn(() => ({
      scope: 'default:user-123',
      concurrency: 3,
      retryWaitMs: 20_000,
    })),
    withCodeApiRateLimit: jest.fn(async ({ attempt }) => {
      try {
        return await attempt();
      } catch (error) {
        if (error?.response?.status !== 429) {
          throw error;
        }
        return attempt();
      }
    }),
    withCodeApiUploadRecovery: jest.fn(async ({ openSource, upload }) => {
      try {
        return await upload(await openSource());
      } catch (error) {
        if (error?.response?.status !== 429) {
          throw error;
        }
        return upload(await openSource());
      }
    }),
    buildSandboxImageReaderCode: jest.fn(
      ({ filePath, limit, offset, chunkBytes }) =>
        `read ${filePath} ${limit} ${offset} ${chunkBytes}`,
    ),
    parseSandboxImageChunk: jest.fn((response) => mockParseSandboxImageChunk(response)),
    readWindowedSandboxImage: jest.fn(({ readChunk }) => readChunk({ code: 'read-one-window' })),
    getCodeExecutionBaseUrl: jest.fn((profile) =>
      profile === 'stateful' ? 'https://code-stateful.example.com' : 'https://code-api.example.com',
    ),
    CODE_API_EXPECTED_PROFILE_HEADER: 'X-CodeAPI-Expected-Profile',
    codeExecutionHeaders: ({ executionProfile, bridgeWorkerId }) => ({
      'X-CodeAPI-Expected-Profile': executionProfile,
      ...(bridgeWorkerId ? { 'X-LibreChat-Code-Worker-ID': bridgeWorkerId } : {}),
    }),
    withTimeout: (...args) => passthroughWithTimeout(...args),
    hasOfficeHtmlPath: (...args) => mockHasOfficeHtmlPath(...args),
    /**
     * Arrow-function indirection (vs. a direct `jest.fn()` reference) so
     * tests can per-case `mockReturnValueOnce` / `mockImplementationOnce`
     * on `mockClassifyCodeArtifact` / `mockExtractCodeArtifactText`.
     * `jest.mock(...)` is hoisted above the outer `const` declarations
     * at parse time, so a direct reference here would capture
     * `undefined`; the arrow defers the binding to call time. The
     * direct-`jest.fn()` mocks below stay constant per file.
     */
    classifyCodeArtifact: (...args) => mockClassifyCodeArtifact(...args),
    extractCodeArtifactRawText: (...args) => mockExtractCodeArtifactRawText(...args),
    extractCodeArtifactInspectionText: (...args) => mockExtractCodeArtifactInspectionText(...args),
    extractCodeArtifactText: (...args) => mockExtractCodeArtifactText(...args),
    getBoundedCodeOutputByteLimit: (configured) =>
      typeof configured === 'number' && Number.isFinite(configured) && configured > 0
        ? Math.min(configured, 64 * 1024 * 1024)
        : 64 * 1024 * 1024,
    CODE_OUTPUT_PREFLIGHT_MAX_BYTES: 64 * 1024 * 1024,
    CODE_OUTPUT_PREFLIGHT_MAX_COUNT: 10,
    /* `processCodeOutput` derives the `textFormat` trust flag for
     * `IMongoFile` from this helper — Codex P1 review on PR #12934.
     * The mock returns 'text' for non-null extractor output and null
     * otherwise so the downstream `file.textFormat` field is set to
     * a believable shape without modeling the office-HTML branch
     * (the dispatcher under test isn't exercising that path). Per-
     * test overrides via `mockGetExtractedTextFormat.mockReturnValue`
     * if a case needs to assert the 'html' value. */
    getExtractedTextFormat: (...args) => mockGetExtractedTextFormat(...args),
    getStorageMetadata: jest.fn(() => ({})),
    /* Identity helpers mirror codeapi's validator. The real impl
     * lives in `packages/api/src/files/code/identity.ts` with its
     * own dedicated `identity.spec.ts`; here we just stub the
     * download-query builder since `processCodeOutput` calls it on
     * every output download. */
    buildCodeEnvDownloadQuery: jest.fn(({ kind, id, version }) => {
      const params = new URLSearchParams({ kind, id });
      if (version != null) params.set('version', String(version));
      return `?${params.toString()}`;
    }),
    codeServerHttpAgent: jest.requireActual('@librechat/api').codeServerHttpAgent,
    codeServerHttpsAgent: jest.requireActual('@librechat/api').codeServerHttpsAgent,
    selectCodeFiles: jest.requireActual('@librechat/api').selectCodeFiles,
    getCodeFileInfo: jest.requireActual('@librechat/api').getCodeFileInfo,
    getUploadedCodeEnvFilename: jest.requireActual('@librechat/api').getUploadedCodeEnvFilename,
    checkCodeFileActive: jest.requireActual('@librechat/api').checkCodeFileActive,
  };
});

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  getCodeBaseURL: jest.fn(() => 'https://code-api.example.com'),
}));

// Mock models
const mockClaimCodeFile = jest.fn();
const mockCommitCodeFile = jest.fn();
const mockUpdateFile = jest.fn();
jest.mock('~/models', () => ({
  createFile: jest.fn().mockResolvedValue({}),
  getFiles: jest.fn(),
  updateFile: mockUpdateFile,
  claimCodeFile: (...args) => mockClaimCodeFile(...args),
  commitCodeFile: mockCommitCodeFile,
}));

// Mock permissions (must be before process.js import)
jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn((options) => Promise.resolve(options.files)),
}));

// Mock strategy functions
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

// Mock convertImage
jest.mock('~/server/services/Files/images/convert', () => ({
  convertImage: jest.fn(),
}));

jest.mock('~/server/services/Files/retention', () => ({
  getRetentionExpiry: jest.fn(() => ({})),
}));

// Mock determineFileType
jest.mock('~/server/utils', () => ({
  determineFileType: jest.fn(),
}));

const http = require('http');
const https = require('https');
const { createFile, getFiles } = require('~/models');
const { getRetentionExpiry } = require('~/server/services/Files/retention');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { convertImage } = require('~/server/services/Files/images/convert');
const { determineFileType } = require('~/server/utils');
const { logger } = require('@librechat/data-schemas');
const {
  codeServerHttpAgent,
  codeServerHttpsAgent,
  getCodeApiAuthHeaders,
  getStorageMetadata,
} = require('@librechat/api');

const {
  processCodeOutput,
  prepareCodeOutputForInspection,
  getSessionInfo,
  readSandboxFile,
  readWorkspaceFile,
  searchWorkspace,
  listWorkspaceFiles,
  writeWorkspaceFile,
  previewWorkspaceEdit,
  editWorkspaceFile,
  readSandboxImage,
  writeSandboxFile,
  primeFiles,
} = require('./process');

describe('Code Process', () => {
  const mockReq = {
    user: { id: 'user-123' },
    config: {
      fileConfig: {},
      fileStrategy: 'local',
      imageOutputType: 'webp',
    },
  };

  const baseParams = {
    req: mockReq,
    id: 'file-id-123',
    name: 'test-file.txt',
    apiKey: 'test-api-key',
    toolCallId: 'tool-call-123',
    conversationId: 'conv-123',
    messageId: 'msg-123',
    session_id: 'session-123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    fileSizeLimitConfig.value = 20 * 1024 * 1024;
    // Default mock: atomic claim returns a new file record (no existing file)
    mockClaimCodeFile.mockResolvedValue({
      file_id: 'mock-uuid-1234',
      user: 'user-123',
    });
    getFiles.mockResolvedValue(null);
    createFile.mockResolvedValue({});
    mockCommitCodeFile.mockReset();
    mockCommitCodeFile.mockResolvedValue(true);
    getStrategyFunctions.mockReturnValue({
      saveBuffer: jest.fn().mockResolvedValue('/uploads/mock-file-path.txt'),
    });
    determineFileType.mockResolvedValue({ mime: 'text/plain' });
  });

  describe('code output inspection preflight', () => {
    it('derives file content from downloaded bytes without persisting anything', async () => {
      const buffer = Buffer.from('safe raw content');
      mockAxios.mockResolvedValue({ data: buffer });
      mockClassifyCodeArtifact.mockReturnValueOnce('utf8-text');
      mockExtractCodeArtifactRawText.mockReturnValueOnce('safe raw content');
      mockExtractCodeArtifactInspectionText.mockResolvedValueOnce({
        text: 'safe extracted content',
        complete: true,
      });

      const prepared = await prepareCodeOutputForInspection(baseParams);

      expect(prepared).toEqual({
        buffer,
        extractedTextComplete: true,
        file: {
          name: 'test-file.txt',
          filename: 'test-file.txt',
          type: 'text/plain',
          content: 'safe raw content',
          extractedText: 'safe extracted content',
        },
      });
      expect(mockClaimCodeFile).not.toHaveBeenCalled();
      expect(mockCommitCodeFile).not.toHaveBeenCalled();
      expect(getStrategyFunctions).not.toHaveBeenCalled();
    });

    it('persists the exact preflight buffer without downloading it again', async () => {
      const preparedBuffer = Buffer.from('already inspected');

      await processCodeOutput({ ...baseParams, preparedBuffer });

      expect(mockAxios).not.toHaveBeenCalled();
      expect(mockClaimCodeFile).toHaveBeenCalledTimes(1);
      expect(mockCommitCodeFile).toHaveBeenCalledTimes(1);
    });

    it('enforces a caller-provided aggregate inspection budget while downloading', async () => {
      mockAxios.mockResolvedValue({ data: Buffer.from('too large') });

      await expect(
        prepareCodeOutputForInspection({
          ...baseParams,
          maxBytes: 4,
        }),
      ).rejects.toThrow('Generated file exceeds the 4-byte transport limit');

      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          maxContentLength: 4,
          maxBodyLength: 4,
        }),
      );
      expect(mockClaimCodeFile).not.toHaveBeenCalled();
      expect(mockCommitCodeFile).not.toHaveBeenCalled();
    });

    it('extracts text bytes even when the generated filename spoofs an image extension', async () => {
      const buffer = Buffer.from('PRIVATE-SECRET');
      mockAxios.mockResolvedValue({ data: buffer });
      determineFileType.mockResolvedValueOnce(undefined);
      mockClassifyCodeArtifact.mockReturnValueOnce('utf8-text');
      mockExtractCodeArtifactRawText.mockReturnValueOnce('PRIVATE-SECRET');
      mockExtractCodeArtifactInspectionText.mockResolvedValueOnce({
        text: 'PRIVATE-SECRET',
        complete: true,
      });

      const prepared = await prepareCodeOutputForInspection({
        ...baseParams,
        name: 'secret.png',
      });

      expect(mockExtractCodeArtifactRawText).toHaveBeenCalledWith(buffer, 'utf8-text');
      expect(prepared.file).toMatchObject({
        name: 'secret.png',
        type: 'text/plain',
        content: 'PRIVATE-SECRET',
        extractedText: 'PRIVATE-SECRET',
      });
    });

    it('returns the explicit bounded fallback without a second download or persistence', async () => {
      const result = await processCodeOutput({
        ...baseParams,
        downloadFallback: true,
      });

      expect(result.file).toMatchObject({
        filename: 'test-file.txt',
        filepath: '/api/files/code/download/session-123/file-id-123',
      });
      expect(mockAxios).not.toHaveBeenCalled();
      expect(mockClaimCodeFile).not.toHaveBeenCalled();
      expect(mockCommitCodeFile).not.toHaveBeenCalled();
    });
  });

  describe('published run artifacts', () => {
    const scope = {
      userId: 'user-123',
      conversationId: 'conv-123',
      runId: 'parent-run',
      executionId: 'child-run',
      agentId: 'child-agent',
      sourceFileId: 'file-id-123',
    };
    const provenance = {
      runId: scope.runId,
      executionId: scope.executionId,
      agentId: scope.agentId,
      sourceFileId: scope.sourceFileId,
      parentExecutionId: 'parent-execution',
      publishedAt: '2026-09-11T16:00:00.000Z',
      inputFileIds: ['input-pdf'],
    };

    it('stores the existing output pipeline result through the publication boundary', async () => {
      const publish = jest.fn(async ({ file }) => ({
        ...file,
        file_id: 'published-id',
        user: scope.userId,
        conversationId: scope.conversationId,
        context: FileContext.run_artifact,
        metadata: { ...file.metadata, runFile: provenance },
      }));
      const discard = jest.fn();
      const result = await processCodeOutput({
        ...baseParams,
        preparedBuffer: Buffer.from('report data'),
        publication: { scope, provenance, publish, find: jest.fn(), discard },
      });
      expect(result.file).toMatchObject({
        file_id: 'published-id',
        filename: baseParams.name,
        context: FileContext.run_artifact,
        metadata: { runFile: provenance },
      });
      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ scope, provenance }));
      expect(mockClaimCodeFile).not.toHaveBeenCalled();
      expect(mockCommitCodeFile).not.toHaveBeenCalled();
      expect(discard).not.toHaveBeenCalled();
    });

    it('finalizes office previews against the canonical published file identity', async () => {
      mockHasOfficeHtmlPath.mockReturnValueOnce(true);
      const publish = jest.fn(async ({ file }) => ({
        ...file,
        file_id: 'published-office-id',
        user: scope.userId,
        conversationId: scope.conversationId,
        context: FileContext.run_artifact,
        metadata: { ...file.metadata, runFile: provenance },
      }));
      const result = await processCodeOutput({
        ...baseParams,
        name: 'report.csv',
        preparedBuffer: Buffer.from('a,b\n1,2'),
        publication: { scope, provenance, publish, find: jest.fn(), discard: jest.fn() },
      });
      expect(result.file.file_id).toBe('published-office-id');
      expect(result.file.status).toBe('pending');
      await result.finalize();
      expect(require('~/models').updateFile).toHaveBeenCalledWith(
        expect.objectContaining({ file_id: 'published-office-id' }),
        { previewRevision: result.previewRevision },
      );
    });

    it('cleans a stored publication attempt when classification fails before metadata commit', async () => {
      const { createRunArtifactPublisher } = jest.requireActual('@librechat/api');
      const discard = jest.fn(async () => undefined);
      const publishRunArtifactFile = jest.fn();
      mockClassifyCodeArtifact.mockImplementationOnce(() => {
        throw new Error('Classification failed after storage');
      });
      const publish = createRunArtifactPublisher({
        claimRunArtifactFile: async () => ({ file_id: 'published-id' }),
        publishRunArtifactFile,
        findRunArtifactFile: async () => null,
        processCodeOutput: (input) => processCodeOutput({ ...input, req: mockReq }),
        prepare: async () => Buffer.from('report data'),
        discard,
        finalize: jest.fn(),
      });
      await expect(
        publish({
          scope,
          provenance,
          artifact: { id: baseParams.id, name: baseParams.name, sessionId: baseParams.session_id },
        }),
      ).rejects.toThrow('durable storage');
      expect(publishRunArtifactFile).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledWith(
        expect.objectContaining({
          file_id: 'mock-uuid-1234',
          filepath: '/uploads/mock-file-path.txt',
          metadata: undefined,
        }),
      );
      expect(discard).toHaveBeenCalledTimes(1);
    });

    it('cleans a generated image cancelled after conversion without publishing it', async () => {
      const { createRunArtifactPublisher } = jest.requireActual('@librechat/api');
      const controller = new AbortController();
      const discard = jest.fn(async () => undefined);
      const publishRunArtifactFile = jest.fn();
      convertImage.mockImplementationOnce(async () => {
        controller.abort(new Error('Publication generation expired'));
        return { filepath: '/uploads/generated.webp', bytes: 12, width: 2, height: 2 };
      });
      const publish = createRunArtifactPublisher({
        claimRunArtifactFile: async () => ({ file_id: 'published-id' }),
        publishRunArtifactFile,
        findRunArtifactFile: async () => null,
        processCodeOutput: (input) => processCodeOutput({ ...input, req: mockReq }),
        prepare: async () => Buffer.from('image data'),
        discard,
        finalize: jest.fn(),
      });
      await expect(
        publish({
          scope,
          provenance,
          artifact: { id: baseParams.id, name: 'generated.png', sessionId: baseParams.session_id },
          signal: controller.signal,
        }),
      ).rejects.toThrow('generation expired');
      expect(publishRunArtifactFile).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledWith(
        expect.objectContaining({
          filepath: '/uploads/generated.webp',
          file_id: 'mock-uuid-1234',
          metadata: undefined,
        }),
      );
      expect(discard).toHaveBeenCalledTimes(1);
    });
  });

  describe('atomic file claim (via processCodeOutput)', () => {
    it('should reuse file_id from existing record via atomic claim', async () => {
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'existing-file-id',
        filename: 'test-file.txt',
        usage: 2,
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const smallBuffer = Buffer.alloc(100);
      mockAxios.mockResolvedValue({ data: smallBuffer });

      const { file: result } = await processCodeOutput(baseParams);

      expect(mockClaimCodeFile).toHaveBeenCalledWith({
        filename: 'test-file.txt',
        conversationId: 'conv-123',
        file_id: 'mock-uuid-1234',
        user: 'user-123',
        sourceDispatchedAt: expect.any(Number),
      });

      expect(result.file_id).toBe('existing-file-id');
      expect(result.usage).toBe(3);
      expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });

    it('should create new file when no existing file found', async () => {
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'mock-uuid-1234',
        user: 'user-123',
      });

      const smallBuffer = Buffer.alloc(100);
      mockAxios.mockResolvedValue({ data: smallBuffer });

      const { file: result } = await processCodeOutput(baseParams);

      expect(result.file_id).toBe('mock-uuid-1234');
      expect(result.usage).toBe(1);
      expect(getRetentionExpiry).toHaveBeenCalledWith(baseParams.req);
    });

    it('skips the file when the claim is newer than the background run (stale-harvest guard)', async () => {
      /* A newer run owns the filename slot and the (filename, conversationId)
       * unique index leaves stale bytes nowhere to live — the detached
       * harvest must not overwrite fresh content. */
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'existing-file-id',
        filename: 'test-file.txt',
        messageId: 'newer-run-msg',
        updatedAt: '2024-01-02T00:00:00.000Z',
      });
      mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

      const result = await processCodeOutput({
        ...baseParams,
        freshClaimAfter: new Date('2024-01-01T00:00:00.000Z').getTime(),
      });

      expect(result).toBeNull();
      expect(mockCommitCodeFile).not.toHaveBeenCalled();
    });

    it('still reuses the claim when it predates the background run', async () => {
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'existing-file-id',
        filename: 'test-file.txt',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      mockCommitCodeFile.mockResolvedValue(true);
      mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

      const { file: result } = await processCodeOutput({
        ...baseParams,
        freshClaimAfter: new Date('2024-01-02T00:00:00.000Z').getTime(),
      });

      expect(result.file_id).toBe('existing-file-id');
      expect(mockCommitCodeFile).toHaveBeenCalledWith(
        expect.objectContaining({ file_id: 'existing-file-id' }),
        new Date('2024-01-02T00:00:00.000Z').getTime(),
      );
    });

    it('skips when a newer task holds an unwritten claim (insert stamp, no updatedAt yet)', async () => {
      /* A newer task claimed the filename but its content write is still in
       * flight: the claim-insert stamp alone must trip the guard. */
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'existing-file-id',
        filename: 'test-file.txt',
        metadata: {
          sourceDispatchedAt: new Date('2024-01-02T00:00:00.000Z').getTime(),
        },
      });
      mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

      const result = await processCodeOutput({
        ...baseParams,
        freshClaimAfter: new Date('2024-01-01T00:00:00.000Z').getTime(),
      });

      expect(result).toBeNull();
      expect(mockCommitCodeFile).not.toHaveBeenCalled();
    });

    it('omits output when the commit boundary rejects an overtaken claim', async () => {
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'mock-uuid-1234',
        user: 'user-123',
      });
      mockCommitCodeFile.mockResolvedValueOnce(false);
      mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

      const result = await processCodeOutput({
        ...baseParams,
        freshClaimAfter: new Date('2024-01-01T00:00:00.000Z').getTime(),
      });

      expect(result).toBeNull();
      expect(mockCommitCodeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          file_id: 'mock-uuid-1234',
          metadata: expect.objectContaining({
            sourceDispatchedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
          }),
        }),
        new Date('2024-01-01T00:00:00.000Z').getTime(),
      );
    });

    it('commits when the conditional write matches (ownership held through the write)', async () => {
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'existing-file-id',
        filename: 'test-file.txt',
        updatedAt: '2024-01-01T00:00:00.000Z',
      });
      mockCommitCodeFile.mockResolvedValueOnce(true);
      mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

      const { file: result } = await processCodeOutput({
        ...baseParams,
        freshClaimAfter: new Date('2024-01-02T00:00:00.000Z').getTime(),
      });

      expect(result.file_id).toBe('existing-file-id');
    });

    it('lets a newer task overwrite an OLDER task that wrote late (writer dispatch order wins)', async () => {
      /* Old task (dispatched Jan 1) settled late and wrote at Jan 3;
       * this task was dispatched Jan 2. Wall-clock updatedAt is newer
       * than our dispatch, but the WRITER is older — overwrite. */
      mockClaimCodeFile.mockResolvedValue({
        file_id: 'existing-file-id',
        filename: 'test-file.txt',
        updatedAt: '2024-01-03T00:00:00.000Z',
        metadata: {
          sourceDispatchedAt: new Date('2024-01-01T00:00:00.000Z').getTime(),
        },
      });
      mockCommitCodeFile.mockResolvedValue(true);
      mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

      const { file: result } = await processCodeOutput({
        ...baseParams,
        freshClaimAfter: new Date('2024-01-02T00:00:00.000Z').getTime(),
      });

      expect(result.file_id).toBe('existing-file-id');
      expect(result.metadata.sourceDispatchedAt).toBe(
        new Date('2024-01-02T00:00:00.000Z').getTime(),
      );
    });
  });

  describe('processCodeOutput', () => {
    it('forwards Code API auth headers when downloading generated output', async () => {
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer codeapi-token' });
      mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

      await processCodeOutput(baseParams);

      expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(mockReq, undefined);
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'get',
          headers: expect.objectContaining({
            Authorization: 'Bearer codeapi-token',
            'User-Agent': 'LibreChat/1.0',
          }),
        }),
      );
    });

    describe('image file processing', () => {
      it('should process image files using convertImage', async () => {
        const imageParams = { ...baseParams, name: 'chart.png' };
        const imageBuffer = Buffer.alloc(500);
        mockAxios.mockResolvedValue({ data: imageBuffer });

        const convertedFile = {
          filepath: '/uploads/converted-image.webp',
          bytes: 400,
        };
        convertImage.mockResolvedValue(convertedFile);

        const { file: result } = await processCodeOutput(imageParams);

        expect(convertImage).toHaveBeenCalledWith(
          mockReq,
          imageBuffer,
          'high',
          'mock-uuid-1234.png',
        );
        expect(result.type).toBe('image/webp');
        expect(result.context).toBe(FileContext.execute_code);
        expect(result.filename).toBe('chart.png');
      });

      it('persists tenantId on image code output records when present', async () => {
        const tenantReq = { ...mockReq, user: { ...mockReq.user, tenantId: 'tenantA' } };
        const imageBuffer = Buffer.alloc(500);
        mockAxios.mockResolvedValue({ data: imageBuffer });
        convertImage.mockResolvedValue({
          filepath: '/t/tenantA/images/user-123/mock-uuid-1234.webp',
        });

        await processCodeOutput({
          ...baseParams,
          req: tenantReq,
          name: 'chart.png',
        });

        expect(mockClaimCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId: 'tenantA' }),
        );
        expect(mockCommitCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId: 'tenantA' }),
          undefined,
        );
      });

      it('should update existing image file with cache-busted filepath', async () => {
        const imageParams = { ...baseParams, name: 'chart.png' };
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'existing-img-id',
          usage: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
        });

        const imageBuffer = Buffer.alloc(500);
        mockAxios.mockResolvedValue({ data: imageBuffer });
        convertImage.mockResolvedValue({ filepath: '/images/user-123/existing-img-id.webp' });

        const { file: result } = await processCodeOutput(imageParams);

        expect(convertImage).toHaveBeenCalledWith(
          mockReq,
          imageBuffer,
          'high',
          'existing-img-id.png',
        );
        expect(result.file_id).toBe('existing-img-id');
        expect(result.usage).toBe(2);
        expect(result.filepath).toMatch(/^\/images\/user-123\/existing-img-id\.webp\?v=\d+$/);
        expect(logger.debug).toHaveBeenCalledWith(
          expect.stringContaining('Updating existing file'),
        );
      });
    });

    describe('non-image file processing', () => {
      it('should process non-image files using saveBuffer', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const mockSaveBuffer = jest.fn().mockResolvedValue('/uploads/saved-file.txt');
        getStrategyFunctions.mockReturnValue({ saveBuffer: mockSaveBuffer });
        determineFileType.mockResolvedValue({ mime: 'text/plain' });

        const { file: result } = await processCodeOutput(baseParams);

        expect(mockSaveBuffer).toHaveBeenCalledWith({
          userId: 'user-123',
          buffer: smallBuffer,
          fileName: 'mock-uuid-1234__test-file.txt',
          basePath: 'uploads',
        });
        expect(result.type).toBe('text/plain');
        expect(result.filepath).toBe('/uploads/saved-file.txt');
        expect(result.bytes).toBe(100);
      });

      it.each([
        [
          'slides.pptx',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ],
        ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        [
          'document.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
      ])('preserves stored metadata for code-generated office file %s', async (name, mime) => {
        const cloudfrontReq = {
          ...mockReq,
          user: { ...mockReq.user, tenantId: 'tenantA' },
          config: { ...mockReq.config, fileStrategy: 'cloudfront' },
        };
        const smallBuffer = Buffer.alloc(100);
        const filepath = `https://cdn.example.com/r/us-east-2/t/tenantA/uploads/user-123/mock-uuid-1234__${name}`;
        const storageKey = `r/us-east-2/t/tenantA/uploads/user-123/mock-uuid-1234__${name}`;
        mockAxios.mockResolvedValue({ data: smallBuffer });
        determineFileType.mockResolvedValue({ mime });
        mockHasOfficeHtmlPath.mockReturnValueOnce(true);
        getStorageMetadata.mockReturnValueOnce({ storageKey, storageRegion: 'us-east-2' });
        const mockSaveBuffer = jest.fn().mockResolvedValue(filepath);
        getStrategyFunctions.mockReturnValue({ saveBuffer: mockSaveBuffer });

        const { file: result, finalize } = await processCodeOutput({
          ...baseParams,
          req: cloudfrontReq,
          name,
        });

        expect(mockSaveBuffer).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'user-123',
            basePath: 'uploads',
            tenantId: 'tenantA',
          }),
        );
        expect(result).toMatchObject({
          file_id: 'mock-uuid-1234',
          user: 'user-123',
          tenantId: 'tenantA',
          source: 'cloudfront',
          filename: name,
          filepath,
          storageKey,
          storageRegion: 'us-east-2',
          status: 'pending',
        });
        expect(mockCommitCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({
            file_id: 'mock-uuid-1234',
            user: 'user-123',
            tenantId: 'tenantA',
            source: 'cloudfront',
            storageKey,
            storageRegion: 'us-east-2',
          }),
          undefined,
        );
        expect(typeof finalize).toBe('function');
      });

      it('passes and persists tenantId for non-image code output records', async () => {
        const tenantReq = { ...mockReq, user: { ...mockReq.user, tenantId: 'tenantA' } };
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const mockSaveBuffer = jest
          .fn()
          .mockResolvedValue('/t/tenantA/uploads/user-123/mock-file-path.txt');
        getStrategyFunctions.mockReturnValue({ saveBuffer: mockSaveBuffer });

        await processCodeOutput({
          ...baseParams,
          req: tenantReq,
        });

        expect(mockClaimCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId: 'tenantA' }),
        );
        expect(mockSaveBuffer).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId: 'tenantA' }),
        );
        expect(mockCommitCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({ tenantId: 'tenantA' }),
          undefined,
        );
      });

      it('preserves nested directory paths in the DB record while flattening the storage key', async () => {
        /* Regression test for the silent-data-loss path: when codeapi reports a
         * file with a nested name like "test_folder/test_file.txt", LibreChat
         * used to feed it through `sanitizeFilename` (basename-only), which
         * persisted "test_file.txt" to the DB and made the file un-locatable on
         * the next prime() (cat /mnt/data/test_folder/test_file.txt would
         * 404). The fix: keep the path on the DB record (so primeFiles can
         * place it back at the same nested location), but flatten it for the
         * storage key (saveBuffer strategies key by single component). */
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });
        const mockSaveBuffer = jest.fn().mockResolvedValue('/uploads/saved.txt');
        getStrategyFunctions.mockReturnValue({ saveBuffer: mockSaveBuffer });

        const { file: result } = await processCodeOutput({
          ...baseParams,
          name: 'test_folder/test_file.txt',
        });

        // Storage key flattens `/` to `__` so on-disk strategies don't
        // accidentally create real subdirectories under uploads/.
        expect(mockSaveBuffer).toHaveBeenCalledWith(
          expect.objectContaining({
            fileName: 'mock-uuid-1234__test_folder__test_file.txt',
          }),
        );
        // DB row keeps the nested path verbatim — that's what primeFiles
        // ships back to the sandbox on the next turn.
        expect(result.filename).toBe('test_folder/test_file.txt');
        // Claim is also keyed by the path-preserving name so the
        // (filename, conversationId) compound key stays consistent.
        expect(mockClaimCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({ filename: 'test_folder/test_file.txt' }),
        );
      });

      it('passes a NAME_MAX-aware budget to flattenArtifactPath when composing the storage key', async () => {
        /* Codex review P1: per-segment caps on the path-preserving form
         * aren't enough — once the segments are joined with `__` for the
         * storage key, deeply-nested or moderately long paths can still
         * exceed filesystem NAME_MAX (255) and cause `ENAMETOOLONG` in
         * saveBuffer. processCodeOutput must pass a file_id-aware budget
         * to flattenArtifactPath so the cap holds end-to-end. The unit
         * tests in `packages/api/src/utils/files.spec.ts` cover the
         * truncation logic itself; this test covers the integration. */
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });
        const mockSaveBuffer = jest.fn().mockResolvedValue('/uploads/saved.bin');
        getStrategyFunctions.mockReturnValue({ saveBuffer: mockSaveBuffer });

        const flattenSpy = require('@librechat/api').flattenArtifactPath;
        flattenSpy.mockClear();

        await processCodeOutput({ ...baseParams, name: 'a/b/c.csv' });

        // The handler should call flattenArtifactPath with both the
        // safeName AND a budget = NAME_MAX (255) minus the prefix
        // (`${file_id}__`). file_id mock is `mock-uuid-1234` (14 chars),
        // so the budget should be 255 - 14 - 2 = 239.
        expect(flattenSpy).toHaveBeenCalledWith(expect.any(String), 239);
      });

      it('passes the basename (not the full nested path) to classifyCodeArtifact and extractCodeArtifactText', async () => {
        /* Codex review P2: with the path-preserving sanitizer, `safeName`
         * can be a nested string like `reports.v1/Makefile`. The
         * classifier reads `extensionOf` against the full string, which
         * sees `.v1/Makefile` after the dotted-dir's first dot and
         * misclassifies the file as `other` (so text extraction is
         * skipped). Pass `path.basename(safeName)` instead. */
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });
        const mockSaveBuffer = jest.fn().mockResolvedValue('/uploads/saved.txt');
        getStrategyFunctions.mockReturnValue({ saveBuffer: mockSaveBuffer });

        await processCodeOutput({
          ...baseParams,
          name: 'reports.v1/Makefile',
        });

        expect(mockClassifyCodeArtifact).toHaveBeenCalledWith('Makefile', expect.any(String));
        expect(mockExtractCodeArtifactText).toHaveBeenCalledWith(
          expect.any(Buffer),
          'Makefile',
          expect.any(String),
          expect.any(String),
        );
      });

      it('should detect MIME type from buffer', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });
        determineFileType.mockResolvedValue({ mime: 'application/pdf' });

        const { file: result } = await processCodeOutput({ ...baseParams, name: 'document.pdf' });

        expect(determineFileType).toHaveBeenCalledWith(smallBuffer, true);
        expect(result.type).toBe('application/pdf');
      });

      it('should fallback to application/octet-stream for unknown types', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });
        determineFileType.mockResolvedValue(null);

        const { file: result } = await processCodeOutput({ ...baseParams, name: 'unknown.xyz' });

        expect(result.type).toBe('application/octet-stream');
      });
    });

    describe('inline text extraction', () => {
      it('should populate text on the file when extractor returns content', async () => {
        const buffer = Buffer.from('hello world\n', 'utf-8');
        mockAxios.mockResolvedValue({ data: buffer });
        determineFileType.mockResolvedValue({ mime: 'text/plain' });
        mockClassifyCodeArtifact.mockReturnValueOnce('utf8-text');
        mockExtractCodeArtifactText.mockResolvedValueOnce('hello world\n');

        const { file: result } = await processCodeOutput({ ...baseParams, name: 'note.txt' });

        expect(mockClassifyCodeArtifact).toHaveBeenCalledWith('note.txt', 'text/plain');
        expect(mockExtractCodeArtifactText).toHaveBeenCalledWith(
          buffer,
          'note.txt',
          'text/plain',
          'utf8-text',
        );
        expect(result.text).toBe('hello world\n');
        expect(mockCommitCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({ text: 'hello world\n' }),
          undefined,
        );
      });

      it('should set text to null when extractor returns null so updates clear stale values', async () => {
        const buffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: buffer });
        determineFileType.mockResolvedValue({ mime: 'application/octet-stream' });
        mockClassifyCodeArtifact.mockReturnValueOnce('other');
        mockExtractCodeArtifactText.mockResolvedValueOnce(null);

        const { file: result } = await processCodeOutput({ ...baseParams, name: 'archive.zip' });

        expect(result.text).toBeNull();
        const createCall = mockCommitCodeFile.mock.calls[0][0];
        expect(createCall.text).toBeNull();
      });

      it('should overwrite a previously-stored text value when re-emitting a now-binary file', async () => {
        // Same filename + conversationId already has a stored text value;
        // claimCodeFile returns the existing record (isUpdate path).
        mockClaimCodeFile.mockResolvedValueOnce({
          file_id: 'existing-id',
          filename: 'output.bin',
          usage: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
        });
        const binaryBuffer = Buffer.from([0x00, 0xff, 0x00, 0xff]);
        mockAxios.mockResolvedValue({ data: binaryBuffer });
        determineFileType.mockResolvedValue({ mime: 'application/octet-stream' });
        mockClassifyCodeArtifact.mockReturnValueOnce('other');
        mockExtractCodeArtifactText.mockResolvedValueOnce(null);

        await processCodeOutput({ ...baseParams, name: 'output.bin' });

        // null (not omitted) so $set clears any prior `text` value.
        const createCall = mockCommitCodeFile.mock.calls[0][0];
        expect(createCall).toHaveProperty('text', null);
      });

      it('should not invoke text extraction for image files', async () => {
        const imageBuffer = Buffer.alloc(500);
        mockAxios.mockResolvedValue({ data: imageBuffer });
        convertImage.mockResolvedValue({ filepath: '/uploads/x.webp', bytes: 400 });

        await processCodeOutput({ ...baseParams, name: 'chart.png' });

        expect(mockClassifyCodeArtifact).not.toHaveBeenCalled();
        expect(mockExtractCodeArtifactText).not.toHaveBeenCalled();
      });

      it('clears deferred-preview lifecycle fields so a prior office record at this file_id stops looking pending', async () => {
        /* Codex P2: same (filename, conversationId) was previously an
         * office artifact, leaving status/previewError/previewRevision
         * populated. The non-office update must reset them or the
         * client renders the wrong state for the now non-office file. */
        mockClaimCodeFile.mockResolvedValueOnce({
          file_id: 'reused-id',
          filename: 'output.txt',
          usage: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
        });
        mockAxios.mockResolvedValue({ data: Buffer.from('hello') });
        determineFileType.mockResolvedValue({ mime: 'text/plain' });
        mockClassifyCodeArtifact.mockReturnValueOnce('text');
        mockHasOfficeHtmlPath.mockReturnValueOnce(false);
        mockExtractCodeArtifactText.mockResolvedValueOnce('hello');

        await processCodeOutput({ ...baseParams, name: 'output.txt' });

        const createCall = mockCommitCodeFile.mock.calls[0][0];
        expect(createCall).toHaveProperty('status', null);
        expect(createCall).toHaveProperty('previewError', null);
        expect(createCall).toHaveProperty('previewRevision', null);
      });
    });

    describe('file size limit enforcement', () => {
      it('treats a zero configured limit as unlimited within the hard transport ceiling', async () => {
        fileSizeLimitConfig.value = 0;
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });

        await processCodeOutput(baseParams);

        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            maxContentLength: 64 * 1024 * 1024,
            maxBodyLength: 64 * 1024 * 1024,
          }),
        );
        expect(mockClaimCodeFile).toHaveBeenCalledTimes(1);
        expect(mockCommitCodeFile).toHaveBeenCalledTimes(1);
      });

      it('should fallback to download URL when file exceeds size limit', async () => {
        // Set a small file size limit for this test
        fileSizeLimitConfig.value = 1000; // 1KB limit

        const largeBuffer = Buffer.alloc(5000); // 5KB - exceeds 1KB limit
        mockAxios.mockResolvedValue({ data: largeBuffer });

        const { file: result } = await processCodeOutput(baseParams);

        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            maxContentLength: 1000,
            maxBodyLength: 1000,
          }),
        );
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('exceeds size limit'));
        expect(result.filepath).toContain('/api/files/code/download/session-123/file-id-123');
        expect(result.expiresAt).toBeDefined();
        // Oversized files use the download fallback without committing metadata.
        expect(mockCommitCodeFile).not.toHaveBeenCalled();

        // Reset to default for other tests
        fileSizeLimitConfig.value = 20 * 1024 * 1024;
      });

      it('uses the existing download fallback when Axios stops an oversized response', async () => {
        fileSizeLimitConfig.value = 1000;
        mockAxios.mockRejectedValue(new Error('maxContentLength size of 1000 exceeded'));

        const { file: result } = await processCodeOutput(baseParams);

        expect(result.filepath).toContain('/api/files/code/download/session-123/file-id-123');
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Generated file exceeds size limit'),
        );
        expect(mockClaimCodeFile).not.toHaveBeenCalled();
        expect(mockCommitCodeFile).not.toHaveBeenCalled();

        fileSizeLimitConfig.value = 20 * 1024 * 1024;
      });
    });

    describe('fallback behavior', () => {
      it('preserves the stateful route in generated downloads and fallbacks', async () => {
        mockAxios.mockRejectedValue(new Error('Network error'));
        const executionRouteKey = `stateful:${'a'.repeat(32)}`;

        const { file: result } = await processCodeOutput({
          ...baseParams,
          codeApiBaseUrl: 'https://code-stateful.example.com',
          executionProfile: 'stateful',
          bridgeWorkerId: 'personal-worker-1',
          executionRouteKey,
        });

        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            url: expect.stringContaining('https://code-stateful.example.com/download/'),
            headers: expect.objectContaining({
              'X-CodeAPI-Expected-Profile': 'stateful',
              'X-LibreChat-Code-Worker-ID': 'personal-worker-1',
            }),
          }),
        );
        expect(result.filepath).toContain('execution_profile=stateful');
        expect(result.filepath).toContain(
          `execution_route_key=${encodeURIComponent(executionRouteKey)}`,
        );
      });

      it('should fallback to download URL when saveBuffer is not available', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });
        getStrategyFunctions.mockReturnValue({ saveBuffer: null });

        const { file: result } = await processCodeOutput(baseParams);

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('saveBuffer not available'),
        );
        expect(result.filepath).toContain('/api/files/code/download/');
        expect(result.filename).toBe('test-file.txt');
      });

      it('should fallback to download URL on axios error', async () => {
        mockAxios.mockRejectedValue(new Error('Network error'));

        const { file: result } = await processCodeOutput(baseParams);

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Falling back to Code API download URL for strategy local'),
        );
        expect(result.filepath).toContain('/api/files/code/download/session-123/file-id-123');
        expect(result.conversationId).toBe('conv-123');
        expect(result.messageId).toBe('msg-123');
        expect(result.toolCallId).toBe('tool-call-123');
      });
    });

    describe('usage counter increment', () => {
      it('should set usage to 1 for new files', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const { file: result } = await processCodeOutput(baseParams);

        expect(result.usage).toBe(1);
      });

      it('should increment usage for existing files', async () => {
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'existing-id',
          usage: 5,
          createdAt: '2024-01-01',
        });
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const { file: result } = await processCodeOutput(baseParams);

        expect(result.usage).toBe(6);
      });

      it('should handle existing file with undefined usage', async () => {
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'existing-id',
          createdAt: '2024-01-01',
        });
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const { file: result } = await processCodeOutput(baseParams);

        expect(result.usage).toBe(1);
      });
    });

    describe('metadata and file properties', () => {
      it('should include codeEnvRef in metadata with kind: user', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const { file: result } = await processCodeOutput(baseParams);

        expect(result.metadata).toEqual({
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'session-123',
            file_id: 'file-id-123',
            executionProfile: 'default',
          },
          codeEnvRefs: {
            default: {
              kind: 'user',
              id: 'user-123',
              storage_session_id: 'session-123',
              file_id: 'file-id-123',
              executionProfile: 'default',
            },
          },
          sourceDispatchedAt: expect.any(Number),
        });
      });

      it('persists the originating profile on a stateful artifact ref', async () => {
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        const executionRouteKey = `stateful:${'a'.repeat(32)}`;

        const { file: result } = await processCodeOutput({
          ...baseParams,
          codeApiBaseUrl: 'https://code-stateful.example.com',
          executionProfile: 'stateful',
          executionRouteKey,
        });

        expect(result.metadata.codeEnvRef).toEqual(
          expect.objectContaining({ executionProfile: 'stateful', executionRouteKey }),
        );
        expect(result.metadata.codeEnvRefs[executionRouteKey]).toEqual(result.metadata.codeEnvRef);
      });

      /* Phase C lock-in: outputs are ALWAYS user-scoped, never skill-scoped.
       * Even when an execution turn invoked a skill (so input files were
       * `kind: 'skill'` shared cross-user), the resulting output bucket
       * tags `kind: 'user'` with the requesting user's id. This prevents
       * cross-user leakage of artifacts a skill may have generated for
       * one user — each user gets their own output sessionKey on codeapi.
       *
       * Drift hazard: someone reading the simple user-derivation may
       * later think "we should respect input kind for outputs too" and
       * widen output scope to match input scope. This test pins the
       * intentional asymmetry so that change requires updating the test
       * (and re-reading the rationale). */
      it('outputs are user-scoped regardless of which skill the execution invoked', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const userA = { ...mockReq, user: { id: 'user-A' } };
        const userB = { ...mockReq, user: { id: 'user-B' } };

        const { file: outputA } = await processCodeOutput({ ...baseParams, req: userA });
        const { file: outputB } = await processCodeOutput({ ...baseParams, req: userB });

        // Each user's output ref is keyed by their own user id. The
        // `id` field tracks the requesting user, never the skill.
        expect(outputA.metadata.codeEnvRef).toEqual({
          kind: 'user',
          id: 'user-A',
          storage_session_id: 'session-123',
          file_id: 'file-id-123',
          executionProfile: 'default',
        });
        expect(outputB.metadata.codeEnvRef).toEqual({
          kind: 'user',
          id: 'user-B',
          storage_session_id: 'session-123',
          file_id: 'file-id-123',
          executionProfile: 'default',
        });

        // No skill identity leaks into the output ref under any property.
        const refA = outputA.metadata.codeEnvRef;
        const refB = outputB.metadata.codeEnvRef;
        expect(refA.kind).not.toBe('skill');
        expect(refB.kind).not.toBe('skill');
        expect(refA).not.toHaveProperty('version');
        expect(refB).not.toHaveProperty('version');
      });

      it('should set correct context for code-generated files', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const { file: result } = await processCodeOutput(baseParams);

        expect(result.context).toBe(FileContext.execute_code);
      });

      it('should include toolCallId and messageId in result', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const { file: result } = await processCodeOutput(baseParams);

        expect(result.toolCallId).toBe('tool-call-123');
        expect(result.messageId).toBe('msg-123');
      });

      it('commits foreground output without a background dispatch constraint', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        await processCodeOutput(baseParams);

        expect(mockCommitCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({
            file_id: 'mock-uuid-1234',
            context: FileContext.execute_code,
          }),
          undefined,
        );
      });
    });

    describe('persistedMessageId (regression for cross-turn priming)', () => {
      /**
       * `getCodeGeneratedFiles` filters by `messageId IN <thread message ids>`
       * to scope files to the current branch. If `processCodeOutput` overwrote
       * the file's `messageId` with the current run's id on every update, a
       * file re-touched by a later turn (e.g. a failed read attempt that
       * re-shells the same filename) would lose its link to the assistant
       * message that originally produced it. Subsequent turns then can't find
       * it via `getCodeGeneratedFiles`, the priming chain has nothing to seed,
       * and the model thinks its own prior-turn artifact disappeared.
       *
       * Contract:
       *  - On UPDATE (claimCodeFile returned an existing record): the persisted
       *    `messageId` is `claimed.messageId` (preserved). Falls back to the
       *    current run's `messageId` when the existing record predates the
       *    `messageId` field (legacy data).
       *  - On CREATE (new file): the persisted `messageId` is the current run's.
       *  - The runtime return value ALWAYS uses the current run's `messageId`
       *    via `Object.assign(file, { messageId, toolCallId })` so the artifact
       *    attaches to the correct tool_call in the live response.
       */

      /**
       * `processCodeOutput` mutates the file object after `commitCodeFile` returns
       * (`Object.assign(file, { messageId, toolCallId })`) so the runtime
       * caller sees the live messageId on the response. Reading
       * `mockCommitCodeFile.mock.calls[0][0]` directly would therefore reflect the
       * post-mutation state because JS captures by reference. To assert
       * what was actually PERSISTED, snapshot the args at call time.
       */
      function snapshotCommitCodeFileArgs() {
        const snapshots = [];
        mockCommitCodeFile.mockImplementation(async (file) => {
          snapshots.push({ ...file });
          return true;
        });
        return snapshots;
      }

      it('preserves the original messageId in the persisted record on UPDATE', async () => {
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'existing-id',
          filename: 'sentinel.txt',
          usage: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
          messageId: 'turn-1-original-msg',
        });
        const persisted = snapshotCommitCodeFileArgs();

        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        await processCodeOutput({
          ...baseParams,
          name: 'sentinel.txt',
          messageId: 'turn-2-current-run-msg',
        });

        expect(persisted[0].messageId).toBe('turn-1-original-msg');
      });

      it('falls back to current run messageId on UPDATE when claimed.messageId is undefined (legacy record)', async () => {
        // Legacy record predates the persistedMessageId tracking.
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'legacy-id',
          filename: 'legacy.txt',
          usage: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
          // messageId intentionally absent
        });
        const persisted = snapshotCommitCodeFileArgs();

        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        await processCodeOutput({
          ...baseParams,
          name: 'legacy.txt',
          messageId: 'turn-N-current-run-msg',
        });

        expect(persisted[0].messageId).toBe('turn-N-current-run-msg');
      });

      it('uses the current run messageId on CREATE (no claimed record)', async () => {
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'mock-uuid-1234',
          user: 'user-123',
        });
        const persisted = snapshotCommitCodeFileArgs();

        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        await processCodeOutput({
          ...baseParams,
          messageId: 'turn-1-create-msg',
        });

        expect(persisted[0].messageId).toBe('turn-1-create-msg');
      });

      it('returns the CURRENT run messageId in the runtime response even on UPDATE (artifact attribution)', async () => {
        // The persisted DB record keeps the original messageId, but the
        // returned object surfaces the live messageId so the artifact lands
        // on the correct tool_call in this run's response.
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'existing-id',
          filename: 'sentinel.txt',
          usage: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
          messageId: 'turn-1-original-msg',
        });
        const persisted = snapshotCommitCodeFileArgs();

        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        const { file: result } = await processCodeOutput({
          ...baseParams,
          name: 'sentinel.txt',
          messageId: 'turn-2-current-run-msg',
        });

        // DB preserves original
        expect(persisted[0].messageId).toBe('turn-1-original-msg');
        // Runtime return surfaces the live (current) messageId
        expect(result.messageId).toBe('turn-2-current-run-msg');
      });

      it('preserves the original messageId on UPDATE for image files too', async () => {
        // Same contract as text files; the image branch builds its own file
        // record and would silently regress if the ternary diverged there.
        mockClaimCodeFile.mockResolvedValue({
          file_id: 'existing-img',
          filename: 'chart.png',
          usage: 1,
          createdAt: '2024-01-01T00:00:00.000Z',
          messageId: 'turn-1-image-msg',
        });
        const persisted = snapshotCommitCodeFileArgs();

        const imageBuffer = Buffer.alloc(500);
        mockAxios.mockResolvedValue({ data: imageBuffer });
        convertImage.mockResolvedValue({
          filepath: '/uploads/chart.webp',
          bytes: 400,
        });

        await processCodeOutput({
          ...baseParams,
          name: 'chart.png',
          messageId: 'turn-2-current-img-msg',
        });

        expect(persisted[0].messageId).toBe('turn-1-image-msg');
      });
    });

    describe('socket pool isolation', () => {
      it('should pass dedicated keepAlive:false agents to axios for processCodeOutput', async () => {
        const smallBuffer = Buffer.alloc(100);
        mockAxios.mockResolvedValue({ data: smallBuffer });

        await processCodeOutput(baseParams);

        const callConfig = mockAxios.mock.calls[0][0];
        expect(callConfig.httpAgent).toBe(codeServerHttpAgent);
        expect(callConfig.httpsAgent).toBe(codeServerHttpsAgent);
        expect(callConfig.httpAgent).toBeInstanceOf(http.Agent);
        expect(callConfig.httpsAgent).toBeInstanceOf(https.Agent);
        expect(callConfig.httpAgent.keepAlive).toBe(false);
        expect(callConfig.httpsAgent.keepAlive).toBe(false);
      });

      it('should pass dedicated keepAlive:false agents to axios for getSessionInfo', async () => {
        mockAxios.mockResolvedValue({
          data: [{ name: 'sess/fid', lastModified: new Date().toISOString() }],
        });

        await getSessionInfo({
          kind: 'user',
          id: 'user-1',
          storage_session_id: 'sess',
          file_id: 'fid',
        });

        const callConfig = mockAxios.mock.calls[0][0];
        expect(callConfig.httpAgent).toBe(codeServerHttpAgent);
        expect(callConfig.httpsAgent).toBe(codeServerHttpsAgent);
        expect(callConfig.httpAgent.keepAlive).toBe(false);
        expect(callConfig.httpsAgent.keepAlive).toBe(false);
      });

      it('forwards cancellation to the freshness request and preserves its error', async () => {
        const controller = new AbortController();
        const canceled = Object.assign(new Error('canceled'), {
          name: 'CanceledError',
          code: 'ERR_CANCELED',
        });
        mockAxios.mockImplementationOnce(async (config) => {
          expect(config.signal).toBe(controller.signal);
          controller.abort();
          throw canceled;
        });

        await expect(
          getSessionInfo(
            {
              kind: 'user',
              id: 'user-1',
              storage_session_id: 'sess',
              file_id: 'fid',
            },
            mockReq,
            {},
            controller.signal,
          ),
        ).rejects.toBe(canceled);
      });

      it('forwards Code API auth headers when checking session object freshness', async () => {
        getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer freshness-token' });
        mockAxios.mockResolvedValue({
          data: { lastModified: '2024-01-01T00:00:00Z' },
        });

        await getSessionInfo(
          {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'session-123',
            file_id: 'file-123',
          },
          mockReq,
        );

        expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(mockReq, undefined);
        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'get',
            headers: expect.objectContaining({
              Authorization: 'Bearer freshness-token',
              'User-Agent': 'LibreChat/1.0',
            }),
          }),
        );
      });

      it('checks freshness against the trusted stateful endpoint and profile', async () => {
        mockAxios.mockResolvedValue({
          data: { lastModified: '2026-08-15T00:00:00Z' },
        });

        await getSessionInfo(
          {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'session-123',
            file_id: 'file-123',
          },
          mockReq,
          {
            baseUrl: 'https://stateful-code.example.com',
            executionProfile: 'stateful',
          },
        );

        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            url: expect.stringMatching(/^https:\/\/stateful-code\.example\.com\/sessions\//),
            headers: expect.objectContaining({
              'X-CodeAPI-Expected-Profile': 'stateful',
            }),
          }),
        );
      });
    });

    describe('deferred-preview flow (office-bucket files)', () => {
      /* Office-bucket files (DOCX/XLSX/etc.) split into:
       *   the initial emit (await): persist `text: null, status: 'pending'`,
       *     return `{ file, finalize }` so the caller can ship the
       *     attachment to the client immediately;
       *   the deferred render (background): finalize() invokes the extractor and
       *     transitions the record to 'ready' (with text/textFormat) or
       *     'failed' (with previewError). The agent's final response
       *     never blocks on the deferred render.
       *
       * The `hasOfficeHtmlPath` mock is the gate. Other tests keep it
       * at `false` (legacy single-phase path); we flip it on here. */
      const { updateFile } = require('~/models');

      beforeEach(() => {
        mockHasOfficeHtmlPath.mockReturnValue(true);
        updateFile.mockResolvedValue({ file_id: 'mock-uuid-1234', status: 'ready' });
      });

      afterEach(() => {
        mockHasOfficeHtmlPath.mockReturnValue(false);
      });

      it('persists the initial emit with status:pending and text:null, deferring extraction', async () => {
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        determineFileType.mockResolvedValue({
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });

        const result = await processCodeOutput({ ...baseParams, name: 'data.xlsx' });

        expect(result.file).toMatchObject({
          file_id: 'mock-uuid-1234',
          filename: 'data.xlsx',
          status: 'pending',
          text: null,
          textFormat: null,
        });
        expect(typeof result.finalize).toBe('function');
        // Extractor MUST NOT have been called yet — that's deferred preview work.
        expect(mockExtractCodeArtifactText).not.toHaveBeenCalled();
        // Persisted record with the pending status.
        expect(mockCommitCodeFile).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'pending', text: null, textFormat: null }),
          undefined,
        );
      });

      it('finalize() runs the extractor, transitions to ready with text+textFormat on success', async () => {
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        determineFileType.mockResolvedValue({
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        mockExtractCodeArtifactText.mockResolvedValueOnce('<table><tr><td>1</td></tr></table>');
        mockGetExtractedTextFormat.mockReturnValueOnce('html');

        const { finalize } = await processCodeOutput({ ...baseParams, name: 'data.xlsx' });
        await finalize();

        expect(mockExtractCodeArtifactText).toHaveBeenCalledTimes(1);
        /* Update is conditional on `previewRevision` so an older render
         * can't overwrite a newer turn's record on cross-turn filename
         * reuse. The uuid mock returns the same value for every v4()
         * call, so file_id and previewRevision happen to coincide here
         * — what matters is the second arg carries the revision filter. */
        expect(updateFile).toHaveBeenCalledWith(
          {
            file_id: 'mock-uuid-1234',
            text: '<table><tr><td>1</td></tr></table>',
            textFormat: 'html',
            status: 'ready',
            previewError: null,
          },
          { previewRevision: 'mock-uuid-1234' },
        );
      });

      it('finalize() transitions to failed with previewError when extractor returns null (HTML-or-null contract)', async () => {
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        determineFileType.mockResolvedValue({
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        mockExtractCodeArtifactText.mockResolvedValueOnce(null);
        // Office bucket + null text → must be 'failed', NEVER raw text fallback
        // (PR #12934 SEC fix: prevents <script> in cell text from rendering as HTML).
        mockHasOfficeHtmlPath.mockReturnValue(true);

        const { finalize } = await processCodeOutput({ ...baseParams, name: 'data.xlsx' });
        await finalize();

        expect(updateFile).toHaveBeenCalledWith(
          expect.objectContaining({
            file_id: 'mock-uuid-1234',
            text: null,
            status: 'failed',
            previewError: 'parser-error',
          }),
          { previewRevision: 'mock-uuid-1234' },
        );
      });

      it('finalize() transitions to failed with previewError:timeout when the outer timeout rejects', async () => {
        /* The passthrough `withTimeout` mock at the file scope returns
         * its inner promise unchanged, so the only way the catch branch
         * fires here is if the extractor itself throws. The real
         * production path: `extractCodeArtifactText` swallows its own
         * errors and returns null, so any throw reaching `finalizePreview`
         * came from the outer `withTimeout` rejection. Simulate it by
         * having the extractor throw with the same shape. */
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        determineFileType.mockResolvedValue({
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        mockExtractCodeArtifactText.mockImplementationOnce(async () => {
          throw new Error('Preview extraction exceeded 60000ms');
        });

        const { finalize } = await processCodeOutput({ ...baseParams, name: 'data.xlsx' });
        await finalize();

        expect(updateFile).toHaveBeenCalledWith(
          expect.objectContaining({
            file_id: 'mock-uuid-1234',
            status: 'failed',
            previewError: 'timeout',
          }),
          { previewRevision: 'mock-uuid-1234' },
        );
      });

      it('survives a failing updateFile in finalize() without throwing', async () => {
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        determineFileType.mockResolvedValue({
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        mockExtractCodeArtifactText.mockResolvedValueOnce('<table></table>');
        mockGetExtractedTextFormat.mockReturnValueOnce('html');
        updateFile.mockRejectedValueOnce(new Error('mongo down'));

        const { finalize } = await processCodeOutput({ ...baseParams, name: 'data.xlsx' });
        await expect(finalize()).resolves.toBeNull();
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining('failed to persist preview result'),
        );
      });
    });

    describe('legacy single-phase flow (non-office files)', () => {
      /* Lock in that non-office files (txt/json/pdf/binary) keep the
       * inline extract+create flow with NO finalize key — the caller
       * gets a fully-resolved record, no background work to run. */
      it('returns no finalize key for plain text', async () => {
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        const result = await processCodeOutput({ ...baseParams, name: 'note.txt' });
        expect(result.finalize).toBeUndefined();
        expect(result.file).toMatchObject({ filename: 'note.txt' });
      });

      it('returns no finalize key for the size-limit fallback', async () => {
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100 * 1024 * 1024) });
        const result = await processCodeOutput(baseParams);
        expect(result.finalize).toBeUndefined();
        expect(result.file.filepath).toContain('/api/files/code/download/');
      });

      it('returns no finalize key for the saveBuffer-unavailable fallback', async () => {
        getStrategyFunctions.mockReturnValueOnce({});
        mockAxios.mockResolvedValue({ data: Buffer.alloc(100) });
        const result = await processCodeOutput(baseParams);
        expect(result.finalize).toBeUndefined();
        expect(result.file.filepath).toContain('/api/files/code/download/');
      });

      it('returns no finalize key for the axios-error fallback', async () => {
        mockAxios.mockRejectedValue(new Error('network'));
        const result = await processCodeOutput(baseParams);
        expect(result.finalize).toBeUndefined();
        expect(result.file.filepath).toContain('/api/files/code/download/');
      });
    });
  });

  describe('runPreviewFinalize', () => {
    /* The runtime pairing for `processCodeOutput`'s `finalize` thunk.
     * `finalizePreview` is designed to never throw (translates errors
     * to `status: 'failed'` internally). The helper's catch is the
     * safety net for unexpected programming errors that would
     * otherwise leave the DB record stuck at `status: 'pending'`
     * forever — we attempt a best-effort `updateFile` to mark it
     * `'failed'` with `previewError: 'unexpected'` so the UI stops
     * polling and the next-turn LLM context surfaces the failure.
     * (Codex audit on PR #12957 Finding 4.) */
    const { runPreviewFinalize } = require('./process');
    const { updateFile } = require('~/models');

    beforeEach(() => {
      updateFile.mockReset();
      updateFile.mockResolvedValue({});
    });

    it('is a no-op when finalize is undefined (non-office files)', () => {
      expect(() =>
        runPreviewFinalize({ finalize: undefined, fileId: 'fid-1', onResolved: jest.fn() }),
      ).not.toThrow();
      expect(updateFile).not.toHaveBeenCalled();
    });

    it('calls onResolved with the resolved record on success', async () => {
      const onResolved = jest.fn();
      const finalize = jest
        .fn()
        .mockResolvedValue({ file_id: 'fid-1', status: 'ready', text: '<x/>' });
      runPreviewFinalize({ finalize, fileId: 'fid-1', onResolved });
      await new Promise((resolve) => setImmediate(resolve));
      expect(onResolved).toHaveBeenCalledWith(
        expect.objectContaining({ file_id: 'fid-1', status: 'ready' }),
      );
      expect(updateFile).not.toHaveBeenCalled();
    });

    it('skips onResolved when finalize resolves to null (DB write failed inside finalizePreview)', async () => {
      const onResolved = jest.fn();
      const finalize = jest.fn().mockResolvedValue(null);
      runPreviewFinalize({ finalize, fileId: 'fid-1', onResolved });
      await new Promise((resolve) => setImmediate(resolve));
      expect(onResolved).not.toHaveBeenCalled();
    });

    it('marks the record as failed (previewError: "unexpected") when finalize throws', async () => {
      const onResolved = jest.fn();
      const finalize = jest.fn().mockRejectedValue(new Error('unexpected ref error'));
      runPreviewFinalize({
        finalize,
        fileId: 'fid-boom',
        previewRevision: 'rev-A',
        onResolved,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(onResolved).not.toHaveBeenCalled();
      /* Defensive update is conditional on the same `previewRevision`
       * the deferred render started with — a newer turn that has
       * since rotated the revision is left untouched. */
      expect(updateFile).toHaveBeenCalledWith(
        {
          file_id: 'fid-boom',
          status: 'failed',
          previewError: 'unexpected',
        },
        { previewRevision: 'rev-A' },
      );
      expect(logger.error).toHaveBeenCalledWith(
        'Error rendering deferred preview:',
        expect.any(Error),
      );
    });

    it('logs but does not throw when the defensive updateFile itself fails', async () => {
      const onResolved = jest.fn();
      const finalize = jest.fn().mockRejectedValue(new Error('original error'));
      updateFile.mockRejectedValueOnce(new Error('mongo down'));
      runPreviewFinalize({ finalize, fileId: 'fid-doublefail', onResolved });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(onResolved).not.toHaveBeenCalled();
      // Two logger.error calls: one for the original throw, one for the failed mark.
      expect(logger.error.mock.calls.some((c) => /also failed to mark/.test(c[0]))).toBe(true);
    });

    it('does not attempt the defensive updateFile when fileId is missing', async () => {
      const finalize = jest.fn().mockRejectedValue(new Error('boom'));
      runPreviewFinalize({ finalize, fileId: undefined });
      await new Promise((resolve) => setImmediate(resolve));
      expect(updateFile).not.toHaveBeenCalled();
    });

    it('skips onResolved gracefully when caller omits it (e.g., tools.js direct endpoint)', async () => {
      const finalize = jest.fn().mockResolvedValue({ file_id: 'fid-1', status: 'ready' });
      // No onResolved — non-streaming caller.
      expect(() => runPreviewFinalize({ finalize, fileId: 'fid-1' })).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(updateFile).not.toHaveBeenCalled();
    });

    it('does NOT downgrade the file to failed when finalize succeeds but onResolved throws', async () => {
      /* Regression for the codex P2 finding: the original chain put the
       * `.catch` after `.then(onResolved)`, so a throw inside
       * `onResolved` (transport-side: SSE write race after stream
       * close, an emitter listener throwing) propagated into the
       * finalize catch and persisted `status: 'failed'` /
       * `previewError: 'unexpected'` — even though extraction
       * succeeded and the file was already on disk and marked ready.
       * That surfaced "preview unavailable" in the UI for a perfectly
       * valid file, and degraded next-turn LLM context. The fix wraps
       * `onResolved` in its own try/catch so emit errors stay isolated
       * from finalize errors. */
      const onResolved = jest.fn(() => {
        throw new Error('SSE write after stream closed');
      });
      const finalize = jest.fn().mockResolvedValue({
        file_id: 'fid-emit-throw',
        status: 'ready',
        text: '<table>x</table>',
      });
      runPreviewFinalize({
        finalize,
        fileId: 'fid-emit-throw',
        previewRevision: 'rev-A',
        onResolved,
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(onResolved).toHaveBeenCalledTimes(1);
      /* The defensive "mark failed" path MUST NOT fire — the file is
       * resolved and on disk; only the SSE emit failed. */
      expect(updateFile).not.toHaveBeenCalled();
      /* Emit error is logged so the failure is observable in the
       * server log without affecting UX. */
      expect(
        logger.error.mock.calls.some((c) => /onResolved threw for fid-emit-throw/.test(c[0])),
      ).toBe(true);
    });
  });

  describe('readWorkspaceFile', () => {
    it('forwards authenticated reads to the selected attached worker', async () => {
      const controller = new AbortController();
      const result = {
        protocolVersion: 1,
        operation: 'read_file',
        workspaceId: 'primary',
        path: 'src/app.ts',
        content: 'const ready = true;',
        startLine: 1,
        endLine: 1,
        truncated: false,
      };
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer workspace-token' });
      mockExecuteWorkspaceTool.mockResolvedValueOnce(result);

      await expect(
        readWorkspaceFile({
          file_path: 'src/app.ts',
          workspace_id: 'primary',
          workspace_instance_id: 'a'.repeat(64),
          start_line: 1,
          max_lines: 200,
          codeApiBaseUrl: 'https://attached-code.example.com/v1',
          executionProfile: 'stateful',
          bridgeWorkerId: 'worker-user-1',
          req: mockReq,
          signal: controller.signal,
          maxQueueWaitMs: 0,
        }),
      ).resolves.toBe(result);

      expect(getCodeApiAuthHeaders).not.toHaveBeenCalled();
      const { authHeaders } = mockExecuteWorkspaceTool.mock.calls[0][0];
      await expect(authHeaders()).resolves.toEqual({
        Authorization: 'Bearer workspace-token',
        'X-CodeAPI-Expected-Profile': 'stateful',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer refreshed-token' });
      await expect(authHeaders()).resolves.toMatchObject({
        Authorization: 'Bearer refreshed-token',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      expect(getCodeApiAuthHeaders).toHaveBeenNthCalledWith(2, mockReq, 'worker-user-1');
      expect(mockExecuteWorkspaceTool).toHaveBeenCalledWith({
        baseURL: 'https://attached-code.example.com/v1',
        authHeaders: expect.any(Function),
        maxQueueWaitMs: 0,
        request: {
          protocolVersion: 1,
          operation: 'read_file',
          workspaceId: 'primary',
          workspaceInstanceId: 'a'.repeat(64),
          path: 'src/app.ts',
          startLine: 1,
          maxLines: 200,
        },
        signal: controller.signal,
      });
    });
  });

  describe('searchWorkspace', () => {
    it('forwards authenticated literal search to the selected attached worker', async () => {
      const controller = new AbortController();
      const result = {
        protocolVersion: 1,
        operation: 'search_text',
        workspaceId: 'primary',
        matches: [],
        truncated: false,
      };
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer workspace-token' });
      mockExecuteWorkspaceTool.mockResolvedValueOnce(result);

      await expect(
        searchWorkspace({
          query: 'needle',
          workspace_id: 'primary',
          path: 'src',
          max_results: 20,
          codeApiBaseUrl: 'https://attached-code.example.com/v1',
          executionProfile: 'stateful',
          bridgeWorkerId: 'worker-user-1',
          req: mockReq,
          signal: controller.signal,
          maxQueueWaitMs: 0,
        }),
      ).resolves.toBe(result);

      expect(getCodeApiAuthHeaders).not.toHaveBeenCalled();
      const { authHeaders } = mockExecuteWorkspaceTool.mock.calls[0][0];
      await expect(authHeaders()).resolves.toEqual({
        Authorization: 'Bearer workspace-token',
        'X-CodeAPI-Expected-Profile': 'stateful',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer refreshed-token' });
      await expect(authHeaders()).resolves.toMatchObject({
        Authorization: 'Bearer refreshed-token',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      expect(getCodeApiAuthHeaders).toHaveBeenNthCalledWith(2, mockReq, 'worker-user-1');
      expect(mockExecuteWorkspaceTool).toHaveBeenCalledWith({
        baseURL: 'https://attached-code.example.com/v1',
        authHeaders: expect.any(Function),
        maxQueueWaitMs: 0,
        request: {
          protocolVersion: 1,
          operation: 'search_text',
          workspaceId: 'primary',
          query: 'needle',
          path: 'src',
          maxResults: 20,
        },
        signal: controller.signal,
      });
    });
  });

  describe('listWorkspaceFiles', () => {
    it('forwards authenticated listing to the selected attached worker', async () => {
      const controller = new AbortController();
      const result = {
        protocolVersion: 1,
        operation: 'list_files',
        workspaceId: 'primary',
        paths: ['src/app.ts'],
        truncated: false,
      };
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer workspace-token' });
      mockExecuteWorkspaceTool.mockResolvedValueOnce(result);

      await expect(
        listWorkspaceFiles({
          workspace_id: 'primary',
          path: 'src',
          after_path: 'src/app.ts',
          max_results: 20,
          codeApiBaseUrl: 'https://attached-code.example.com/v1',
          executionProfile: 'stateful',
          bridgeWorkerId: 'worker-user-1',
          req: mockReq,
          signal: controller.signal,
          maxQueueWaitMs: 0,
        }),
      ).resolves.toBe(result);

      expect(getCodeApiAuthHeaders).not.toHaveBeenCalled();
      const { authHeaders } = mockExecuteWorkspaceTool.mock.calls[0][0];
      await expect(authHeaders()).resolves.toEqual({
        Authorization: 'Bearer workspace-token',
        'X-CodeAPI-Expected-Profile': 'stateful',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer refreshed-token' });
      await expect(authHeaders()).resolves.toMatchObject({
        Authorization: 'Bearer refreshed-token',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      expect(getCodeApiAuthHeaders).toHaveBeenNthCalledWith(2, mockReq, 'worker-user-1');
      expect(mockExecuteWorkspaceTool).toHaveBeenCalledWith({
        baseURL: 'https://attached-code.example.com/v1',
        authHeaders: expect.any(Function),
        maxQueueWaitMs: 0,
        request: {
          protocolVersion: 1,
          operation: 'list_files',
          workspaceId: 'primary',
          path: 'src',
          afterPath: 'src/app.ts',
          maxResults: 20,
        },
        signal: controller.signal,
      });
    });
  });

  describe('workspace mutations', () => {
    it('forwards create-only writes to the selected attached worker', async () => {
      const controller = new AbortController();
      const result = {
        protocolVersion: 1,
        operation: 'write_file',
        workspaceId: 'primary',
        path: 'src/new.ts',
        created: true,
        bytesWritten: 5,
      };
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer workspace-token' });
      mockExecuteWorkspaceTool.mockResolvedValueOnce(result);

      await expect(
        writeWorkspaceFile({
          file_path: 'src/new.ts',
          content: 'ready',
          overwrite: false,
          workspace_id: 'primary',
          workspace_instance_id: 'b'.repeat(64),
          codeApiBaseUrl: 'https://attached-code.example.com/v1',
          executionProfile: 'stateful',
          bridgeWorkerId: 'worker-user-1',
          req: mockReq,
          signal: controller.signal,
          maxQueueWaitMs: 0,
        }),
      ).resolves.toBe(result);

      expect(getCodeApiAuthHeaders).not.toHaveBeenCalled();
      const { authHeaders } = mockExecuteWorkspaceTool.mock.calls[0][0];
      await expect(authHeaders()).resolves.toEqual({
        Authorization: 'Bearer workspace-token',
        'X-CodeAPI-Expected-Profile': 'stateful',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer refreshed-token' });
      await expect(authHeaders()).resolves.toMatchObject({
        Authorization: 'Bearer refreshed-token',
        'X-LibreChat-Code-Worker-ID': 'worker-user-1',
      });
      expect(getCodeApiAuthHeaders).toHaveBeenNthCalledWith(2, mockReq, 'worker-user-1');
      expect(mockExecuteWorkspaceTool).toHaveBeenCalledWith({
        baseURL: 'https://attached-code.example.com/v1',
        authHeaders: expect.any(Function),
        maxQueueWaitMs: 0,
        request: {
          protocolVersion: 1,
          operation: 'write_file',
          workspaceId: 'primary',
          workspaceInstanceId: 'b'.repeat(64),
          path: 'src/new.ts',
          content: 'ready',
          overwrite: false,
        },
        signal: controller.signal,
      });
    });

    it('forwards an edit batch as one attached-worker request', async () => {
      const result = {
        protocolVersion: 1,
        operation: 'edit_file',
        workspaceId: 'primary',
        path: 'src/app.ts',
        replacements: 2,
        bytesWritten: 20,
      };
      getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer workspace-token' });
      mockExecuteWorkspaceTool.mockResolvedValueOnce(result);

      await expect(
        editWorkspaceFile({
          file_path: 'src/app.ts',
          edits: [
            { oldText: 'draft', newText: 'ready' },
            { oldText: 'false', newText: 'true' },
          ],
          workspace_id: 'primary',
          codeApiBaseUrl: 'https://attached-code.example.com/v1',
          executionProfile: 'stateful',
          bridgeWorkerId: 'worker-user-1',
          req: mockReq,
          expected_base_sha256: 'a'.repeat(64),
        }),
      ).resolves.toBe(result);

      expect(mockExecuteWorkspaceTool).toHaveBeenCalledWith(
        expect.objectContaining({
          request: {
            protocolVersion: 1,
            operation: 'edit_file',
            workspaceId: 'primary',
            path: 'src/app.ts',
            edits: [
              { oldText: 'draft', newText: 'ready' },
              { oldText: 'false', newText: 'true' },
            ],
            expectedBaseSha256: 'a'.repeat(64),
          },
        }),
      );
    });

    it('forwards a non-mutating attached-workspace edit preview', async () => {
      const result = {
        protocolVersion: 1,
        operation: 'preview_edit',
        workspaceId: 'primary',
        path: 'src/app.ts',
        content: 'prefix SECRET',
        hasUtf8Bom: false,
        baseSha256: 'b'.repeat(64),
        replacements: 1,
        bytesWritten: 13,
      };
      mockExecuteWorkspaceTool.mockResolvedValueOnce(result);

      await expect(
        previewWorkspaceEdit({
          file_path: 'src/app.ts',
          edits: [{ oldText: ' SEC', newText: ' SECRET' }],
          workspace_id: 'primary',
          codeApiBaseUrl: 'https://attached-code.example.com/v1',
          executionProfile: 'stateful',
          req: mockReq,
        }),
      ).resolves.toBe(result);

      expect(mockExecuteWorkspaceTool).toHaveBeenCalledWith(
        expect.objectContaining({
          request: {
            protocolVersion: 1,
            operation: 'preview_edit',
            workspaceId: 'primary',
            path: 'src/app.ts',
            edits: [{ oldText: ' SEC', newText: ' SECRET' }],
          },
        }),
      );
    });
  });

  describe('readSandboxFile', () => {
    /**
     * `readSandboxFile` shells `cat <file_path>` through the sandbox
     * `/exec` endpoint. The `file_path` argument is model-controlled, so
     * the single-quote escaping is a security boundary — a regression
     * here would let a malicious filename break out of the `cat`
     * argument and inject arbitrary shell. Lock the contract in tests.
     */

    /** Pull the bash code that the helper would send to /exec, given
     *  the file_path that the model supplied. */
    function execCodeFor(file_path) {
      mockAxios.mockResolvedValueOnce({ data: { stdout: '', stderr: '' } });
      return readSandboxFile({ file_path }).then(() => {
        const postData = mockAxios.mock.calls[0][0].data;
        return postData.code;
      });
    }

    describe('shell quoting (security boundary)', () => {
      it('wraps a plain filename in single quotes', async () => {
        const code = await execCodeFor('/mnt/data/sentinel.txt');
        expect(code).toBe(`cat '/mnt/data/sentinel.txt'`);
      });

      it("escapes a literal single-quote in the filename via the standard '\\'' sequence", async () => {
        // Adversarial filename: `quote'breakout.txt`. Naive
        // single-quoting would terminate the quoted string and
        // inject the trailing `breakout.txt'` as shell tokens.
        const code = await execCodeFor(`/mnt/data/quote'breakout.txt`);
        // Expected escape: end the string, escape a literal quote,
        // start a new string. POSIX-portable.
        expect(code).toBe(`cat '/mnt/data/quote'\\''breakout.txt'`);
      });

      it('does not interpret command substitution syntax inside the quoted argument', async () => {
        // `$(rm -rf /)` would expand if the path were unquoted or
        // double-quoted. Inside POSIX single-quotes it stays literal.
        const code = await execCodeFor('/mnt/data/$(rm -rf /).txt');
        expect(code).toBe(`cat '/mnt/data/$(rm -rf /).txt'`);
      });

      it('does not expand backtick command substitution inside the quoted argument', async () => {
        const code = await execCodeFor('/mnt/data/`whoami`.txt');
        expect(code).toBe(`cat '/mnt/data/\`whoami\`.txt'`);
      });

      it('keeps newlines literal inside the quoted argument', async () => {
        const code = await execCodeFor('/mnt/data/line1\nline2.txt');
        expect(code).toBe(`cat '/mnt/data/line1\nline2.txt'`);
      });

      it('keeps spaces and other shell metacharacters literal', async () => {
        const code = await execCodeFor('/mnt/data/file ; ls -la /etc/passwd');
        expect(code).toBe(`cat '/mnt/data/file ; ls -la /etc/passwd'`);
      });

      it('handles multiple consecutive single-quotes', async () => {
        const code = await execCodeFor(`a''b`);
        // Each `'` becomes the 4-char escape sequence.
        expect(code).toBe(`cat 'a'\\'''\\''b'`);
      });
    });

    describe('payload shape', () => {
      it('POSTs to /exec on the configured codeapi base URL with bash language', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: 'ok', stderr: '' } });

        await readSandboxFile({ file_path: '/mnt/data/x.txt' });

        const call = mockAxios.mock.calls[0][0];
        expect(call.method).toBe('post');
        expect(call.url).toBe('https://code-api.example.com/exec');
        expect(call.data.lang).toBe('bash');
      });

      it('routes to the selected profile endpoint and asserts the expected profile', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: 'ok', stderr: '' } });

        await readSandboxFile({
          file_path: '/mnt/data/x.txt',
          codeApiBaseUrl: 'https://stateful-code.example.com',
          executionProfile: 'stateful',
          bridgeWorkerId: 'personal-worker-1',
          runtime_session_hint: 'v1:user',
        });

        const call = mockAxios.mock.calls[0][0];
        expect(call.url).toBe('https://stateful-code.example.com/exec');
        expect(call.headers['X-CodeAPI-Expected-Profile']).toBe('stateful');
        expect(call.headers['X-LibreChat-Code-Worker-ID']).toBe('personal-worker-1');
        expect(call.data.runtime_session_hint).toBe('v1:user');
      });

      it('omits session_id and files when not provided', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: '', stderr: '' } });

        await readSandboxFile({ file_path: '/mnt/data/x.txt' });

        const data = mockAxios.mock.calls[0][0].data;
        expect(data).not.toHaveProperty('session_id');
        expect(data).not.toHaveProperty('files');
      });

      it('forwards session_id when provided so the read lands in the seeded sandbox', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: '', stderr: '' } });

        await readSandboxFile({
          file_path: '/mnt/data/x.txt',
          session_id: 'sess-XYZ',
        });

        expect(mockAxios.mock.calls[0][0].data.session_id).toBe('sess-XYZ');
      });

      it('forwards files (non-empty array) so prior-turn artifacts are mounted', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: '', stderr: '' } });

        const files = [{ id: 'f1', name: 'sentinel.txt', session_id: 'sess-XYZ' }];
        await readSandboxFile({
          file_path: '/mnt/data/sentinel.txt',
          session_id: 'sess-XYZ',
          files,
        });

        expect(mockAxios.mock.calls[0][0].data.files).toEqual(files);
      });

      it('omits files when an empty array is provided (cleaner payload)', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: '', stderr: '' } });

        await readSandboxFile({
          file_path: '/mnt/data/x.txt',
          session_id: 'sess-XYZ',
          files: [],
        });

        expect(mockAxios.mock.calls[0][0].data).not.toHaveProperty('files');
      });

      it('uses dedicated keepAlive:false agents (matches processCodeOutput pool isolation)', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: '', stderr: '' } });

        await readSandboxFile({ file_path: '/mnt/data/x.txt' });

        const call = mockAxios.mock.calls[0][0];
        expect(call.httpAgent).toBe(codeServerHttpAgent);
        expect(call.httpsAgent).toBe(codeServerHttpsAgent);
      });

      it('forwards Code API auth headers when reading from the sandbox', async () => {
        getCodeApiAuthHeaders.mockResolvedValueOnce({ Authorization: 'Bearer sandbox-token' });
        mockAxios.mockResolvedValueOnce({ data: { stdout: 'x', stderr: '' } });

        await readSandboxFile({ file_path: '/mnt/data/x.txt', req: mockReq });

        expect(getCodeApiAuthHeaders).toHaveBeenCalledWith(mockReq, undefined);
        expect(mockAxios).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'post',
            headers: expect.objectContaining({
              Authorization: 'Bearer sandbox-token',
              'User-Agent': 'LibreChat/1.0',
            }),
          }),
        );
      });
    });

    describe('response handling', () => {
      it('returns { content: stdout } on success', async () => {
        mockAxios.mockResolvedValueOnce({
          data: { stdout: 'sentinel-XYZ-1234\n', stderr: '' },
        });

        const result = await readSandboxFile({ file_path: '/mnt/data/sentinel.txt' });

        expect(result).toEqual({ content: 'sentinel-XYZ-1234\n' });
      });

      it('returns null when getCodeBaseURL is not configured', async () => {
        const { getCodeBaseURL } = require('@librechat/agents');
        getCodeBaseURL.mockReturnValueOnce('');

        const result = await readSandboxFile({ file_path: '/mnt/data/x.txt' });

        expect(result).toBeNull();
        expect(mockAxios).not.toHaveBeenCalled();
      });

      it('returns null when stdout is missing entirely (no content to surface)', async () => {
        // stdout absent + no stderr = nothing to report; caller turns this
        // into a model-visible "Failed to read" message.
        mockAxios.mockResolvedValueOnce({ data: { stderr: '' } });

        const result = await readSandboxFile({ file_path: '/mnt/data/x.txt' });

        expect(result).toBeNull();
      });

      it('throws when the command writes to stderr with no stdout (exposes the error to the caller)', async () => {
        mockAxios.mockResolvedValueOnce({
          data: { stdout: '', stderr: 'cat: /mnt/data/missing.txt: No such file or directory\n' },
        });

        await expect(readSandboxFile({ file_path: '/mnt/data/missing.txt' })).rejects.toThrow(
          'cat: /mnt/data/missing.txt: No such file or directory',
        );
      });

      it('returns stdout even when stderr is also present (stdout wins on partial-success)', async () => {
        // Some `cat` builds emit warnings on stderr while still producing
        // stdout (e.g. unusual line endings). Surface the content.
        mockAxios.mockResolvedValueOnce({
          data: { stdout: 'partial', stderr: 'warning: ...' },
        });

        const result = await readSandboxFile({ file_path: '/mnt/data/x.txt' });

        expect(result).toEqual({ content: 'partial' });
      });

      it('rethrows axios transport errors after logging via logAxiosError', async () => {
        const { logAxiosError } = require('@librechat/api');
        const transportError = Object.assign(new Error('connect ECONNREFUSED'), {
          code: 'ECONNREFUSED',
        });
        mockAxios.mockRejectedValueOnce(transportError);

        await expect(readSandboxFile({ file_path: '/mnt/data/x.txt' })).rejects.toBe(
          transportError,
        );
        expect(logAxiosError).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining('/mnt/data/x.txt'),
            error: transportError,
          }),
        );
      });

      /* `create_file` reads its target before writing so it can tell a create
       * from an overwrite, so an absent path is the ordinary case. Reported at
       * error level it made every file creation look like a lost file — and
       * `logAxiosError` rendered the sandbox's own stderr as "An error occurred
       * while setting up the request", which reads as a transport fault. */
      it('logs an absent path at debug, not through the error-level axios logger', async () => {
        const { logAxiosError } = require('@librechat/api');
        mockAxios.mockResolvedValueOnce({
          data: { stdout: '', stderr: 'cat: /mnt/data/SKILL.md: No such file or directory\n' },
        });

        await expect(readSandboxFile({ file_path: '/mnt/data/SKILL.md' })).rejects.toThrow(
          'No such file or directory',
        );

        expect(logAxiosError).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('/mnt/data/SKILL.md'));
      });

      it('still reports a non-missing sandbox read failure at error level', async () => {
        const { logAxiosError } = require('@librechat/api');
        mockAxios.mockResolvedValueOnce({
          data: { stdout: '', stderr: 'cat: /mnt/data/x.txt: Permission denied\n' },
        });

        await expect(readSandboxFile({ file_path: '/mnt/data/x.txt' })).rejects.toThrow(
          'Permission denied',
        );

        expect(logger.debug).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
        /* The sandbox answered; nothing about the request failed, so the
         * axios-shaped logger would misattribute this to the transport. */
        expect(logAxiosError).not.toHaveBeenCalled();
      });
    });

    describe('timeout', () => {
      it('uses the same 15s timeout as processCodeOutput (consistent code-server SLA)', async () => {
        mockAxios.mockResolvedValueOnce({ data: { stdout: '', stderr: '' } });

        await readSandboxFile({ file_path: '/mnt/data/x.txt' });

        expect(mockAxios.mock.calls[0][0].timeout).toBe(15000);
      });
    });
  });

  describe('writeSandboxFile', () => {
    function extractWritePayload() {
      const code = mockAxios.mock.calls[0][0].data.code;
      const match = /payload = "([^"]+)"/.exec(code);
      expect(match).not.toBeNull();
      const payload = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      return {
        file_path: payload.file_path,
        content: Buffer.from(payload.content_b64, 'base64').toString('utf8'),
        code,
      };
    }

    it('POSTs a bash python writer to /exec and forwards session context', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          stdout: 'WROTE 11 bytes to /mnt/data/new.txt\n',
          stderr: '',
          session_id: 'sess-new',
          files: [{ id: 'file-new', name: 'new.txt', storage_session_id: 'sess-new' }],
        },
      });
      const files = [{ id: 'f1', name: 'input.csv', session_id: 'sess-prev' }];

      const result = await writeSandboxFile({
        file_path: '/mnt/data/new.txt',
        content: 'hello world',
        session_id: 'sess-prev',
        files,
        req: mockReq,
      });

      const call = mockAxios.mock.calls[0][0];
      expect(call.method).toBe('post');
      expect(call.url).toBe('https://code-api.example.com/exec');
      expect(call.data.lang).toBe('bash');
      expect(call.data.session_id).toBe('sess-prev');
      expect(call.data.files).toEqual(files);
      expect(call.timeout).toBe(15000);
      expect(call.httpAgent).toBe(codeServerHttpAgent);
      expect(call.httpsAgent).toBe(codeServerHttpsAgent);
      expect(result).toMatchObject({
        stdout: 'WROTE 11 bytes to /mnt/data/new.txt\n',
        session_id: 'sess-new',
        files: [{ id: 'file-new', name: 'new.txt' }],
      });
    });

    it('forwards only a valid bounded artifact delivery failure', async () => {
      mockAxios.mockResolvedValueOnce({
        data: {
          stdout: 'WROTE 1 bytes to /mnt/data/new.txt\n',
          session_id: 'sess-new',
          files: [],
          artifact_delivery: {
            code: 'artifact_delivery_failed',
            status: 'failed',
            attempted: 1,
            delivered: 0,
            failed: 1,
            detail: 'private object storage failure',
          },
        },
      });

      const result = await writeSandboxFile({
        file_path: '/mnt/data/new.txt',
        content: 'x',
      });

      expect(result.artifact_delivery).toEqual({
        code: 'artifact_delivery_failed',
        status: 'failed',
        attempted: 1,
        delivered: 0,
        failed: 1,
      });
      expect(JSON.stringify(result)).not.toContain('private object storage failure');
    });

    it('encodes path and content in a base64 JSON payload instead of shell-interpolating them', async () => {
      mockAxios.mockResolvedValueOnce({ data: { stdout: 'ok', stderr: '', session_id: 'sess' } });
      const trickyPath = `/mnt/data/quote'$(whoami).txt`;
      const trickyContent = "hello ' $(rm -rf /)\nsecond line";

      await writeSandboxFile({
        file_path: trickyPath,
        content: trickyContent,
      });

      const { file_path, content, code } = extractWritePayload();
      expect(file_path).toBe(trickyPath);
      expect(content).toBe(trickyContent);
      expect(code).not.toContain(trickyPath);
      expect(code).not.toContain(trickyContent);
    });

    it('returns null when getCodeBaseURL is not configured', async () => {
      const { getCodeBaseURL } = require('@librechat/agents');
      getCodeBaseURL.mockReturnValueOnce('');

      const result = await writeSandboxFile({
        file_path: '/mnt/data/x.txt',
        content: 'x',
      });

      expect(result).toBeNull();
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('throws when the writer reports stderr without stdout', async () => {
      mockAxios.mockResolvedValueOnce({
        data: { stdout: '', stderr: 'Permission denied\n' },
      });

      await expect(writeSandboxFile({ file_path: '/root/nope.txt', content: 'x' })).rejects.toThrow(
        'Permission denied',
      );
    });
  });

  describe('primeFiles reupload pushes FRESH sandbox ids (Pass-N review P2)', () => {
    /**
     * Regression: when a primed code file is missing/expired in the
     * sandbox (`getSessionInfo` returns null), `primeFiles` re-uploads
     * the file via `handleFileUpload` and persists the new
     * `fileIdentifier`. Before the fix, the in-memory `files[]` array
     * (now consumed by `buildInitialToolSessions` to seed
     * `Graph.sessions`) still received the STALE `(session_id, id)`
     * parsed from the original `fileIdentifier` at the top of the
     * loop. The DB record was correct but the seed referenced a
     * sandbox object that no longer existed — the first tool call
     * 404'd trying to mount it until the next turn re-read metadata.
     *
     * Fix: parse the FRESH `fileIdentifier` returned by upload and
     * push those ids into both the dedupe Map and the seed list.
     */

    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { updateFile, getFiles } = require('~/models');
    const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');

    /**
     * Mock the full strategy pair. `primeFiles` calls
     * `getStrategyFunctions(file.source)` for the download stream and
     * `getStrategyFunctions(FileSources.execute_code)` for the code-env
     * upload — both go through the same factory in production.
     */
    function setupReuploadMocks(newRef) {
      const handleFileUpload = jest.fn().mockResolvedValue(newRef);
      const getDownloadStream = jest.fn().mockResolvedValue('mock-stream');
      getStrategyFunctions.mockImplementation((source) => {
        if (source === 'execute_code') return { handleFileUpload };
        return { getDownloadStream };
      });
      updateFile.mockResolvedValue({});
      filterFilesByAgentAccess.mockImplementation(({ files }) => Promise.resolve(files));
      // getSessionInfo is mocked at module level via mockAxios; return null
      // to force the reupload path. Each `getSessionInfo` call hits axios.
      mockAxios.mockResolvedValue({ data: null });
      return { handleFileUpload, getDownloadStream };
    }

    it('recovers a throttled stale-file reupload with a fresh stream', async () => {
      const controller = new AbortController();
      const dbFile = {
        file_id: 'rate-limited-file',
        filename: 'report.csv',
        filepath: '/uploads/report.csv',
        source: 'local',
        context: 'execute_code',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'OLD_SESSION',
            file_id: 'OLD_ID',
          },
        },
      };
      const rateLimit = Object.assign(new Error('Request failed with status code 429'), {
        isAxiosError: true,
        response: { status: 429, headers: { 'retry-after': '0' } },
      });
      const handleFileUpload = jest
        .fn()
        .mockRejectedValueOnce(rateLimit)
        .mockResolvedValueOnce({ storage_session_id: 'NEW_SESSION', file_id: 'NEW_ID' });
      const getDownloadStream = jest
        .fn()
        .mockResolvedValueOnce('first-stream')
        .mockResolvedValueOnce('second-stream');
      getStrategyFunctions.mockImplementation((source) =>
        source === 'execute_code' ? { handleFileUpload } : { getDownloadStream },
      );
      getFiles.mockResolvedValue([dbFile]);
      filterFilesByAgentAccess.mockImplementation(({ files }) => Promise.resolve(files));
      mockAxios.mockResolvedValue({ data: null });
      updateFile.mockResolvedValue({});

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: [dbFile.file_id], files: [] } },
        agentId: 'agent-id',
        signal: controller.signal,
      });

      const { withCodeApiUploadRecovery } = require('@librechat/api');
      expect(withCodeApiUploadRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(handleFileUpload).toHaveBeenCalledTimes(2);
      expect(handleFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(getDownloadStream).toHaveBeenCalledTimes(2);
      expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), '/uploads/report.csv', {
        signal: controller.signal,
      });
      expect(handleFileUpload.mock.calls.map(([args]) => args.stream)).toEqual([
        'first-stream',
        'second-stream',
      ]);
      expect(result.files).toEqual([
        expect.objectContaining({ id: 'NEW_ID', storage_session_id: 'NEW_SESSION' }),
      ]);
    });

    it('propagates cancellation from a stale-file reupload', async () => {
      const controller = new AbortController();
      const dbFile = {
        file_id: 'canceled-file',
        filename: 'report.csv',
        filepath: '/uploads/report.csv',
        source: 'local',
        context: 'execute_code',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'OLD_SESSION',
            file_id: 'OLD_ID',
          },
        },
      };
      const handleFileUpload = jest.fn(async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      });
      getStrategyFunctions.mockImplementation((source) =>
        source === 'execute_code'
          ? { handleFileUpload }
          : { getDownloadStream: jest.fn().mockResolvedValue('stream') },
      );
      getFiles.mockResolvedValue([dbFile]);
      filterFilesByAgentAccess.mockImplementation(({ files }) => Promise.resolve(files));
      mockAxios.mockResolvedValue({ data: null });

      await expect(
        primeFiles({
          req: { user: { id: 'user-123', role: 'USER' } },
          tool_resources: { execute_code: { file_ids: [dbFile.file_id], files: [] } },
          agentId: 'agent-id',
          signal: controller.signal,
          maxQueueWaitMs: 0,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(handleFileUpload).toHaveBeenCalledTimes(1);
    });

    it('uses the permission resource type established by the calling route', async () => {
      const files = [
        {
          file_id: 'owner-file',
          filename: 'owner.txt',
          user: 'agent-owner',
          metadata: {},
        },
      ];
      getFiles.mockResolvedValue(files);
      filterFilesByAgentAccess.mockImplementation(({ files: authorizedFiles }) =>
        Promise.resolve(authorizedFiles),
      );

      await primeFiles({
        req: { user: { id: 'remote-viewer', role: 'USER' } },
        agentId: 'agent-123',
        agentResourceType: ResourceType.REMOTE_AGENT,
        tool_resources: { execute_code: { file_ids: ['owner-file'] } },
      });

      expect(filterFilesByAgentAccess).toHaveBeenCalledWith({
        files,
        userId: 'remote-viewer',
        role: 'USER',
        agentId: 'agent-123',
        resourceType: ResourceType.REMOTE_AGENT,
      });
      expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(files[0].filename);
    });

    it('does not read a runtime file record that has no authorized database record', async () => {
      const getDownloadStream = jest.fn().mockResolvedValue('forged-stream');
      const handleFileUpload = jest.fn();
      getStrategyFunctions.mockImplementation((source) => {
        if (source === 'execute_code') return { handleFileUpload };
        return { getDownloadStream };
      });
      getFiles.mockResolvedValue([]);
      mockAxios.mockResolvedValue({ data: null });

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: {
            files: [
              {
                file_id: 'forged-file',
                filename: 'secrets.txt',
                filepath: '/etc/passwd',
                source: 'local',
                metadata: {
                  codeEnvRef: {
                    kind: 'user',
                    id: 'user-123',
                    storage_session_id: 'missing-session',
                    file_id: 'missing-file',
                  },
                },
              },
            ],
          },
        },
        agentId: 'agent-id',
      });

      expect(result.files).toEqual([]);
      expect(getDownloadStream).not.toHaveBeenCalled();
      expect(handleFileUpload).not.toHaveBeenCalled();
    });

    it('rehydrates a runtime file by ID before using its storage metadata', async () => {
      const trustedFile = {
        file_id: 'runtime-file',
        filename: 'trusted.txt',
        filepath: '/uploads/trusted.txt',
        source: 'local',
        context: 'execute_code',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'trusted-session',
            file_id: 'trusted-file',
          },
        },
      };
      const getDownloadStream = jest.fn().mockResolvedValue('trusted-stream');
      const handleFileUpload = jest
        .fn()
        .mockResolvedValue({ storage_session_id: 'new-session', file_id: 'new-file' });
      getStrategyFunctions.mockImplementation((source) => {
        if (source === 'execute_code') return { handleFileUpload };
        return { getDownloadStream };
      });
      getFiles.mockResolvedValue([trustedFile]);
      mockAxios.mockResolvedValue({ data: null });

      await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: {
            files: [
              {
                ...trustedFile,
                filepath: '/etc/passwd',
                source: 'forged-source',
                metadata: {
                  codeEnvRef: {
                    kind: 'user',
                    id: 'attacker',
                    storage_session_id: 'forged-session',
                    file_id: 'forged-file',
                  },
                },
              },
            ],
          },
        },
        agentId: 'agent-id',
      });

      expect(getDownloadStream).toHaveBeenCalledTimes(1);
      expect(getDownloadStream).toHaveBeenCalledWith(
        { user: { id: 'user-123', role: 'USER' } },
        '/uploads/trusted.txt',
        { signal: undefined },
      );
      expect(handleFileUpload).toHaveBeenCalledTimes(1);
    });

    it('seed receives FRESH (storage_session_id, file_id) from the reupload response', async () => {
      const dbFile = {
        file_id: 'librechat-file-id',
        filename: 'sentinel.txt',
        filepath: '/uploads/sentinel.txt',
        source: 'local',
        context: 'execute_code',
        metadata: {
          /* Stale sandbox ref — this is what `getSessionInfo` will 404 on. */
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'OLD_SESSION',
            file_id: 'OLD_ID',
          },
        },
      };
      getFiles.mockResolvedValue([dbFile]);

      setupReuploadMocks({ storage_session_id: 'NEW_SESSION', file_id: 'NEW_ID' });

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: { file_ids: ['librechat-file-id'], files: [] },
        },
        agentId: 'agent-id',
      });

      // The seed list (consumed by buildInitialToolSessions) MUST carry
      // the post-reupload ids — not the stale pre-reupload ones.
      expect(result.files).toEqual([
        {
          id: 'NEW_ID',
          /* `resource_id` carries the codeEnvRef.id (= original
           * userId for kind: 'user'), threaded onto the in-memory
           * file ref for codeapi's sessionKey re-derivation. */
          resource_id: 'user-123',
          storage_session_id: 'NEW_SESSION',
          name: 'sentinel.txt',
          kind: 'user',
        },
      ]);
    });

    it('reuploads a recovered converted image under its advertised sandbox name', async () => {
      getFiles.mockResolvedValue([
        {
          file_id: 'converted-image',
          filename: 'photo.png',
          filepath: '/uploads/photo.webp',
          type: 'image/webp',
          source: 'local',
          context: 'execute_code',
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: 'user-123',
              storage_session_id: 'OLD_SESSION',
              file_id: 'OLD_ID',
            },
          },
        },
      ]);
      const { handleFileUpload } = setupReuploadMocks({
        storage_session_id: 'NEW_SESSION',
        file_id: 'NEW_ID',
      });

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['converted-image'], files: [] } },
        agentId: 'agent-id',
      });

      expect(handleFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'photo.webp' }),
      );
      expect(result.files?.[0]?.name).toBe('photo.webp');
    });

    /* Phase C / option α (codeapi #1455): reupload preserves the
     * resource identity from the existing ref so codeapi re-buckets
     * under the same sessionKey shape. Without this, a skill-cache-miss
     * reupload lands in the user bucket and is no longer cross-user
     * shareable. */
    it('reupload forwards kind/id (and version when skill) from the existing ref', async () => {
      const dbFile = {
        file_id: 'librechat-file-id',
        filename: 'sentinel.txt',
        filepath: '/uploads/sentinel.txt',
        source: 'local',
        context: 'execute_code',
        metadata: {
          codeEnvRef: {
            kind: 'skill',
            id: 'skill-99',
            storage_session_id: 'OLD_SESSION',
            file_id: 'OLD_ID',
            version: 4,
          },
        },
      };
      getFiles.mockResolvedValue([dbFile]);

      const { handleFileUpload } = setupReuploadMocks({
        storage_session_id: 'NEW_SESSION',
        file_id: 'NEW_ID',
      });

      await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: { file_ids: ['librechat-file-id'], files: [] },
        },
        agentId: 'agent-id',
      });

      expect(handleFileUpload).toHaveBeenCalledTimes(1);
      const uploadArgs = handleFileUpload.mock.calls[0][0];
      expect(uploadArgs.kind).toBe('skill');
      expect(uploadArgs.id).toBe('skill-99');
      expect(uploadArgs.version).toBe(4);
    });

    it('reuploads instead of reusing a ref from the other execution profile', async () => {
      const dbFile = {
        file_id: 'librechat-file-id',
        filename: 'sentinel.txt',
        filepath: '/uploads/sentinel.txt',
        source: 'local',
        context: 'execute_code',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'DEFAULT_SESSION',
            file_id: 'DEFAULT_ID',
            executionProfile: 'default',
          },
        },
      };
      getFiles.mockResolvedValue([dbFile]);
      const { handleFileUpload } = setupReuploadMocks({
        storage_session_id: 'STATEFUL_SESSION',
        file_id: 'STATEFUL_ID',
      });

      await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: { file_ids: ['librechat-file-id'], files: [] },
        },
        agentId: 'agent-id',
        codeApiBaseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
        bridgeWorkerId: 'personal-worker-1',
      });

      expect(mockAxios).not.toHaveBeenCalled();
      expect(handleFileUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          codeApiBaseUrl: 'https://stateful-code.example.com',
          executionProfile: 'stateful',
          bridgeWorkerId: 'personal-worker-1',
        }),
      );
      expect(updateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          'metadata.codeEnvRef': expect.objectContaining({ executionProfile: 'default' }),
          'metadata.codeEnvRefs.stateful': expect.objectContaining({
            executionProfile: 'stateful',
          }),
        }),
      );

      const persistedMetadata = {
        ...dbFile.metadata,
        codeEnvRef: updateFile.mock.calls[0][0]['metadata.codeEnvRef'],
        codeEnvRefs: {
          default: dbFile.metadata.codeEnvRef,
          stateful: updateFile.mock.calls[0][0]['metadata.codeEnvRefs.stateful'],
        },
      };
      getFiles.mockResolvedValue([{ ...dbFile, metadata: persistedMetadata }]);
      mockAxios.mockResolvedValue({ data: { lastModified: new Date().toISOString() } });

      await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: { file_ids: ['librechat-file-id'], files: [] },
        },
        agentId: 'agent-id',
        executionProfile: 'default',
      });

      expect(handleFileUpload).toHaveBeenCalledTimes(1);
      expect(mockAxios).toHaveBeenCalledWith(
        expect.objectContaining({
          url: expect.stringContaining('/sessions/DEFAULT_SESSION/objects/DEFAULT_ID'),
        }),
      );
    });

    it('persists fresh codeEnvRef (kind/id preserved) on the DB record after reupload', async () => {
      const dbFile = {
        file_id: 'librechat-file-id',
        filename: 'sentinel.txt',
        filepath: '/uploads/sentinel.txt',
        source: 'local',
        context: 'execute_code',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'OLD_SESSION',
            file_id: 'OLD_ID',
          },
        },
      };
      getFiles.mockResolvedValue([dbFile]);

      setupReuploadMocks({ storage_session_id: 'NEW_SESSION', file_id: 'NEW_ID' });

      await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: { file_ids: ['librechat-file-id'], files: [] },
        },
        agentId: 'agent-id',
      });

      expect(updateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          file_id: 'librechat-file-id',
          'metadata.codeEnvRef': {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'NEW_SESSION',
            file_id: 'NEW_ID',
            executionProfile: 'default',
            sandboxFilename: 'sentinel.txt',
          },
          'metadata.codeEnvRefs.default': {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'NEW_SESSION',
            file_id: 'NEW_ID',
            executionProfile: 'default',
            sandboxFilename: 'sentinel.txt',
          },
        }),
      );
    });

    it('reads codeEnvRef directly when present (skipping reupload)', async () => {
      const dbFile = {
        file_id: 'librechat-file-id',
        filename: 'sentinel.txt',
        filepath: '/uploads/sentinel.txt',
        source: 'local',
        context: 'execute_code',
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'STRUCT_SESSION',
            file_id: 'STRUCT_ID',
          },
        },
      };
      getFiles.mockResolvedValue([dbFile]);
      filterFilesByAgentAccess.mockImplementation(({ files }) => Promise.resolve(files));
      // getSessionInfo returns a fresh timestamp so reupload is skipped.
      mockAxios.mockResolvedValue({ data: { lastModified: new Date().toISOString() } });

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: {
          execute_code: { file_ids: ['librechat-file-id'], files: [] },
        },
        agentId: 'agent-id',
      });

      expect(updateFile).not.toHaveBeenCalled();
      expect(result.files).toEqual([
        {
          id: 'STRUCT_ID',
          /* `resource_id` from the persisted codeEnvRef.id — for
           * `kind: 'user'` this is informational (codeapi derives
           * sessionKey from auth context) but threaded for shape
           * uniformity with shared kinds. */
          resource_id: 'user-123',
          storage_session_id: 'STRUCT_SESSION',
          name: 'sentinel.txt',
          kind: 'user',
        },
      ]);
    });

    it.each([
      ['Axios/CloudFront 404', { response: { status: 404 } }, 'missing_backing_object'],
      [
        'AWS SDK NoSuchKey',
        { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } },
        'missing_backing_object',
      ],
      ['Azure BlobNotFound', { code: 'BlobNotFound', statusCode: 404 }, 'missing_backing_object'],
      ['storage access denied', { code: 'AccessDenied', status: 403 }, 'resource_access_denied'],
      ['Code API throttling', { code: 'CODE_API_RATE_LIMITED', status: 429 }, 'rate_limited'],
    ])(
      'fails with a typed recovery error for %s',
      async (_errorShape, downloadError, expectedCategory) => {
        const dbFile = {
          file_id: 'librechat-file-id',
          filename: 'cross-region-report.png',
          filepath: 'https://storage.us-east.example.test/missing-object',
          source: 'local',
          context: 'execute_code',
          metadata: {
            codeEnvRef: {
              kind: 'user',
              id: 'user-123',
              storage_session_id: 'US_EAST_SESSION',
              file_id: 'MISSING_OBJECT',
            },
          },
        };
        const getDownloadStream = jest.fn().mockRejectedValue(downloadError);
        getFiles.mockResolvedValue([dbFile]);
        getStrategyFunctions.mockImplementation((source) =>
          source === 'execute_code' ? { handleFileUpload: jest.fn() } : { getDownloadStream },
        );
        mockAxios.mockResolvedValue({ data: null });

        await expect(
          primeFiles({
            req: {
              id: 'request-123',
              body: { messageId: 'run-123' },
              user: { id: 'user-123', role: 'USER' },
            },
            tool_resources: {
              execute_code: { file_ids: ['librechat-file-id'], files: [] },
            },
            agentId: 'agent-id',
          }),
        ).rejects.toMatchObject({
          code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
          status: 409,
          statusCode: 409,
          details: { required: 1, primed: 0, failed: 1 },
          required: 1,
          primed: 0,
          failed: 1,
        });

        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `resource-recovery-required requestId=request-123 runId=run-123 required=1 primed=0 failed=1 category=${expectedCategory}`,
          ),
        );
        const failureLogs = logger.error.mock.calls.map(([message]) => message).join('\n');
        expect(failureLogs).toContain(`category=${expectedCategory}`);
        expect(failureLogs).not.toContain(dbFile.filename);
        expect(failureLogs).not.toContain(dbFile.filepath);
      },
    );
  });

  describe('primeFiles toolContext for model-visible code files', () => {
    /* User-visible code-env input files keep their `/mnt/data` context and
     * preview lifecycle hints. Prior-turn generated artifacts are still
     * primed into the sandbox, but no longer repeated in model-visible
     * instructions every turn. */

    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const { getFiles } = require('~/models');
    const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');

    function makeFile(overrides) {
      return {
        file_id: `fid-${overrides.status ?? 'ready'}`,
        filename: `data-${overrides.status ?? 'ready'}.xlsx`,
        filepath: `/uploads/${overrides.status ?? 'ready'}.xlsx`,
        source: 'local',
        context: FileContext.message_attachment,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'user-123',
            storage_session_id: 'CURRENT_SESSION',
            file_id: 'CURRENT_ID',
          },
        },
        ...overrides,
      };
    }

    function setupSessionInfoOk() {
      /* `getSessionInfo` returns `lastModified`; `checkIfActive` parses
       * that as a Date and decides whether the sandbox copy is still
       * fresh (under 23 hours). Use `now` so we always go straight to
       * `pushFile` and exercise the toolContext annotation logic. */
      mockAxios.mockResolvedValue({ data: { lastModified: new Date().toISOString() } });
      getStrategyFunctions.mockReturnValue({});
      filterFilesByAgentAccess.mockImplementation(({ files }) => Promise.resolve(files));
    }

    it('does not include generated code files in model-visible toolContext', async () => {
      setupSessionInfoOk();
      getFiles.mockResolvedValue([
        makeFile({
          context: FileContext.execute_code,
          filename: 'generated.html',
        }),
      ]);

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-ready'], files: [] } },
        agentId: 'agent-id',
      });

      expect(result.toolContext).toBe('');
      expect(result.files).toEqual([
        {
          id: 'CURRENT_ID',
          resource_id: 'user-123',
          storage_session_id: 'CURRENT_SESSION',
          name: 'generated.html',
          kind: 'user',
        },
      ]);
    });

    it('mounts a converted image under the name the sandbox actually holds', async () => {
      /* Image uploads are converted to the configured output type while the record keeps
       * the original filename. Provisioning uploaded the converted name, so rebuilding
       * the mount path from the record advertises a file the sandbox does not have. */
      setupSessionInfoOk();
      getFiles.mockResolvedValue([
        makeFile({
          file_id: 'fid-ready',
          filename: 'photo.png',
          type: 'image/webp',
        }),
      ]);

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-ready'], files: [] } },
        agentId: 'agent-id',
      });

      expect(result.files?.[0]?.name).toBe('photo.webp');
    });

    it('tells the model an attached workspace cannot open primed files', async () => {
      setupSessionInfoOk();
      getFiles.mockResolvedValue([makeFile({ status: 'ready' })]);

      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-ready'], files: [] } },
        agentId: 'agent-id',
        codeFileLocation: 'programmatic',
      });

      expect(result.toolContext).toContain('not in the attached workspace');
      expect(result.toolContext).toContain('$LIBRECHAT_CODE_DATA_DIR/data-ready.xlsx');
      expect(result.toolContext).not.toContain('/mnt/data');
      expect(result.toolContext).not.toContain('tool environment:');
      expect(result.files).toHaveLength(1);
    });

    it('annotates a pending file with "(preview not yet generated)"', async () => {
      setupSessionInfoOk();
      getFiles.mockResolvedValue([makeFile({ status: 'pending' })]);
      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-pending'], files: [] } },
        agentId: 'agent-id',
      });
      expect(result.toolContext).toContain('data-pending.xlsx');
      expect(result.toolContext).toContain('(preview not yet generated)');
    });

    it('annotates a failed file with "(preview unavailable: <reason>)"', async () => {
      setupSessionInfoOk();
      getFiles.mockResolvedValue([makeFile({ status: 'failed', previewError: 'timeout' })]);
      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-failed'], files: [] } },
        agentId: 'agent-id',
      });
      expect(result.toolContext).toContain('data-failed.xlsx');
      expect(result.toolContext).toContain('(preview unavailable: timeout)');
    });

    it('falls back to bare "(preview unavailable)" when previewError is absent', async () => {
      setupSessionInfoOk();
      getFiles.mockResolvedValue([makeFile({ status: 'failed' })]);
      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-failed'], files: [] } },
        agentId: 'agent-id',
      });
      expect(result.toolContext).toContain('(preview unavailable)');
      expect(result.toolContext).not.toContain('(preview unavailable:');
    });

    it('does not annotate a ready file (no extra suffix)', async () => {
      setupSessionInfoOk();
      getFiles.mockResolvedValue([makeFile({ status: 'ready' })]);
      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-ready'], files: [] } },
        agentId: 'agent-id',
      });
      expect(result.toolContext).toContain('data-ready.xlsx');
      expect(result.toolContext).not.toContain('preview');
    });

    it('does not annotate a legacy file (no status field, back-compat)', async () => {
      /* Records pre-dating the deferred-preview flow have no `status`. They
       * MUST render exactly as before — no suffix at all. */
      setupSessionInfoOk();
      getFiles.mockResolvedValue([makeFile({})]); // no status override
      const result = await primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: { execute_code: { file_ids: ['fid-ready'], files: [] } },
        agentId: 'agent-id',
      });
      expect(result.toolContext).toContain('data-ready.xlsx');
      expect(result.toolContext).not.toContain('preview');
    });
  });

  /**
   * Windowing, window sizing, rate-limit waiting and byte assembly moved to
   * `packages/api` (`files/code/image.ts`, `utils/code.ts`) and are tested
   * there against the real implementations. What remains here is the piece
   * this file still owns: the `/exec` transport — session forwarding, the
   * profile header, and handing the response to the shared parser.
   */
  describe('readSandboxImage transport', () => {
    beforeEach(() => {
      process.env.LIBRECHAT_CODE_BASEURL = 'http://code.test/v1';
      mockAxios.mockReset();
      mockParseSandboxImageChunk.mockReset();
      mockParseSandboxImageChunk.mockImplementation((response) => response);
    });

    it('reuses the exact artifact preflight buffer without calling /exec', async () => {
      const req = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      const source = Buffer.from('cached-image-bytes');
      mockAxios.mockResolvedValueOnce({ data: source });
      determineFileType.mockResolvedValueOnce({ mime: 'image/png' });

      await prepareCodeOutputForInspection({
        ...baseParams,
        req,
        id: 'artifact-file',
        name: 'charts/result.png',
        session_id: 'artifact-session',
      });
      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios.mock.calls[0][0].method).toBe('get');
      mockAxios.mockClear();

      const result = await readSandboxImage({
        req,
        file_path: '/mnt/data/charts/result.png',
        session_id: 'runtime-session',
        files: [
          {
            id: 'artifact-file',
            name: 'charts/result.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(mockAxios).not.toHaveBeenCalled();
      expect(result).toEqual({ base64: source.toString('base64'), bytes: source.length });
    });

    it('does not reuse a same-path buffer for a different artifact ref', async () => {
      const req = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      mockAxios.mockResolvedValueOnce({ data: Buffer.from('stale') });
      determineFileType.mockResolvedValueOnce({ mime: 'image/png' });
      await prepareCodeOutputForInspection({
        ...baseParams,
        req,
        id: 'stale-file',
        name: 'chart.png',
        session_id: 'artifact-session',
      });
      mockAxios.mockReset();
      mockAxios.mockResolvedValueOnce({ data: { stdout: '{}' } });

      await readSandboxImage({
        req,
        file_path: '/mnt/data/chart.png',
        files: [
          {
            id: 'current-file',
            name: 'chart.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios.mock.calls[0][0].method).toBe('post');
    });

    it('does not reuse an exact artifact ref across requests', async () => {
      const ownerReq = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      const otherReq = {
        user: { id: 'other-user' },
        config: mockReq.config,
      };
      mockAxios.mockResolvedValueOnce({ data: Buffer.from('owner-bytes') });
      determineFileType.mockResolvedValueOnce({ mime: 'image/png' });
      await prepareCodeOutputForInspection({
        ...baseParams,
        req: ownerReq,
        id: 'artifact-file',
        name: 'chart.png',
        session_id: 'artifact-session',
      });
      mockAxios.mockReset();
      mockAxios.mockResolvedValueOnce({ data: { stdout: '{}' } });

      await readSandboxImage({
        req: otherReq,
        file_path: '/mnt/data/chart.png',
        files: [
          {
            id: 'artifact-file',
            name: 'chart.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios.mock.calls[0][0].method).toBe('post');
    });

    it('does not reuse an artifact ref from a different Code API deployment', async () => {
      const req = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      mockAxios.mockResolvedValueOnce({ data: Buffer.from('deployment-a') });
      determineFileType.mockResolvedValueOnce({ mime: 'image/png' });
      await prepareCodeOutputForInspection({
        ...baseParams,
        req,
        id: 'artifact-file',
        name: 'chart.png',
        session_id: 'artifact-session',
        codeApiBaseUrl: 'https://code-a.example.com',
        executionProfile: 'stateful',
        executionRouteKey: 'stateful:deployment-a',
      });
      mockAxios.mockReset();
      mockAxios.mockResolvedValueOnce({ data: { stdout: '{}' } });

      await readSandboxImage({
        req,
        file_path: '/mnt/data/chart.png',
        codeApiBaseUrl: 'https://code-b.example.com',
        executionProfile: 'stateful',
        executionRouteKey: 'stateful:deployment-b',
        files: [
          {
            id: 'artifact-file',
            name: 'chart.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios.mock.calls[0][0]).toMatchObject({
        method: 'post',
        url: 'https://code-b.example.com/exec',
      });
    });

    it('does not reuse a cached artifact for a path containing parent traversal', async () => {
      const req = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      mockAxios.mockResolvedValueOnce({ data: Buffer.from('cached-chart') });
      determineFileType.mockResolvedValueOnce({ mime: 'image/png' });
      await prepareCodeOutputForInspection({
        ...baseParams,
        req,
        id: 'artifact-file',
        name: 'chart.png',
        session_id: 'artifact-session',
      });
      mockAxios.mockReset();
      mockAxios.mockResolvedValueOnce({ data: { stdout: '{}' } });

      await readSandboxImage({
        req,
        file_path: '/mnt/data/link/../chart.png',
        files: [
          {
            id: 'artifact-file',
            name: 'chart.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios.mock.calls[0][0].method).toBe('post');
    });

    it('does not treat a literal backslash in a POSIX path as a separator', async () => {
      const req = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      mockAxios.mockResolvedValueOnce({ data: Buffer.from('cached-chart') });
      determineFileType.mockResolvedValueOnce({ mime: 'image/png' });
      await prepareCodeOutputForInspection({
        ...baseParams,
        req,
        id: 'artifact-file',
        name: 'charts/result.png',
        session_id: 'artifact-session',
      });
      mockAxios.mockReset();
      mockAxios.mockResolvedValueOnce({ data: { stdout: '{}' } });

      await readSandboxImage({
        req,
        file_path: '/mnt/data/charts\\result.png',
        files: [
          {
            id: 'artifact-file',
            name: 'charts/result.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios.mock.calls[0][0].method).toBe('post');
    });

    it('evicts the oldest prepared buffers when the per-request cache reaches its limit', async () => {
      const req = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      mockAxios.mockResolvedValue({ data: Buffer.from('cached') });

      for (let index = 0; index < 11; index++) {
        await prepareCodeOutputForInspection({
          ...baseParams,
          req,
          id: `artifact-${index}`,
          name: `chart-${index}.png`,
          session_id: 'artifact-session',
          inspectContent: false,
        });
      }
      mockAxios.mockReset();
      mockAxios.mockResolvedValueOnce({ data: { stdout: '{}' } });

      await readSandboxImage({
        req,
        file_path: '/mnt/data/chart-0.png',
        files: [
          {
            id: 'artifact-0',
            name: 'chart-0.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(mockAxios).toHaveBeenCalledTimes(1);
      expect(mockAxios.mock.calls[0][0].method).toBe('post');
      mockAxios.mockClear();

      const newest = await readSandboxImage({
        req,
        file_path: '/mnt/data/chart-10.png',
        files: [
          {
            id: 'artifact-10',
            name: 'chart-10.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(newest).toEqual({ base64: Buffer.from('cached').toString('base64'), bytes: 6 });
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('applies the inline byte limit before returning a prepared artifact buffer', async () => {
      const req = {
        user: { id: 'artifact-user' },
        config: mockReq.config,
      };
      const source = Buffer.alloc(128);
      mockAxios.mockResolvedValueOnce({ data: source });
      determineFileType.mockResolvedValueOnce({ mime: 'image/png' });
      await prepareCodeOutputForInspection({
        ...baseParams,
        req,
        id: 'large-file',
        name: 'large.png',
        session_id: 'artifact-session',
      });
      mockAxios.mockClear();

      const result = await readSandboxImage({
        req,
        file_path: '/mnt/data/large.png',
        maxBytes: 64,
        files: [
          {
            id: 'large-file',
            name: 'large.png',
            storage_session_id: 'artifact-session',
          },
        ],
      });

      expect(result).toEqual({ tooLarge: true, reason: 'size', bytes: source.length });
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('forwards the sandbox session, runtime hint and profile header', async () => {
      const controller = new AbortController();
      mockAxios.mockResolvedValue({ data: { stdout: '{}' } });

      await readSandboxImage({
        file_path: '/mnt/data/chart.png',
        session_id: 'session-abc',
        runtime_session_hint: 'hint-xyz',
        files: [{ id: 'file-1', name: 'seed.csv' }],
        codeApiBaseUrl: 'https://code-stateful.example.com',
        executionProfile: 'stateful',
        signal: controller.signal,
      });

      expect(mockAxios).toHaveBeenCalledTimes(1);
      const call = mockAxios.mock.calls[0][0];
      expect(call.url).toBe('https://code-stateful.example.com/exec');
      expect(call.data).toMatchObject({
        lang: 'bash',
        session_id: 'session-abc',
        runtime_session_hint: 'hint-xyz',
        files: [{ id: 'file-1', name: 'seed.csv' }],
      });
      expect(call.headers['X-CodeAPI-Expected-Profile']).toBe('stateful');
      expect(call.signal).toBe(controller.signal);
      const { withCodeApiRateLimit } = require('@librechat/api');
      expect(withCodeApiRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('omits the profile header and optional session fields when unset', async () => {
      mockAxios.mockResolvedValue({ data: { stdout: '{}' } });

      await readSandboxImage({ file_path: '/mnt/data/chart.png' });

      const call = mockAxios.mock.calls[0][0];
      expect(call.data.session_id).toBeUndefined();
      expect(call.data.runtime_session_hint).toBeUndefined();
      expect(call.data.files).toBeUndefined();
      expect(call.headers['X-CodeAPI-Expected-Profile']).toBeUndefined();
    });

    it('hands the raw `/exec` response to the shared chunk parser', async () => {
      const data = { stdout: '{"total":3,"n":3,"b64":"AAAA"}', status: null };
      mockAxios.mockResolvedValue({ data });
      mockParseSandboxImageChunk.mockReturnValue({ total: 3, n: 3, b64: 'AAAA' });

      const result = await readSandboxImage({ file_path: '/mnt/data/x.png' });

      expect(mockParseSandboxImageChunk).toHaveBeenCalledWith(data);
      expect(result).toEqual({ total: 3, n: 3, b64: 'AAAA' });
    });

    it('returns null when no code base URL is configured', async () => {
      const { getCodeBaseURL } = require('@librechat/agents');
      getCodeBaseURL.mockReturnValueOnce('');

      await expect(readSandboxImage({ file_path: '/mnt/data/x.png' })).resolves.toBeNull();
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('logs and rethrows a transport failure', async () => {
      const { logAxiosError } = require('@librechat/api');
      mockAxios.mockRejectedValue(new Error('codeapi unreachable'));

      await expect(readSandboxImage({ file_path: '/mnt/data/x.png' })).rejects.toThrow(
        'codeapi unreachable',
      );
      expect(logAxiosError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Error reading sandbox image "/mnt/data/x.png"',
        }),
      );
    });
  });

  describe('primeFiles keeps one file per sandbox destination (#15443 follow-up)', () => {
    /**
     * Codeapi mounts a by-ref input at the filename recorded on the stored
     * object — the file server's Content-Disposition — and only falls back to
     * the `name` sent in `/exec` when that header is absent. A suffixed alias
     * for a same-name duplicate therefore lands on the bare name anyway, and
     * the sandbox rejects the whole request as conflicting destinations; the
     * rejection recurs on every later turn because nothing comes back to
     * collapse the pair. `primeFiles` keeps the newest content at each stored
     * destination, preserving aliases assigned during upload, and drops collisions — the same collapse `ToolNode.updateCodeSession`
     * applies once results come back.
     *
     * Only code-generated outputs are covered by the `(filename,
     * conversationId, context, tenantId)` partial unique index; uploads carry
     * `context: message_attachment`, so a conversation can hold several
     * records sharing a filename.
     */
    const { getFiles } = require('~/models');
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');

    const codeFile = ({
      file_id,
      filename,
      storage_session_id,
      createdAt,
      context,
      sourceDispatchedAt,
      sandboxFilename,
    }) => ({
      file_id,
      filename,
      createdAt,
      context: context ?? 'message_attachment',
      source: 'local',
      filepath: `/uploads/${file_id}`,
      metadata: {
        ...(sourceDispatchedAt != null ? { sourceDispatchedAt } : {}),
        codeEnvRef: {
          kind: 'user',
          ...(sandboxFilename ? { sandboxFilename } : {}),
          id: 'user-123',
          storage_session_id,
          file_id: `${file_id}-sandbox`,
        },
      },
    });

    /** Freshness probe answers "uploaded just now", so every file takes the
     *  cache-hit path and none of them re-upload. */
    function setupActiveSessions() {
      getStrategyFunctions.mockImplementation(() => ({
        getDownloadStream: jest.fn(),
        handleFileUpload: jest.fn(),
      }));
      mockAxios.mockResolvedValue({ data: { lastModified: new Date().toISOString() } });
    }

    const prime = (tool_resources) =>
      primeFiles({
        req: { user: { id: 'user-123', role: 'USER' } },
        tool_resources: tool_resources ?? { execute_code: { file_ids: ['older', 'newer'] } },
        agentId: 'agent-id',
      });

    const bySession = (result) =>
      Object.fromEntries(result.files.map((f) => [f.storage_session_id, f.name]));

    it.each([false, true])('keeps a provisioned alias when expired=%s', async (expired) => {
      setupActiveSessions();
      const upload = jest.fn().mockImplementation(async ({ filename }) => ({
        storage_session_id: `fresh-${filename}`,
        file_id: `fresh-${filename}`,
      }));
      getStrategyFunctions.mockImplementation(() => ({
        getDownloadStream: jest.fn().mockResolvedValue('stream'),
        handleFileUpload: upload,
      }));
      if (expired) mockAxios.mockResolvedValue({ data: null });
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'rows.csv',
          sandboxFilename: 'rows-alias.csv',
          storage_session_id: 'old',
        }),
        codeFile({
          file_id: 'newer',
          filename: 'rows.csv',
          sandboxFilename: 'rows.csv',
          storage_session_id: 'new',
        }),
      ]);
      const result = await prime();
      expect(result.files.map((file) => file.name).sort()).toEqual(['rows-alias.csv', 'rows.csv']);
      if (expired) {
        expect(upload.mock.calls.map(([args]) => args.filename).sort()).toEqual([
          'rows-alias.csv',
          'rows.csv',
        ]);
      } else {
        expect(upload).not.toHaveBeenCalled();
      }
    });

    it('recovers a converted stale image even when its storage session has a fresh sibling', async () => {
      const upload = jest
        .fn()
        .mockResolvedValue({ storage_session_id: 'recovered', file_id: 'recovered-image' });
      getStrategyFunctions.mockImplementation(() => ({
        getDownloadStream: jest.fn().mockResolvedValue('webp-stream'),
        handleFileUpload: upload,
      }));
      mockAxios.mockImplementation(async ({ url }) => ({
        data: url.includes('newer-sandbox')
          ? { lastModified: new Date().toISOString(), originalFilename: 'ready.txt' }
          : { lastModified: '2020-01-01', originalFilename: 'plot-alias.png' },
      }));
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'newer',
          filename: 'ready.txt',
          storage_session_id: 'shared-session',
          createdAt: new Date('2026-01-02'),
        }),
        {
          ...codeFile({
            file_id: 'older',
            filename: 'plot.png',
            storage_session_id: 'shared-session',
            createdAt: new Date('2026-01-01'),
          }),
          type: 'image/webp',
        },
      ]);
      const result = await prime();
      expect(upload).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'plot-alias.webp', stream: 'webp-stream' }),
      );
      expect(result.files).toContainEqual(
        expect.objectContaining({
          name: 'plot-alias.webp',
          id: 'recovered-image',
          storage_session_id: 'recovered',
        }),
      );
    });

    it('keeps the selected live image when earlier recovery crosses the freshness cutoff', async () => {
      const now = Date.parse('2026-09-10T12:00:00Z');
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      const upload = jest.fn().mockImplementation(async () => {
        clock.mockReturnValue(now + 2_000);
        return { storage_session_id: 'recovered', file_id: 'recovered-text' };
      });
      getStrategyFunctions.mockImplementation(() => ({
        getDownloadStream: jest.fn().mockResolvedValue('stream'),
        handleFileUpload: upload,
      }));
      mockAxios.mockImplementation(async ({ url }) => ({
        data: url.includes('newer-sandbox')
          ? { lastModified: '2020-01-01', originalFilename: 'ready.txt' }
          : {
              lastModified: new Date(now - 23 * 3_600_000 + 1_000).toISOString(),
              originalFilename: 'plot-alias.png',
            },
      }));
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'newer',
          filename: 'ready.txt',
          storage_session_id: 'text-session',
          createdAt: new Date('2026-01-02'),
        }),
        {
          ...codeFile({
            file_id: 'older',
            filename: 'plot.png',
            storage_session_id: 'image-session',
            createdAt: new Date('2026-01-01'),
          }),
          type: 'image/webp',
        },
      ]);
      try {
        const result = await prime();
        expect(upload).toHaveBeenCalledTimes(1);
        expect(result.files).toContainEqual(
          expect.objectContaining({ name: 'plot-alias.png', id: 'older-sandbox' }),
        );
      } finally {
        clock.mockRestore();
      }
    });

    it('normalizes a recovered nested path and advertises the upload receipt name', async () => {
      const upload = jest.fn().mockResolvedValue({
        storage_session_id: 'recovered',
        file_id: 'receipt-id',
        filename: 'accepted.csv',
      });
      getStrategyFunctions.mockImplementation(() => ({
        getDownloadStream: jest.fn().mockResolvedValue('stream'),
        handleFileUpload: upload,
      }));
      mockAxios.mockResolvedValue({
        data: { originalFilename: 'my dir/file.csv', lastModified: '2020-01-01' },
      });
      getFiles.mockResolvedValue([
        codeFile({ file_id: 'older', filename: 'my dir/file.csv', storage_session_id: 'old' }),
      ]);
      const result = await prime();
      expect(upload).toHaveBeenCalledWith(expect.objectContaining({ filename: 'file.csv' }));
      expect(result.files).toContainEqual(
        expect.objectContaining({ name: 'accepted.csv', id: 'receipt-id' }),
      );
      expect(result.toolContext).toContain('/mnt/data/accepted.csv');
      expect(mockUpdateFile).toHaveBeenCalledWith(
        expect.objectContaining({
          'metadata.codeEnvRef': expect.objectContaining({ sandboxFilename: 'accepted.csv' }),
        }),
      );
    });

    it('keeps only the newest of two uploads sharing a filename', async () => {
      setupActiveSessions();
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'image.png',
          storage_session_id: 'sess-older',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        codeFile({
          file_id: 'newer',
          filename: 'image.png',
          storage_session_id: 'sess-newer',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        }),
      ]);

      const { files, toolContext } = await prime();

      expect(bySession({ files })).toEqual({ 'sess-newer': 'image.png' });
      expect(toolContext).toContain('/mnt/data/image.png');
      expect(toolContext).not.toContain('uploaded as');
    });

    it('keeps the same file regardless of the order getFiles returns', async () => {
      /**
       * `getFiles` sorts by `updatedAt` desc by default, and usage accounting
       * and re-upload both bump `updatedAt` — so the survivor cannot depend on
       * the query order, or a path the model has been reading would silently
       * flip to the other file between turns.
       */
      const older = codeFile({
        file_id: 'older',
        filename: 'image.png',
        storage_session_id: 'sess-older',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const newer = codeFile({
        file_id: 'newer',
        filename: 'image.png',
        storage_session_id: 'sess-newer',
        createdAt: new Date('2026-01-02T00:00:00Z'),
      });

      setupActiveSessions();
      getFiles.mockResolvedValue([older, newer]);
      const ascending = await prime();
      setupActiveSessions();
      getFiles.mockResolvedValue([newer, older]);
      const descending = await prime();

      expect(bySession(ascending)).toEqual(bySession(descending));
      expect(bySession(ascending)).toEqual({ 'sess-newer': 'image.png' });
    });

    it('lets a code output supersede the upload whose name it reused', async () => {
      setupActiveSessions();
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'data.csv',
          storage_session_id: 'sess-upload',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        codeFile({
          file_id: 'newer',
          filename: 'data.csv',
          storage_session_id: 'sess-output',
          createdAt: new Date('2026-01-02T00:00:00Z'),
          context: 'execute_code',
        }),
      ]);

      const { files, toolContext } = await prime();

      expect(bySession({ files })).toEqual({ 'sess-output': 'data.csv' });
      /* The output keeps the path it wrote, so it stays out of the context
       * exactly as any other generated file does. */
      expect(toolContext).not.toContain('/mnt/data/data.csv');
    });

    it('lets a newer upload supersede the generated output at the same path', async () => {
      setupActiveSessions();
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'report.png',
          storage_session_id: 'sess-output',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          context: 'execute_code',
        }),
        codeFile({
          file_id: 'newer',
          filename: 'report.png',
          storage_session_id: 'sess-upload',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        }),
      ]);

      const { files, toolContext } = await prime();

      expect(bySession({ files })).toEqual({ 'sess-upload': 'report.png' });
      expect(toolContext).toContain('/mnt/data/report.png');
      expect(toolContext).not.toContain('written earlier as');
    });

    it('ranks a rewritten output above an upload created after it', async () => {
      setupActiveSessions();
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'data.csv',
          storage_session_id: 'sess-output',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          context: 'execute_code',
          sourceDispatchedAt: Date.parse('2026-03-01T00:00:00Z'),
        }),
        codeFile({
          file_id: 'newer',
          filename: 'data.csv',
          storage_session_id: 'sess-upload',
          createdAt: new Date('2026-02-01T00:00:00Z'),
        }),
      ]);

      const { files } = await prime();

      expect(bySession({ files })).toEqual({ 'sess-output': 'data.csv' });
    });

    it("lets a conversation file outrank the agent's own file of the same name", async () => {
      /**
       * Every agent in a run primes the conversation's files plus its own, so
       * a private file surviving in one agent and not in another would leave
       * two agents reading different files at the same path in one mount
       * namespace.
       */
      setupActiveSessions();
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'shared',
          filename: 'data.csv',
          storage_session_id: 'sess-shared',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        codeFile({
          file_id: 'agent-own',
          filename: 'data.csv',
          storage_session_id: 'sess-agent',
          createdAt: new Date('2026-06-01T00:00:00Z'),
        }),
      ]);

      const { files } = await prime({
        execute_code: {
          file_ids: ['agent-own'],
          files: [{ file_id: 'shared' }],
        },
      });

      expect(bySession({ files })).toEqual({ 'sess-shared': 'data.csv' });
    });

    it('does not re-upload a file it drops', async () => {
      /**
       * The destination decision has to come before recovery: a dropped file
       * never reaches the sandbox, so re-uploading it would only
       * spend a round trip and, on failure, count against the run.
       */
      const handleFileUpload = jest.fn();
      getStrategyFunctions.mockImplementation(() => ({
        getDownloadStream: jest.fn(),
        handleFileUpload,
      }));
      mockAxios.mockImplementation(async ({ url }) =>
        url.includes('sess-newer')
          ? { data: { lastModified: new Date().toISOString(), originalFilename: 'image.png' } }
          : { data: { originalFilename: 'image.png' } },
      );
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'image.png',
          storage_session_id: 'sess-older',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        codeFile({
          file_id: 'newer',
          filename: 'image.png',
          storage_session_id: 'sess-newer',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        }),
      ]);

      const { files } = await prime();

      expect(bySession({ files })).toEqual({ 'sess-newer': 'image.png' });
      expect(handleFileUpload).not.toHaveBeenCalled();
    });

    it('drops a file whose path sits under a claimed name', async () => {
      /**
       * Codeapi's conflict rule also rejects a destination that is a directory
       * prefix of another, so `data` and `data/rows.csv` cannot both mount;
       * the ancestor check has to run at this layer or the pair still reaches
       * the sandbox and fails the request.
       */
      setupActiveSessions();
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'data/rows.csv',
          storage_session_id: 'sess-older',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        codeFile({
          file_id: 'newer',
          filename: 'data',
          storage_session_id: 'sess-newer',
          createdAt: new Date('2026-01-02T00:00:00Z'),
        }),
      ]);

      const { files } = await prime();

      expect(bySession({ files })).toEqual({ 'sess-newer': 'data' });
    });

    it('leaves a single file on its own filename', async () => {
      setupActiveSessions();
      getFiles.mockResolvedValue([
        codeFile({
          file_id: 'older',
          filename: 'report.pdf',
          storage_session_id: 'sess-only',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
      ]);

      const { files, toolContext } = await prime();

      expect(files.map((f) => f.name)).toEqual(['report.pdf']);
      expect(toolContext).toContain('/mnt/data/report.pdf');
      expect(toolContext).not.toContain('uploaded as');
    });
  });
});
