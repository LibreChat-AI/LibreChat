const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  createRagContextHandlers: jest.requireActual('@librechat/api').createRagContextHandlers,
  isEnabled: jest.fn((value) => value === 'true'),
  generateShortLivedToken: jest.fn(() => 'signed-token'),
  logAxiosError: jest.fn(),
}));
jest.mock('~/models', () => ({ getAgents: jest.fn() }));

const { getAgents } = require('~/models');
const createContextHandlers = require('./createContextHandlers');

const req = { user: { id: 'user-1' } };
const file = { embedded: true, file_id: 'file-1', filename: 'notes.pdf', type: 'application/pdf' };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAG_API_URL = 'http://rag';
  delete process.env.RAG_USE_FULL_CONTEXT;
  axios.post.mockResolvedValue({ data: [] });
  axios.get.mockResolvedValue({ data: 'whole document' });
});

afterAll(() => {
  delete process.env.RAG_API_URL;
  delete process.env.RAG_USE_FULL_CONTEXT;
});

it('does not send an empty file-only message to the embeddings endpoint', async () => {
  const handlers = createContextHandlers(req, '');
  await handlers.processFile(file);

  expect(await handlers.createContext()).toBe('');
  expect(axios.post).not.toHaveBeenCalled();
});

it('still fetches context on file-only messages in full-document mode', async () => {
  process.env.RAG_USE_FULL_CONTEXT = 'true';
  const handlers = createContextHandlers(req, '');
  await handlers.processFile(file);

  expect(await handlers.createContext()).toContain('whole document');
  expect(axios.post).not.toHaveBeenCalled();
  expect(axios.get).toHaveBeenCalledWith('http://rag/documents/file-1/context', {
    headers: { Authorization: 'Bearer signed-token' },
    timeout: 30_000,
    signal: expect.any(AbortSignal),
    timeoutErrorMessage: expect.any(String),
  });
});

it('reads the agent namespace for a legacy agent file through the injected lookup', async () => {
  getAgents.mockResolvedValue([
    { id: 'agent_a', tool_resources: { file_search: { file_ids: ['file-1'] } } },
  ]);
  const handlers = createContextHandlers(req, 'what is in it?');
  await handlers.processFile({ ...file, context: 'agents' });
  await handlers.createContext();

  expect(getAgents).toHaveBeenCalledWith(
    { 'tool_resources.file_search.file_ids': { $in: ['file-1'] } },
    { id: 1, 'tool_resources.file_search.file_ids': 1 },
  );
  expect(axios.post).toHaveBeenCalledWith(
    'http://rag/query',
    { file_id: 'file-1', query: 'what is in it?', k: 4, entity_id: 'agent_a' },
    expect.any(Object),
  );
});
