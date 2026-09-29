import { Readable } from 'node:stream';
import { AxiosError, AxiosHeaders } from 'axios';
import type { TFile } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';

const mockAxios = jest.fn();
const mockGetCodeApiAuthHeaders = jest.fn();

jest.mock('~/utils', () => ({
  ...jest.requireActual('~/utils'),
  createAxiosInstance: () => mockAxios,
  logAxiosError: jest.fn(),
}));

jest.mock('~/auth/codeapi', () => ({
  ...jest.requireActual('~/auth/codeapi'),
  getCodeApiAuthHeaders: (...args: unknown[]) => mockGetCodeApiAuthHeaders(...args),
}));

jest.mock('@librechat/agents', () => ({
  getCodeBaseURL: () => 'http://code.test/v1',
}));

import { createCodeApiUploadRegistry } from '~/utils';
import { createProvisionService } from './service';
import { selectCodeFiles } from '../code/priming';

const req = {
  user: { id: 'u1' },
  app: { locals: { codeApiUploadRegistry: createCodeApiUploadRegistry() } },
} as unknown as ServerRequest;

const makeFile = (overrides: Partial<TFile> = {}): TFile =>
  ({
    file_id: 'f1',
    filename: 'data.csv',
    filepath: '/x/data.csv',
    type: 'text/csv',
    source: 'local',
    metadata: {},
    ...overrides,
  }) as TFile;

const buildService = (overrides: Record<string, unknown> = {}) => {
  const uploadCodeEnvFile = jest
    .fn()
    .mockResolvedValue({ storage_session_id: 's1', file_id: 'remote-1' });
  const getDownloadStream = jest.fn().mockResolvedValue({ pipe: jest.fn(), on: jest.fn() });
  const service = createProvisionService({
    getStrategyFunctions: ((source: string) =>
      source === 'execute_code'
        ? { handleFileUpload: uploadCodeEnvFile }
        : { getDownloadStream }) as never,
    uploadVectors: jest.fn().mockResolvedValue({ embedded: true }),
    loadAuthValues: jest.fn().mockResolvedValue({ LIBRECHAT_CODE_API_KEY: 'secret-key' }),
    ...overrides,
  } as never);
  return { service, uploadCodeEnvFile, getDownloadStream };
};

