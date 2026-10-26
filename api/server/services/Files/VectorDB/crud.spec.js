const axios = require('axios');
const { logger } = require('@librechat/data-schemas');

jest.mock('axios');
/* Only the boundary helpers are stubbed. `createVectorFileDeleter` is the code
 * under test, so it comes from the real module. */
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  logAxiosError: jest.fn(({ message }) => message),
  generateShortLivedToken: jest.fn(() => 'jwt-token'),
}));

const { deleteVectors } = require('./crud');

const RAG_API_URL = 'http://rag.test';
const AGENT = 'agent-abc';

const req = { user: { id: 'user-1' } };
const entityOwnedFile = {
  file_id: 'file-agent',
  embedded: true,
  metadata: { embeddedEntities: [AGENT] },
};
const userOwnedFile = { file_id: 'file-user', embedded: true };

/** The shape rag_api answers when a delete's scope matched nothing. */
const httpError = (status) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { detail: 'One or more IDs not found' } },
  });

/** Connection refused: no response at all, so nothing proves the chunks went. */
const transportError = () => Object.assign(new Error('connect ECONNREFUSED'), { request: {} });

describe('deleteVectors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RAG_API_URL = RAG_API_URL;
    axios.delete.mockResolvedValue({ status: 200, data: {} });
  });

  afterEach(() => {
    delete process.env.RAG_API_URL;
  });

  const requestConfig = () => axios.delete.mock.calls[0][1];

  describe('the entity scope the delete carries', () => {
    test('sends the entity recorded in metadata.embeddedEntities as the entity_id query parameter', async () => {
      await deleteVectors(req, entityOwnedFile);

      expect(axios.delete).toHaveBeenCalledWith(`${RAG_API_URL}/documents`, expect.any(Object));
      expect(requestConfig().params).toEqual({ entity_id: AGENT });
    });

    test('sends no entity_id at all for a file that records no owning entity', async () => {
      await deleteVectors(req, userOwnedFile);

      expect(requestConfig().params).toBeUndefined();
    });

    test('carries the entity in the query string, leaving the request body the bare id array', async () => {
      /* Invariant 7: an older rag_api ignores an unrecognised query parameter,
       * so a new client stays inert against it. A body change would not. */
      await deleteVectors(req, entityOwnedFile);

      expect(requestConfig().data).toEqual([entityOwnedFile.file_id]);
    });

    test('leaves a non-entity delete byte-identical to the request sent before this change', async () => {
      await deleteVectors(req, userOwnedFile);

      expect(axios.delete).toHaveBeenCalledWith(`${RAG_API_URL}/documents`, {
        headers: {
          Authorization: 'Bearer jwt-token',
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        data: [userOwnedFile.file_id],
      });
    });
  });

  describe('what counts as a successful delete', () => {
    test('rejects when an entity-scoped delete answers 404, because the chunks are still there', async () => {
      axios.delete.mockRejectedValue(httpError(404));

      await expect(deleteVectors(req, entityOwnedFile)).rejects.toThrow();
    });

    test('rejects when an entity-scoped delete never reaches the service', async () => {
      axios.delete.mockRejectedValue(transportError());

      await expect(deleteVectors(req, entityOwnedFile)).rejects.toThrow();
    });

    test('still tolerates a 404 for a file that records no owning entity', async () => {
      axios.delete.mockRejectedValue(httpError(404));

      /* A deletion receipt, not `undefined`: the shared deleter reports one on
       * every path it treats as removed. */
      await expect(deleteVectors(req, userOwnedFile)).resolves.toEqual({ deleted: true });
    });

    test('propagates a transport failure for a file that records no owning entity', async () => {
      /* Tolerated before the delete moved into the shared deleter, which now
       * refuses to call an unanswered request a removed copy. Nothing proves
       * these chunks went, so the caller hears about it. */
      axios.delete.mockRejectedValue(transportError());

      await expect(deleteVectors(req, userOwnedFile)).rejects.toThrow();
    });

    test('still rejects a 500 for a file that records no owning entity', async () => {
      axios.delete.mockRejectedValue(httpError(500));

      await expect(deleteVectors(req, userOwnedFile)).rejects.toThrow();
    });

    test('names the file and its entity scope in the log before it throws', async () => {
      /* The bug was invisible for as long as the failure was silent. */
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      axios.delete.mockRejectedValue(httpError(404));

      await expect(deleteVectors(req, entityOwnedFile)).rejects.toThrow();

      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).toContain(entityOwnedFile.file_id);
      expect(logged).toContain(AGENT);
      warn.mockRestore();
    });

    test('names the file in the log before it throws for a file with no entity', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      axios.delete.mockRejectedValue(httpError(500));

      await expect(deleteVectors(req, userOwnedFile)).rejects.toThrow();

      const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
      /* Names the file and claims no entity scope, because none was sent. */
      expect(logged).toContain(`file ${userOwnedFile.file_id}; its embedded chunks may remain`);
      expect(logged).not.toContain(AGENT);
      warn.mockRestore();
    });

    test('propagates the original failure even when it carries no message', async () => {
      /* The shared deleter rethrows the error it caught rather than wrapping
       * it, so the caller keeps the response and the stack. */
      const bare = Object.assign(new Error(''), { response: { status: 404 } });
      axios.delete.mockRejectedValue(bare);

      await expect(deleteVectors(req, entityOwnedFile)).rejects.toBe(bare);
    });

    test('rejects a failure that carries a success status', async () => {
      /* Only an interceptor can reject a 2xx. That used to be read as someone
       * else's failure and swallowed; the shared deleter has no such carve-out,
       * and an unexplained rejection is no evidence the chunks went. */
      axios.delete.mockRejectedValue(httpError(200));

      await expect(deleteVectors(req, entityOwnedFile)).rejects.toThrow();
      await expect(deleteVectors(req, userOwnedFile)).rejects.toThrow();
    });

    test('treats 300 as a failure for an entity-owned file, not a success', async () => {
      axios.delete.mockRejectedValue(httpError(300));

      await expect(deleteVectors(req, entityOwnedFile)).rejects.toThrow();
    });
  });

  describe('a record shared by several entities', () => {
    const OTHER = 'agent-def';
    const sharedFile = {
      file_id: 'file-shared',
      embedded: true,
      metadata: { embeddedEntities: [AGENT, OTHER] },
    };

    test('sends one scoped delete per recorded entity', async () => {
      await deleteVectors(req, sharedFile);

      const sent = axios.delete.mock.calls.map(([, config]) => config.params);
      expect(sent).toEqual([{ entity_id: AGENT }, { entity_id: OTHER }]);
    });

    test('sends a duplicated entity once', async () => {
      await deleteVectors(req, {
        ...sharedFile,
        metadata: { embeddedEntities: [AGENT, AGENT] },
      });

      expect(axios.delete).toHaveBeenCalledTimes(1);
    });

    test('still attempts every entity when one of them fails, then rejects', async () => {
      axios.delete.mockRejectedValueOnce(httpError(500)).mockResolvedValue({ status: 200 });

      await expect(deleteVectors(req, sharedFile)).rejects.toThrow();
      expect(axios.delete).toHaveBeenCalledTimes(2);
    });

    test('rejects when only the second entity answers 404', async () => {
      axios.delete.mockResolvedValueOnce({ status: 200 }).mockRejectedValueOnce(httpError(404));

      await expect(deleteVectors(req, sharedFile)).rejects.toThrow();
    });

    test('rejects a malformed record rather than reporting the vectors removed', async () => {
      await expect(
        deleteVectors(req, { file_id: 'f', embedded: true, metadata: { embeddedEntities: [1] } }),
      ).rejects.toThrow();
      expect(axios.delete).not.toHaveBeenCalled();
    });

    test('treats an empty recorded set as a user-owned file', async () => {
      axios.delete.mockRejectedValue(httpError(404));

      await expect(
        deleteVectors(req, { file_id: 'f', embedded: true, metadata: { embeddedEntities: [] } }),
      ).resolves.toEqual({ deleted: true });
    });
  });

  describe('when there is nothing embedded to delete', () => {
    test('makes no request for a file that was never embedded', async () => {
      await deleteVectors(req, {
        file_id: 'file-plain',
        embedded: false,
        metadata: { embeddedEntities: [AGENT] },
      });

      expect(axios.delete).not.toHaveBeenCalled();
    });

    test('makes no request when no vector service is configured', async () => {
      delete process.env.RAG_API_URL;

      await deleteVectors(req, entityOwnedFile);

      expect(axios.delete).not.toHaveBeenCalled();
    });
  });
});
