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
      const file = { file_id: 'file-123', embedded: true };
      mockedAxios.delete.mockResolvedValueOnce({ status: 200 });

      const result = await deleteRagFile({ userId: 'user123', file });

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
      const file = { file_id: 'file-not-found', embedded: true };
      const error = new Error('Not Found') as Error & { response?: { status?: number } };
      error.response = { status: 404 };
      mockedAxios.delete.mockRejectedValueOnce(error);
      mockedAxios.get.mockResolvedValueOnce({ data: [] });

      const result = await deleteRagFile({ userId: 'user123', file });

      expect(result).toBe(true);
      expect(mockedAxios.get).toHaveBeenCalledWith('http://localhost:8000/ids', expect.any(Object));
    });

    it('should return false and log error on other errors', async () => {
      const file = { file_id: 'file-error', embedded: true };
      const error = new Error('Server Error') as Error & { response?: { status?: number } };
      error.response = { status: 500 };
      mockedAxios.delete.mockRejectedValueOnce(error);

      const result = await deleteRagFile({ userId: 'user123', file });

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

      const result = await deleteRagFile({ userId: 'user123', file });

      expect(result).toBe(true);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
      expect(mockedGenerateShortLivedToken).not.toHaveBeenCalled();
    });

    it('should skip RAG deletion when embedded is undefined', async () => {
      const file = { file_id: 'file-123' };

      const result = await deleteRagFile({ userId: 'user123', file });

      expect(result).toBe(true);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });
  });

  describe('when RAG_API_URL is not configured', () => {
    it('does not confirm deletion for an unconfigured store', async () => {
      delete process.env.RAG_API_URL;
      const file = { file_id: 'file-123', embedded: true };

      const result = await deleteRagFile({ userId: 'user123', file });

      expect(result).toBe(false);
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });
  });

  describe('userId handling', () => {
    it('should return false when no userId is provided', async () => {
      const file = { file_id: 'file-123', embedded: true };

      const result = await deleteRagFile({ userId: '', file });

      expect(result).toBe(false);
      expect(mockedLogger.error).toHaveBeenCalledWith('[deleteRagFile] No user ID provided');
      expect(mockedAxios.delete).not.toHaveBeenCalled();
    });

    it('should return false when userId is undefined', async () => {
      const file = { file_id: 'file-123', embedded: true };

      const result = await deleteRagFile({ userId: undefined as unknown as string, file });

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
  const file = { file_id: 'retained-file', embedded: true };
  const req = { user: { id: 'owner' } };
  const setup = (baseUrl: string | undefined = 'https://rag.example') => {
    const remove = createVectorFileDeleter({
      baseUrl,
      httpClient: axios,
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
    await expect(setup()(req, { ...file, context: 'agents' })).rejects.toThrow(
      'ownership must be recorded',
    );
    expect(mockedAxios.delete).not.toHaveBeenCalled();
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
        generateToken: () => 'token',
      });
      await expect(
        remove(req, { ...file, metadata: { embeddedEntities: entities } }),
      ).resolves.toEqual({ deleted: true });
      expect([...copies]).toEqual([]);
      expect(httpClient.delete.mock.calls.some(([, config]) => config.params == null)).toBe(true);
    },
  );

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

  it('waits for every namespace and supports retry after partial deletion', async () => {
    const scoped = { ...file, metadata: { embeddedEntities: ['agent-a', 'agent-b'] } };
    mockedAxios.delete
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce({ response: { status: 503 } });
    await expect(setup()(req, scoped)).rejects.toThrow('Vector deletion was not confirmed');
    mockedAxios.delete
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ status: 200 });
    mockedAxios.get.mockResolvedValueOnce({ data: [] });
    await expect(setup()(req, scoped)).resolves.toEqual({ deleted: true });
  });

  it('does not issue a receipt before another namespace finishes', async () => {
    let finish = () => {};
    mockedAxios.delete.mockRejectedValueOnce({ response: { status: 403 } }).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve({ status: 200 });
      }),
    );
    let settled = false;
    const deletion = setup()(req, { ...file, metadata: { embeddedEntities: ['a', 'b'] } }).catch(
      () => {
        settled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    finish();
    await deletion;
    expect(settled).toBe(true);
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
