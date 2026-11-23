const os = require('node:os');
const path = require('node:path');
const axios = require('axios');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { RagEmbeddingError, isDefinitiveFileStorageFailure } = require('@librechat/api');
const { uploadVectors } = require('./crud');

let directory;
let params;
const previousUrl = process.env.RAG_API_URL;

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'rag-wiring-'));
  const filepath = path.join(directory, 'notes.txt');
  await writeFile(filepath, 'notes');
  params = {
    req: { user: { id: 'user' } },
    file: { path: filepath, originalname: 'notes.txt', mimetype: 'text/plain', size: 5 },
    file_id: 'file',
  };
  process.env.RAG_API_URL = 'http://rag.test';
});

afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  if (previousUrl === undefined) delete process.env.RAG_API_URL;
  else process.env.RAG_API_URL = previousUrl;
  await rm(directory, { recursive: true, force: true });
});

it('wires a successful embedding through the real package export', async () => {
  jest.spyOn(axios, 'post').mockResolvedValueOnce({
    status: 200,
    data: { status: true, known_type: true, file_id: 'file' },
  });
  await expect(uploadVectors(params)).resolves.toMatchObject({ embedded: true, bytes: 5 });
});

it('preserves the refusal type across the CommonJS package boundary', async () => {
  jest.spyOn(axios, 'post').mockResolvedValueOnce({
    status: 200,
    data: {
      status: false,
      file_id: 'file',
      error: { code: 'RAG_EMBEDDING_REFUSED', side_effects: 'none' },
    },
  });
  const error = await uploadVectors(params).catch((error) => error);
  expect(error).toBeInstanceOf(RagEmbeddingError);
  expect(isDefinitiveFileStorageFailure(error)).toBe(true);
});

it('does not promote legacy refusal flags to proof of remote absence', async () => {
  jest.spyOn(axios, 'post').mockResolvedValueOnce({
    status: 200,
    data: { status: false, known_type: false, message: 'private-document' },
  });
  const error = await uploadVectors(params).catch((error) => error);
  expect(error.code).toBe('RAG_EMBEDDING_OUTCOME_UNKNOWN');
  expect(isDefinitiveFileStorageFailure(error)).toBe(false);
  expect(String(error)).not.toContain('private-document');
});
