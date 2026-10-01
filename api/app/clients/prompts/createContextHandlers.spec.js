const axios = require('axios');

jest.mock('axios');
jest.mock('@librechat/api', () => ({
  createRagContextHandlers: jest.requireActual('@librechat/api').createRagContextHandlers,
  isEnabled: jest.fn((value) => value === 'true'),
  generateShortLivedToken: jest.fn(() => 'signed-token'),
  logAxiosError: jest.fn(),
}));

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
  });
});
