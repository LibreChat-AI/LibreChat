const mockRunCodeOutputBatchPreflight = jest.fn();
const mockPrepareCodeOutputForInspection = jest.fn();
const mockGetSafeErrorMetadata = jest.fn(() => ({ type: 'Error', status: 404 }));

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  preflightCodeOutputBatch: (...args) => mockRunCodeOutputBatchPreflight(...args),
  getSafeErrorMetadata: (...args) => mockGetSafeErrorMetadata(...args),
}));

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: { agents: 'agents' },
  mergeFileConfig: jest.fn(() => ({ serverFileSizeLimit: 32 })),
  getEndpointFileConfig: jest.fn(() => ({
    fileLimit: 4,
    fileSizeLimit: 8,
    totalSizeLimit: 16,
  })),
}));

jest.mock('./process', () => ({
  prepareCodeOutputForInspection: (...args) => mockPrepareCodeOutputForInspection(...args),
}));

const { logger } = require('@librechat/data-schemas');
const { preflightCodeOutputBatch } = require('./preflight');

describe('preflightCodeOutputBatch Code API routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareCodeOutputForInspection.mockResolvedValue({
      buffer: Buffer.from('safe'),
      file: { name: 'output.txt', content: 'safe' },
    });
    mockRunCodeOutputBatchPreflight.mockImplementation(async ({ prepare }) => {
      await prepare({
        file: { id: 'file-1', name: 'output.txt' },
        sessionId: 'session-1',
        maxBytes: 8,
        inspectContent: true,
      });
      return [];
    });
  });

  it('forwards the trusted per-agent Code API route to inspection downloads', async () => {
    const req = { config: {}, user: { id: 'user-1' } };

    await preflightCodeOutputBatch({
      req,
      artifact: { files: [{ id: 'file-1', name: 'output.txt' }] },
      codeExecutionContext: {
        baseUrl: 'https://code-stateful.example.com',
        executionProfile: 'stateful',
        executionRouteKey: 'stateful:route',
      },
    });

    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledWith({
      req,
      id: 'file-1',
      name: 'output.txt',
      session_id: 'session-1',
      maxBytes: 8,
      inspectContent: true,
      codeApiBaseUrl: 'https://code-stateful.example.com',
      executionProfile: 'stateful',
      executionRouteKey: 'stateful:route',
    });
  });

  /* The batch degrades an uninspectable artifact to the download fallback and
   * the turn still succeeds, so this warning is the only trace it leaves.
   * Without the cause, a refused download, a misrouted execution profile and
   * an oversized file are one indistinguishable sentence. */
  it('reports why an artifact could not be inspected, through the safe-metadata filter', async () => {
    const cause = Object.assign(new Error('Request failed with status code 404'), {
      response: { status: 404 },
    });
    mockRunCodeOutputBatchPreflight.mockImplementation(async ({ onInspectionUnavailable }) => {
      onInspectionUnavailable(0, cause);
      return [];
    });

    await preflightCodeOutputBatch({
      req: { config: {}, user: { id: 'user-1' } },
      artifact: { files: [{ id: 'file-1', name: 'PRIVATE-name.txt' }] },
    });

    expect(mockGetSafeErrorMetadata).toHaveBeenCalledWith(cause);
    expect(logger.warn).toHaveBeenCalledWith(
      '[preflightCodeOutputBatch] Generated artifact 1 could not be inspected',
      { type: 'Error', status: 404 },
    );
    /* The artifact's name is submitted content and must never ride the log. */
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('PRIVATE-');
  });
});
