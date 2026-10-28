jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('~/crypto/jwt', () => ({
  generateShortLivedToken: jest.fn().mockReturnValue('mock-jwt-token'),
}));

jest.mock('axios', () => ({
  delete: jest.fn(),
  get: jest.fn(),
  post: jest.fn(),
  interceptors: {
    request: { use: jest.fn(), eject: jest.fn() },
    response: { use: jest.fn(), eject: jest.fn() },
  },
}));

import axios from 'axios';
import { deleteRagFile, hasEntityEmbeddings, createVectorFileDeleter } from './rag';
import { logger } from '@librechat/data-schemas';
import { generateShortLivedToken } from '~/crypto/jwt';

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedGenerateShortLivedToken = generateShortLivedToken as jest.MockedFunction<
  typeof generateShortLivedToken
>;

describe('deleteRagFile', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.RAG_API_URL = 'http://localhost:8000';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('when file is embedded and RAG_API_URL is configured', () => {
    it('should delete the document from RAG API successfully', async () => {
      const file = {
        file_id: 'file-123',
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
      };
      mockedAxios.delete.mockResolvedValueOnce({ status: 200 });

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: 'user123',
        file,
      });

      expect(result).toBe(true);
      expect(mockedGenerateShortLivedToken).toHaveBeenCalledWith('user123');
      expect(mockedAxios.delete).toHaveBeenCalledWith('http://localhost:8000/documents', {
        headers: {
          Authorization: 'Bearer mock-jwt-token',
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        data: ['file-123'],
      });
    });

    it('confirms absence through inventory rather than trusting a 404', async () => {
      const file = {
        file_id: 'file-not-found',
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
      };
      const error = new Error('Not Found') as Error & { response?: { status?: number } };
      error.response = { status: 404 };
      mockedAxios.delete.mockRejectedValueOnce(error);
      mockedAxios.get.mockResolvedValueOnce({ data: [] });

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: 'user123',
        file,
      });

      expect(result).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledWith('http://localhost:8000/ids', expect.any(Object));
    });

    it('should return false and log error on other errors', async () => {
      const file = {
        file_id: 'file-error',
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
      };
      const error = new Error('Server Error') as Error & { response?: { status?: number } };
      error.response = { status: 500 };
      mockedAxios.delete.mockRejectedValueOnce(error);

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: 'user123',
        file,
      });

      expect(result).toBe(false);
      expect(mockedLogger.error).toHaveBeenCalledWith(
        '[deleteRagFile] Vector deletion was not confirmed',
        { type: 'Error' },
      );
    });
  });

  describe('when file is not embedded', () => {
    it('should skip RAG deletion and return true', async () => {
      const file = { file_id: 'file-123', embedded: false };

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: 'user123',
        file,
      });

      expect(result).toBe(true);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
      expect(mockedGenerateShortLivedToken).not.toHaveBeenCalled();
    });

    it('should skip RAG deletion when embedded is undefined', async () => {
      const file = { file_id: 'file-123' };

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: 'user123',
        file,
      });

      expect(result).toBe(true);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });
  });

  describe('when RAG_API_URL is not configured', () => {
    it('does not confirm deletion for an unconfigured store', async () => {
      delete process.env.RAG_API_URL;
      const file = {
        file_id: 'file-123',
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
      };

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: 'user123',
        file,
      });

      expect(result).toBe(false);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });
  });

  describe('userId handling', () => {
    it('should return false when no userId is provided', async () => {
      const file = {
        file_id: 'file-123',
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
      };

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: '',
        file,
      });

      expect(result).toBe(false);
      expect(mockedLogger.error).toHaveBeenCalledWith('[deleteRagFile] No user ID provided');
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });

    it('should return false when userId is undefined', async () => {
      const file = {
        file_id: 'file-123',
        embedded: true,
        embeddingOwnersComplete: true,
        embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
      };

      const result = await deleteRagFile({
        fileConfig: { vectorOwnershipTrackingStart: '2026-10-19T00:00:00.000Z' },
        userId: undefined as unknown as string,
        file,
      });

      expect(result).toBe(false);
      expect(mockedLogger.error).toHaveBeenCalledWith('[deleteRagFile] No user ID provided');
    });
  });
});

