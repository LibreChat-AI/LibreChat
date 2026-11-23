import os from 'node:os';
import path from 'node:path';
import FormData from 'form-data';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { AxiosInstance } from 'axios';
import { isDefinitiveFileStorageFailure } from '../operations';
import { createVectorFileUploader } from './upload';
import { RagEmbeddingError } from './errors';

let directory: string;
let file: { path: string; originalname: string; size: number; mimetype: string };
const fileId = 'file';
const receipt = {
  status: false,
  file_id: fileId,
  error: { code: 'RAG_EMBEDDING_REFUSED', side_effects: 'none' },
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'rag-upload-'));
  file = {
    path: path.join(directory, 'notes.txt'),
    originalname: 'notes.txt',
    size: 5,
    mimetype: 'text/plain',
  };
  await writeFile(file.path, 'notes');
});
afterAll(async () => rm(directory, { recursive: true, force: true }));

function setup(data: unknown, status = 200) {
  const post = jest.fn().mockResolvedValue({ status, data });
  const generateToken = jest.fn(() => 'test-token');
  const upload = createVectorFileUploader({
    baseUrl: 'http://rag.test',
    httpClient: { post } as Pick<AxiosInstance, 'post'>,
    generateToken,
  });
  const onUploadStart = jest.fn();
  const params = { req: { user: { id: 'user' } }, file, file_id: fileId, onUploadStart };
  return { post, generateToken, upload, params, onUploadStart };
}

it('preserves successful embedding, multipart fields and cancellation', async () => {
  const { upload, params, post, generateToken, onUploadStart } = setup({
    status: true,
    known_type: true,
    file_id: fileId,
  });
  const signal = new AbortController().signal;
  await expect(
    upload({ ...params, entity_id: 'agent', storageMetadata: { source: 'local' }, signal }),
  ).resolves.toEqual({ bytes: 5, filename: 'notes.txt', filepath: 'vectordb', embedded: true });
  expect(generateToken).toHaveBeenCalledWith('user');
  expect(post).toHaveBeenCalledWith(
    'http://rag.test/embed',
    expect.any(FormData),
    expect.objectContaining({
      signal,
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    }),
  );
  expect(onUploadStart.mock.calls).toEqual([[]]);
});

it('recognizes only a request-matched no-side-effect refusal receipt', async () => {
  const { upload, params, onUploadStart } = setup(receipt);
  const error = await upload(params).catch((error: Error) => error);
  expect(error).toBeInstanceOf(RagEmbeddingError);
  expect(error).toMatchObject({ code: 'RAG_EMBEDDING_REFUSED' });
  expect(isDefinitiveFileStorageFailure(error)).toBe(true);
  expect(onUploadStart.mock.calls).toEqual([[], ['rejected']]);
});

it.each([
  null,
  undefined,
  '',
  [],
  {},
  { status: true },
  { status: 1, known_type: true },
  { status: true, known_type: 'true' },
  { status: true, known_type: false },
  { status: false, known_type: true },
  { status: false, known_type: false },
  { status: false, message: 'RAG_EMBEDDING_REFUSED side_effects none' },
  { ...receipt, file_id: 'another-file' },
  { ...receipt, file_id: undefined },
  { ...receipt, status: true },
  { ...receipt, error: { code: 'RAG_EMBEDDING_REFUSED' } },
  { ...receipt, error: { code: 'RAG_EMBEDDING_REFUSED', side_effects: 'unknown' } },
  { ...receipt, error: { code: 'other', side_effects: 'none' } },
  { status: true, known_type: true, error: receipt.error },
  { status: true, known_type: true, file_id: 'another-file' },
])('retains uncertainty for a legacy, contradictory or malformed response: %j', async (data) => {
  const { upload, params, onUploadStart } = setup(data);
  const error = await upload(params).catch((error: Error) => error);
  expect(error).toMatchObject({ code: 'RAG_EMBEDDING_OUTCOME_UNKNOWN' });
  expect(isDefinitiveFileStorageFailure(error)).toBe(false);
  expect(onUploadStart.mock.calls).toEqual([[]]);
});

it.each([
  { code: 'ETIMEDOUT' },
  { code: 'ECONNRESET' },
  { code: 'ERR_CANCELED' },
  { response: { status: 400 } },
  { response: { status: 422 } },
  { response: { status: 500 } },
  { code: 'RAG_EMBEDDING_REFUSED' },
])('never infers remote absence from a rejected request: %j', async (details) => {
  const { upload, params, post, onUploadStart } = setup(undefined);
  const secret = 'private-document SQL bearer-test-token';
  post.mockRejectedValueOnce(Object.assign(new Error(secret), details));
  const error = await upload(params).catch((error: Error) => error);
  expect(error).toMatchObject({ code: 'RAG_EMBEDDING_OUTCOME_UNKNOWN' });
  expect(error).not.toHaveProperty('cause');
  expect(String(error)).not.toContain(secret);
  expect(isDefinitiveFileStorageFailure(error)).toBe(false);
  expect(onUploadStart.mock.calls).toEqual([[]]);
});

it('does not trust a no-side-effect body outside a successful HTTP response', async () => {
  const { upload, params } = setup(receipt, 500);
  await expect(upload(params)).rejects.toMatchObject({ code: 'RAG_EMBEDDING_OUTCOME_UNKNOWN' });
});

it.each([undefined, NaN, '200', 199, 300, 400, 422, 500])(
  'rejects a non-success or malformed HTTP status without releasing the claim: %j',
  async (status) => {
    const { upload, params, post } = setup(receipt);
    post.mockResolvedValueOnce({ status, data: receipt });
    await expect(upload(params)).rejects.toMatchObject({ code: 'RAG_EMBEDDING_OUTCOME_UNKNOWN' });
  },
);

it('sanitizes credential setup failures before dispatch', async () => {
  const { upload, params, generateToken, post, onUploadStart } = setup(receipt);
  generateToken.mockImplementationOnce(() => {
    throw new Error('private-signing-key');
  });
  const error = await upload(params).catch((error: Error) => error);
  expect(error).toMatchObject({ code: 'RAG_EMBEDDING_OUTCOME_UNKNOWN' });
  expect(String(error)).not.toContain('private-signing-key');
  expect(error).not.toHaveProperty('cause');
  expect(post).not.toHaveBeenCalled();
  expect(onUploadStart).not.toHaveBeenCalled();
});