describe('createProvisionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCodeApiAuthHeaders.mockResolvedValue({});
  });

  describe('loadCodeApiKey', () => {
    it('reads the code key field without throwing when it is absent', async () => {
      const loadAuthValues = jest.fn().mockResolvedValue({});
      const { service } = buildService({ loadAuthValues });

      await expect(service.loadCodeApiKey('u1')).resolves.toBeUndefined();
      expect(loadAuthValues).toHaveBeenCalledWith({
        userId: 'u1',
        authFields: ['LIBRECHAT_CODE_API_KEY'],
        throwError: false,
      });
    });
  });

  describe('provisionToCodeEnv', () => {
    it('waits out Code API throttling and reopens the upload stream', async () => {
      const rateLimit = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
      rateLimit.response = {
        status: 429,
        statusText: 'Too Many Requests',
        headers: new AxiosHeaders({ 'retry-after': '0' }),
        config: { headers: new AxiosHeaders() },
        data: {},
      };
      const streams = [Readable.from('first'), Readable.from('second')];
      const getDownloadStream = jest
        .fn()
        .mockResolvedValueOnce(streams[0])
        .mockResolvedValueOnce(streams[1]);
      const uploadCodeEnvFile = jest
        .fn()
        .mockRejectedValueOnce(rateLimit)
        .mockResolvedValueOnce({ storage_session_id: 's1', file_id: 'remote-1' });
      const { service } = buildService({
        getStrategyFunctions: (source: string) =>
          source === 'execute_code'
            ? { handleFileUpload: uploadCodeEnvFile }
            : { getDownloadStream },
      });

      await expect(
        service.provisionToCodeEnv({
          req,
          file: makeFile(),
          rateLimitBudget: {
            limitMs: 2_000,
            waitedMs: 0,
            activeWaitEnds: new Set(),
          },
        }),
      ).resolves.toMatchObject({ referenceSet: { codeEnvRef: { file_id: 'remote-1' } } });

      expect(uploadCodeEnvFile).toHaveBeenCalledTimes(2);
      expect(getDownloadStream).toHaveBeenCalledTimes(2);
      expect(uploadCodeEnvFile.mock.calls.map(([args]) => args.stream)).toEqual(streams);
    });

    it('renames a converted image to match its stored MIME type', async () => {
      const { service, uploadCodeEnvFile } = buildService();

      const result = await service.provisionToCodeEnv({
        req,
        file: makeFile({ filename: 'photo.jpg', type: 'image/webp' }),
      });

      expect(uploadCodeEnvFile).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'photo.webp' }),
      );
      expect(result.referenceSet.codeEnvRefs?.default?.file_id).toBe('remote-1');
      expect(result.refUpdate.ref.sandboxFilename).toBe('photo.webp');
      expect(result.referenceSet.codeEnvRef?.sandboxFilename).toBe('photo.webp');
    });

    it('persists an assigned alias and preserves it through the next priming pass', async () => {
      const { service } = buildService();
      const original = makeFile();
      const result = await service.provisionToCodeEnv({
        req,
        file: original,
        sandboxFilename: 'data-alias.csv',
      });
      const { selected } = await selectCodeFiles({
        files: [{ ...original, metadata: { ...original.metadata, ...result.referenceSet } }],
        routeKey: 'default',
        getFileInfo: async () => null,
      });
      expect(result.refUpdate.ref.sandboxFilename).toBe('data-alias.csv');
      expect(selected[0].sandboxName).toBe('data-alias.csv');
    });

    it('persists the adapter receipt after normalizing a nested upload name', async () => {
      const { service, uploadCodeEnvFile } = buildService();
      uploadCodeEnvFile.mockResolvedValue({
        storage_session_id: 's1',
        file_id: 'remote-1',
        filename: 'file.csv',
      });
      const result = await service.provisionToCodeEnv({
        req,
        file: makeFile({ filename: 'my dir/file.csv' }),
      });
      expect(uploadCodeEnvFile).toHaveBeenCalledWith(
        expect.objectContaining({ filename: 'file.csv' }),
      );
      expect(result.refUpdate.ref.sandboxFilename).toBe('file.csv');
      expect(result.sandboxFilename).toBe('file.csv');
    });

    it('refuses a source whose download contract differs', async () => {
      const { service, uploadCodeEnvFile } = buildService();

      await expect(
        service.provisionToCodeEnv({ req, file: makeFile({ source: 'openai' as never }) }),
      ).rejects.toThrow(/does not support download streams/);
      expect(uploadCodeEnvFile).not.toHaveBeenCalled();
    });

    it('prefers a durable storage key when opening the backing object', async () => {
      const { service, getDownloadStream } = buildService();

      await service.provisionToCodeEnv({
        req,
        file: makeFile({ filepath: 'https://old.example/file', storageKey: 'uploads/u1/data.csv' }),
      });

      expect(getDownloadStream).toHaveBeenCalledWith(req, 'uploads/u1/data.csv', {
        signal: undefined,
      });
    });

    it('cancels storage acquisition and destroys a stream returned after cancellation', async () => {
      const controller = new AbortController();
      let resolveDownload!: (stream: Readable) => void;
      let markDownloadStarted!: () => void;
      const downloadStarted = new Promise<void>((resolve) => {
        markDownloadStarted = resolve;
      });
      const getDownloadStream = jest.fn(
        () =>
          new Promise<Readable>((resolve) => {
            markDownloadStarted();
            resolveDownload = resolve;
          }),
      );
      const { service } = buildService({
        getStrategyFunctions: (source: string) =>
          source === 'execute_code' ? { handleFileUpload: jest.fn() } : { getDownloadStream },
      });
      const pending = service.provisionToCodeEnv({
        req,
        file: makeFile(),
        signal: controller.signal,
      });

      await downloadStarted;
      controller.abort();
      const stream = new Readable({ read() {} });
      const destroy = jest.spyOn(stream, 'destroy');
      resolveDownload(stream);

      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(getDownloadStream).toHaveBeenCalledWith(req, '/x/data.csv', {
        signal: controller.signal,
      });
      expect(destroy).toHaveBeenCalled();
    });

    it('uploads to the agent resolved route and records its key', async () => {
      const { service, uploadCodeEnvFile } = buildService();

      const result = await service.provisionToCodeEnv({
        req,
        file: makeFile(),
        route: {
          baseUrl: 'http://stateful.test/v1',
          executionProfile: 'stateful',
          executionRouteKey: 'stateful:abc',
        },
      });

      expect(uploadCodeEnvFile).toHaveBeenCalledWith(
        expect.objectContaining({
          codeApiBaseUrl: 'http://stateful.test/v1',
          executionProfile: 'stateful',
        }),
      );
      expect(result.referenceSet.codeEnvRefs?.['stateful:abc']?.executionProfile).toBe('stateful');
    });

    it('defaults to the default deployment when no route is resolved', async () => {
      const { service, uploadCodeEnvFile } = buildService();

      const result = await service.provisionToCodeEnv({ req, file: makeFile() });

      expect(uploadCodeEnvFile).toHaveBeenCalledWith(
        expect.objectContaining({ executionProfile: 'default' }),
      );
      expect(uploadCodeEnvFile.mock.calls[0][0].codeApiBaseUrl).toBeUndefined();
      expect(result.referenceSet.codeEnvRefs?.default?.file_id).toBe('remote-1');
    });

    it('lets the injected vector backend define availability', async () => {
      const previous = process.env.RAG_API_URL;
      delete process.env.RAG_API_URL;
      const uploadVectors = jest.fn().mockResolvedValue({ embedded: true });
      const { service } = buildService({ uploadVectors });

      await expect(
        service.provisionToVectorDB({
          req,
          file: makeFile(),
          existingStream: Readable.from('data'),
        }),
      ).resolves.toEqual({ embedded: true, fileUpdate: { file_id: 'f1', embedded: true } });
      expect(uploadVectors).toHaveBeenCalledTimes(1);

      if (previous != null) {
        process.env.RAG_API_URL = previous;
      }
    });

    it('preserves pointers for other code routes', async () => {
      const { service } = buildService();
      const statefulRef = {
        kind: 'user',
        id: 'u1',
        storage_session_id: 's-stateful',
        file_id: 'r-stateful',
        executionProfile: 'stateful',
        executionRouteKey: 'stateful:abc',
      };

      const result = await service.provisionToCodeEnv({
        req,
        file: makeFile({ metadata: { codeEnvRefs: { 'stateful:abc': statefulRef } } as never }),
      });

      expect(result.referenceSet.codeEnvRefs?.['stateful:abc']).toEqual(statefulRef);
      expect(result.referenceSet.codeEnvRefs?.default?.file_id).toBe('remote-1');
    });
  });

  describe('checkSessionsAlive', () => {
    const staleFile = (id: string) =>
      makeFile({
        file_id: id,
        metadata: {
          codeEnvRef: {
            kind: 'user',
            id: 'u1',
            storage_session_id: 'sess-1',
            file_id: `remote-${id}`,
            provisionedAt: 1,
          },
        } as never,
      });

    it('authenticates with bearer headers when no legacy key is set', async () => {
      mockGetCodeApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer jwt' });
      mockAxios.mockResolvedValue({ data: [{ fileId: 'remote-f1' }] });
      const { service } = buildService();

      const alive = await service.checkSessionsAlive({ files: [staleFile('f1')], req });

      const headers = mockAxios.mock.calls[0][0].headers;
      expect(headers.Authorization).toBe('Bearer jwt');
      expect(headers['X-API-Key']).toBeUndefined();
      expect(alive.has('f1')).toBe(true);
    });

    it('probes an agent-scoped session with the identity codeapi needs to resolve it', async () => {
      /* Codeapi rebuilds the session key from kind and id for shared kinds. Without them
       * it looks in the requester's own bucket, 404s on a live agent session, and this
       * method reads that as expiry and queues a needless re-upload. */
      mockAxios.mockResolvedValue({ data: [{ fileId: 'remote-agent' }] });
      const { service } = buildService();
      const agentFile = makeFile({
        file_id: 'f-agent',
        metadata: {
          codeEnvRef: {
            kind: 'agent',
            id: 'agent_a1',
            storage_session_id: 'sess-agent',
            file_id: 'remote-agent',
            provisionedAt: 1,
          },
        } as never,
      });

      const alive = await service.checkSessionsAlive({ files: [agentFile], req });

      expect(mockAxios.mock.calls[0][0].params).toEqual(
        expect.objectContaining({ kind: 'agent', id: 'agent_a1', detail: 'summary' }),
      );
      expect(alive.has('f-agent')).toBe(true);
    });

    it('prefers bearer auth when a legacy key is also configured', async () => {
      mockGetCodeApiAuthHeaders.mockResolvedValue({ Authorization: 'Bearer jwt' });
      mockAxios.mockResolvedValue({ data: [] });
      const { service } = buildService();

      await service.checkSessionsAlive({ files: [staleFile('f2')], apiKey: 'legacy-key' });

      expect(mockAxios.mock.calls[0][0].headers).toEqual(
        expect.objectContaining({ Authorization: 'Bearer jwt' }),
      );
      expect(mockAxios.mock.calls[0][0].headers['X-API-Key']).toBeUndefined();
    });

    it('uses the legacy key when managed bearer auth is unavailable', async () => {
      mockAxios.mockResolvedValue({ data: [] });
      const { service } = buildService();

      await service.checkSessionsAlive({ files: [staleFile('f2')], apiKey: 'legacy-key' });

      expect(mockAxios.mock.calls[0][0].headers['X-API-Key']).toBe('legacy-key');
      expect(mockAxios.mock.calls[0][0].headers.Authorization).toBeUndefined();
    });

    it('preserves references when the probe itself fails', async () => {
      mockAxios.mockRejectedValue(new Error('ETIMEDOUT'));
      const { service } = buildService();

      const alive = await service.checkSessionsAlive({ files: [staleFile('f3')], apiKey: 'k' });

      expect(alive.has('f3')).toBe(true);
    });

    it('preserves references when auth headers cannot be built', async () => {
      mockGetCodeApiAuthHeaders.mockRejectedValue(new Error('no tenant context'));
      const { service } = buildService();

      const alive = await service.checkSessionsAlive({ files: [staleFile('f4')], req });

      expect(alive.has('f4')).toBe(true);
      expect(mockAxios).not.toHaveBeenCalled();
    });

    it('expires references when the Code API reports the session is gone', async () => {
      const notFound = Object.assign(new Error('Request failed with status code 404'), {
        response: { status: 404 },
      });
      mockAxios.mockRejectedValue(notFound);
      const { service } = buildService();

      const alive = await service.checkSessionsAlive({ files: [staleFile('f6')], apiKey: 'k' });

      expect(alive.has('f6')).toBe(false);
    });

    it('expires a reference the probe reports as absent', async () => {
      mockAxios.mockResolvedValue({ data: [{ fileId: 'someone-else' }] });
      const { service } = buildService();

      const alive = await service.checkSessionsAlive({ files: [staleFile('f5')], apiKey: 'k' });

      expect(alive.has('f5')).toBe(false);
    });
  });
});