describe('hasEntityEmbeddings', () => {
  const originalEnv = process.env;
  const params = { userId: 'user1', file_id: 'file1', entity_id: 'agent1', query: 'notes.pdf' };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, RAG_API_URL: 'http://localhost:8000' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('asks RAG for chunks of the file under the entity', async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: [[{ page_content: 'x', metadata: { user_id: 'agent1' } }, 0.1]],
    });

    await expect(hasEntityEmbeddings(params)).resolves.toBe(true);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://localhost:8000/query',
      { file_id: 'file1', query: 'notes.pdf', k: 10, entity_id: 'agent1' },
      {
        headers: {
          Authorization: 'Bearer mock-jwt-token',
          'Content-Type': 'application/json',
        },
      },
    );
  });

  it("ignores chunks RAG returns because they are the requesting user's own", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: [[{ page_content: 'x', metadata: { user_id: 'user1' } }, 0.1]],
    });

    await expect(hasEntityEmbeddings(params)).resolves.toBe(false);
  });

  it("finds the entity's chunks behind a requesting user's copy of the file", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      data: [
        [{ page_content: 'x', metadata: { user_id: 'user1' } }, 0.1],
        [{ page_content: 'x', metadata: { user_id: 'agent1' } }, 0.1],
      ],
    });

    await expect(hasEntityEmbeddings(params)).resolves.toBe(true);
  });

  it('reports no embeddings when RAG returns no chunks', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: [] });

    await expect(hasEntityEmbeddings(params)).resolves.toBe(false);
  });

  it('passes the timeout to the request', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: [] });

    await hasEntityEmbeddings({ ...params, timeoutMs: 1234 });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ timeout: 1234 }),
    );
  });

  it('rejects when RAG cannot be asked', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(hasEntityEmbeddings(params)).rejects.toThrow('connect ECONNREFUSED');
  });

  it('reports no embeddings without asking when RAG is not configured', async () => {
    delete process.env.RAG_API_URL;

    await expect(hasEntityEmbeddings(params)).resolves.toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('createVectorFileDeleter receipts', () => {
  beforeEach(() => jest.clearAllMocks());
  const file = {
    file_id: 'retained-file',
    embedded: true,
    embeddingOwnersComplete: true,
    embeddingOwnersTrackedAt: '2026-10-20T00:00:00.000Z',
  };
  const req = { user: { id: 'owner' } };
  const setup = (baseUrl: string | undefined = 'https://rag.example') => {
    const remove = createVectorFileDeleter({
      baseUrl,
      httpClient: axios,
      ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
      generateToken: () => 'test-token',
    });
    return remove;
  };

  it('returns a receipt only after a confirmed delete', async () => {
    mockedAxios.delete.mockResolvedValueOnce({ status: 200 });
    expect(await setup()(req, file)).toEqual({ deleted: true });
    expect(mockedAxios.delete).toHaveBeenCalledWith(
      'https://rag.example/documents',
      expect.objectContaining({ data: ['retained-file'] }),
    );
  });

  it('confirms an already absent vector copy through inventory', async () => {
    mockedAxios.delete.mockRejectedValueOnce({
      code: 'ERR_BAD_REQUEST',
      response: { status: 404 },
    });
    mockedAxios.get.mockResolvedValueOnce({ data: [] });
    expect(await setup()(req, file)).toEqual({ deleted: true });
  });

  it('keeps legacy agent files until their embedding ownership has been recovered', async () => {
    await expect(
      setup()(req, { ...file, context: 'agents', embeddingOwnersComplete: undefined }),
    ).rejects.toThrow('ownership must be recorded');
    expect(mockedAxios.delete).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    'rejects partially adopted legacy ownership (%s)',
    async (embeddingOwnersComplete) => {
      const legacy = {
        ...file,
        context: 'agents',
        embeddingOwnersComplete,
        metadata: { embeddedEntities: ['agent-a'] },
      };
      await expect(setup()(req, legacy)).rejects.toThrow('Complete vector ownership');
      expect(mockedAxios.delete).not.toHaveBeenCalled();
      expect(mockedAxios.get).not.toHaveBeenCalled();
    },
  );

  it.each([
    { cutoff: undefined, tracked: '2026-10-20T00:00:00.000Z' },
    { cutoff: '2026-10-21T00:00:00.000Z', tracked: '2026-10-20T00:00:00.000Z' },
    { cutoff: '2026-10-19T00:00:00.000Z', tracked: undefined },
    { cutoff: '2026-10-19T00:00:00.000Z', tracked: 'bad-date' },
    { cutoff: '2999-01-01T00:00:00.000Z', tracked: '2026-10-20T00:00:00.000Z' },
    { cutoff: '2026-10-19T00:00:00.000Z', tracked: '2999-01-01T00:00:00.000Z' },
  ])('retains old-writer damage or inactive rollout: %j', async ({ cutoff, tracked }) => {
    const remove = createVectorFileDeleter({
      baseUrl: 'https://rag.example',
      httpClient: axios,
      generateToken: () => 'token',
      ownershipTrackingStart: cutoff,
    });
    const damaged = {
      ...file,
      embeddingOwnersTrackedAt: tracked,
      metadata: { embeddedEntities: ['agent-a'] },
    };
    await expect(remove(req, damaged)).rejects.toThrow('safe writer rollout');
    expect(mockedAxios.delete).not.toHaveBeenCalled();
  });

  it('does not apply the deployment cutoff to an unrecorded upload rollback', async () => {
    const remove = createVectorFileDeleter({
      baseUrl: 'https://rag.example',
      httpClient: axios,
      generateToken: () => 'token',
    });
    mockedAxios.delete.mockResolvedValueOnce({ status: 200 });
    await expect(
      remove(req, { ...file, unrecordedUpload: true, embeddingOwnersTrackedAt: undefined }),
    ).resolves.toEqual({ deleted: true });
  });

  it('deletes every recorded namespace once, using the authenticated principal', async () => {
    mockedAxios.delete.mockResolvedValue({ status: 200 });
    const scoped = {
      ...file,
      user: 'untrusted-owner',
      metadata: { embeddedEntities: ['agent-a', 'agent-b', 'agent-a', 'owner'] },
    };
    await expect(setup()(req, scoped)).resolves.toEqual({ deleted: true });
    expect(mockedAxios.delete).toHaveBeenCalledTimes(4);
    for (const entity_id of ['agent-a', 'agent-b', 'owner']) {
      expect(mockedAxios.delete).toHaveBeenCalledWith(
        'https://rag.example/documents',
        expect.objectContaining({
          params: { entity_id },
          data: [file.file_id],
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        }),
      );
    }
  });

  it.each([
    { entities: ['owner'], owners: ['public'] },
    { entities: ['agent-a', 'agent-b'], owners: ['public', 'agent-a', 'agent-b'] },
  ])(
    'erases implicit public embeddings alongside recorded namespaces: $entities',
    async ({ entities, owners }) => {
      const copies = new Set(owners);
      const httpClient = {
        delete: jest
          .fn()
          .mockImplementation(async (_url: string, config: { params?: { entity_id: string } }) => {
            const owner = config.params?.entity_id ?? 'public';
            if (!copies.delete(owner))
              throw Object.assign(new Error('Document absent from scope'), {
                response: { status: 404 },
              });
            return { status: 200 };
          }),
        get: jest
          .fn()
          .mockImplementation(async (_url: string, config: { params?: { entity_id: string } }) => ({
            data: copies.has(config.params?.entity_id ?? 'public') ? [file.file_id] : [],
          })),
      };
      const remove = createVectorFileDeleter({
        baseUrl: 'https://rag.example',
        httpClient,
        ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
        generateToken: () => 'token',
      });
      await expect(
        remove(req, { ...file, metadata: { embeddedEntities: entities } }),
      ).resolves.toEqual({ deleted: true });
      expect([...copies]).toEqual([]);
      expect(httpClient.delete.mock.calls.some(([, config]) => config.params == null)).toBe(true);
    },
  );

  it('mints credentials at dispatch so a queue longer than token TTL still converges', async () => {
    let clock = 0;
    const owners = Array.from({ length: 20 }, (_, index) => `agent-${index}`);
    const copies = new Set([...owners, 'public']);
    let rejected = 0;
    const generateToken = jest.fn(() => String(clock));
    const httpClient = {
      delete: jest
        .fn()
        .mockImplementation(
          async (
            _url: string,
            config: { headers: { Authorization: string }; params?: { entity_id: string } },
          ) => {
            if (clock - Number(config.headers.Authorization.slice(7)) >= 300_000) {
              rejected++;
              throw Object.assign(new Error('expired token'), { response: { status: 401 } });
            }
            clock += 20_000;
            copies.delete(config.params?.entity_id ?? 'public');
            return { status: 200 };
          },
        ),
      get: jest.fn(),
    };
    const erase = createVectorFileDeleter({
      baseUrl: 'https://rag.example',
      httpClient,
      generateToken,
      namespaceConcurrency: 1,
      ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
    });
    await expect(erase(req, { ...file, metadata: { embeddedEntities: owners } })).resolves.toEqual({
      deleted: true,
    });
    expect(clock).toBeGreaterThan(300_000);
    expect(rejected).toBe(0);
    expect(copies.size).toBe(0);
    expect(generateToken).toHaveBeenCalledTimes(21);
  });

  it('renews credentials for inventory when the DELETE outlives its token', async () => {
    let clock = 0;
    const generateToken = jest.fn(() => String(clock));
    const httpClient = {
      delete: jest.fn().mockImplementation(async () => {
        clock += 301_000;
        throw Object.assign(new Error('already erased'), { response: { status: 404 } });
      }),
      get: jest
        .fn()
        .mockImplementation(
          async (_url: string, config: { headers: { Authorization: string } }) => {
            expect(config.headers.Authorization).toBe(`Bearer ${clock}`);
            return { data: [] };
          },
        ),
    };
    const erase = createVectorFileDeleter({
      baseUrl: 'https://rag.example',
      httpClient,
      generateToken,
      ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
    });
    await expect(erase(req, file)).resolves.toEqual({ deleted: true });
    expect(generateToken).toHaveBeenCalledTimes(2);
  });

  it('does not mistake a wrong-namespace 404 for erasure', async () => {
    mockedAxios.delete.mockRejectedValueOnce({ response: { status: 404 } });
    mockedAxios.get.mockResolvedValueOnce({ data: [file.file_id] });
    const scoped = { ...file, metadata: { embeddedEntities: ['agent-a'] } };
    await expect(setup()(req, scoped)).rejects.toThrow('Vector deletion was not confirmed');
    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://rag.example/ids',
      expect.objectContaining({ params: { entity_id: 'agent-a' } }),
    );
  });

  it.each([undefined, {}, { ids: [] }, [1]])(
    'rejects an invalid inventory response: %j',
    async (data) => {
      mockedAxios.delete.mockRejectedValueOnce({ response: { status: 404 } });
      mockedAxios.get.mockResolvedValueOnce({ data });
      await expect(setup()(req, file)).rejects.toThrow('Vector deletion was not confirmed');
    },
  );

  it('retains failure when the inventory check is unavailable', async () => {
    mockedAxios.delete.mockRejectedValueOnce({ response: { status: 404 } });
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });
    const error = await setup()(req, file).catch((error) => error);
    expect(error.message).toBe('Vector deletion was not confirmed');
    expect(error.response).toBeUndefined();
  });

  describe('namespace concurrency', () => {
    const entities = Array.from({ length: 32 }, (_, index) => `agent-${index}`);
    const scoped = { ...file, metadata: { embeddedEntities: entities } };
    type NamespaceConfig = { params?: { entity_id: string } };
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };

    it.each([0, -1, 1.5, Infinity, NaN])(
      'rejects invalid concurrency at factory creation: %s',
      (namespaceConcurrency) => {
        expect(() =>
          createVectorFileDeleter({
            baseUrl: 'https://rag.example',
            httpClient: axios,
            ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
            generateToken: () => 'token',
            namespaceConcurrency,
          }),
        ).toThrow('positive integer');
        expect(mockedAxios.delete).not.toHaveBeenCalled();
        expect(mockedAxios.get).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, 1, 3, 16])(
      'bounds DELETE and inventory requests until every namespace settles: %s',
      async (namespaceConcurrency) => {
        const concurrency = namespaceConcurrency ?? 4;
        const copies = new Set<string>();
        const deletesStarted = deferred();
        const inventoriesStarted = deferred();
        const finishDeletes = deferred();
        const finishInventories = deferred();
        let active = 0;
        let peak = 0;
        let deletes = 0;
        let inventories = 0;
        let settled = false;
        const start = () => {
          active++;
          peak = Math.max(peak, active);
        };
        const httpClient = {
          delete: jest.fn().mockImplementation(async (_url: string, config: NamespaceConfig) => {
            start();
            if (++deletes === concurrency) deletesStarted.resolve();
            try {
              await finishDeletes.promise;
              if (!copies.delete(config.params?.entity_id ?? 'public')) {
                throw { response: { status: 404 } };
              }
              return { status: 200 };
            } finally {
              active--;
            }
          }),
          get: jest.fn().mockImplementation(async (_url: string, config: NamespaceConfig) => {
            start();
            if (++inventories === concurrency) inventoriesStarted.resolve();
            try {
              await finishInventories.promise;
              return {
                data: copies.has(config.params?.entity_id ?? 'public') ? [file.file_id] : [],
              };
            } finally {
              active--;
            }
          }),
        };
        const remove = createVectorFileDeleter({
          baseUrl: 'https://rag.example',
          httpClient,
          ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
          generateToken: () => 'token',
          namespaceConcurrency,
        });
        const deletion = remove(req, scoped).then((receipt) => {
          settled = true;
          return receipt;
        });
        try {
          await deletesStarted.promise;
          expect(active).toBe(concurrency);
          expect(httpClient.delete).toHaveBeenCalledTimes(concurrency);
          finishDeletes.resolve();
          await inventoriesStarted.promise;
          expect(active).toBe(concurrency);
          expect(httpClient.delete).toHaveBeenCalledTimes(concurrency);
          expect(httpClient.get).toHaveBeenCalledTimes(concurrency);
          expect(settled).toBe(false);
        } finally {
          finishDeletes.resolve();
          finishInventories.resolve();
        }
        await expect(deletion).resolves.toEqual({ deleted: true });
        expect(httpClient.delete).toHaveBeenCalledTimes(entities.length + 1);
        expect(httpClient.get).toHaveBeenCalledTimes(entities.length + 1);
        expect(peak).toBe(concurrency);
        expect(active).toBe(0);
      },
    );

    it('shares the bound across deletions from the same factory', async () => {
      const started = deferred();
      const finish = deferred();
      let active = 0;
      let peak = 0;
      const httpClient = {
        delete: jest.fn().mockImplementation(async () => {
          active++;
          peak = Math.max(peak, active);
          if (active === 2) started.resolve();
          try {
            await finish.promise;
            return { status: 200 };
          } finally {
            active--;
          }
        }),
        get: jest.fn(),
      };
      const remove = createVectorFileDeleter({
        baseUrl: 'https://rag.example',
        httpClient,
        ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
        generateToken: () => 'token',
        namespaceConcurrency: 2,
      });
      const deletions = Promise.all([
        remove(req, scoped),
        remove(req, { ...scoped, file_id: 'other-file' }),
      ]);
      try {
        await started.promise;
        expect(httpClient.delete).toHaveBeenCalledTimes(2);
      } finally {
        finish.resolve();
      }
      await expect(deletions).resolves.toEqual([{ deleted: true }, { deleted: true }]);
      expect(httpClient.delete).toHaveBeenCalledTimes((entities.length + 1) * 2);
      expect(peak).toBe(2);
      expect(active).toBe(0);
    });

    it('waits after partial failure and converges on retry through verified 404s', async () => {
      const copies = new Set(entities);
      const inventoryStarted = deferred();
      const finishInventory = deferred();
      const secret = 'private-provider-token';
      let fail = true;
      let settled = false;
      const httpClient = {
        delete: jest.fn().mockImplementation(async (_url: string, config: NamespaceConfig) => {
          const owner = config.params?.entity_id ?? 'public';
          if (owner === entities[1] && fail) {
            throw Object.assign(new Error(secret), {
              response: { status: 503, data: secret },
            });
          }
          if (!copies.delete(owner)) throw { response: { status: 404 } };
          return { status: 200 };
        }),
        get: jest.fn().mockImplementation(async (_url: string, config: NamespaceConfig) => {
          const owner = config.params?.entity_id ?? 'public';
          if (owner === 'public') {
            inventoryStarted.resolve();
            await finishInventory.promise;
          }
          return { data: copies.has(owner) ? [file.file_id] : [] };
        }),
      };
      const remove = createVectorFileDeleter({
        baseUrl: 'https://rag.example',
        httpClient,
        ownershipTrackingStart: '2026-10-19T00:00:00.000Z',
        generateToken: () => 'token',
        namespaceConcurrency: 3,
      });
      const deletion = remove(req, scoped).then(
        (receipt) => {
          settled = true;
          return receipt;
        },
        (error: Error) => {
          settled = true;
          return error;
        },
      );
      try {
        await inventoryStarted.promise;
        expect(httpClient.delete).toHaveBeenCalledTimes(entities.length + 1);
        expect(settled).toBe(false);
      } finally {
        finishInventory.resolve();
      }
      const failure = await deletion;
      expect(failure).toBeInstanceOf(Error);
      expect(failure).toMatchObject({ message: 'Vector deletion was not confirmed' });
      expect(failure).not.toHaveProperty('response');
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect([...copies]).toEqual([entities[1]]);

      fail = false;
      httpClient.delete.mockClear();
      httpClient.get.mockClear();
      await expect(remove(req, scoped)).resolves.toEqual({ deleted: true });
      expect([...copies]).toEqual([]);
      expect(httpClient.delete).toHaveBeenCalledTimes(entities.length + 1);
      expect(httpClient.get).toHaveBeenCalledTimes(entities.length);
    });
  });

  it('does not issue a receipt for an unconfigured store or a non-embedded file', async () => {
    expect(await setup('')(req, file)).toBeUndefined();
    expect(await setup()(req, { ...file, embedded: false })).toBeUndefined();
  });

  it.each([
    new Error('network down'),
    { response: { status: 403 } },
    { response: { status: 500 } },
  ])('propagates failed requests without a deletion receipt', async (error) => {
    mockedAxios.delete.mockRejectedValueOnce(error);
    await expect(setup()(req, file)).rejects.toThrow('Vector deletion was not confirmed');
  });
});
