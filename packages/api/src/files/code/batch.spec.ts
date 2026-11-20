import axios from 'axios';
import { createServer } from 'node:http';
import { buffer } from 'node:stream/consumers';
import type { AddressInfo } from 'node:net';
import {
  planCodeUploadBatches,
  uploadCodeEnvBatch,
  CODE_UPLOAD_BATCH_MAX_BYTES,
  CODE_UPLOAD_BATCH_MAX_FILES,
} from './batch';

describe('planCodeUploadBatches', () => {
  const sizeOf = (size: number | undefined) => size;

  it('packs in order up to the file and byte limits', () => {
    const limits = { maxFiles: 3, maxBytes: 10 };
    expect(planCodeUploadBatches([1, 2, 3, 4, 5, 6, 7], sizeOf, limits)).toEqual({
      batches: [[1, 2, 3], [4, 5], [6], [7]],
      streamed: [],
    });
    expect(planCodeUploadBatches([10, 1, 9, 1], sizeOf, limits).batches).toEqual([
      [10],
      [1, 9],
      [1],
    ]);
  });

  it('streams files it cannot size or hold in memory', () => {
    expect(
      planCodeUploadBatches([4, undefined, 11, Number.NaN, -1, 5], sizeOf, {
        maxFiles: 3,
        maxBytes: 10,
      }),
    ).toEqual({ batches: [[4, 5]], streamed: [undefined, 11, Number.NaN, -1] });
  });

  it('stays inside what one Code API request accepts by default', () => {
    const files = Array.from({ length: CODE_UPLOAD_BATCH_MAX_FILES * 2 + 1 }, () => 1);
    const plan = planCodeUploadBatches(files, sizeOf);
    expect(plan.batches.map((batch) => batch.length)).toEqual([
      CODE_UPLOAD_BATCH_MAX_FILES,
      CODE_UPLOAD_BATCH_MAX_FILES,
      1,
    ]);
    expect(CODE_UPLOAD_BATCH_MAX_FILES).toBeLessThanOrEqual(200);
    expect(
      planCodeUploadBatches([CODE_UPLOAD_BATCH_MAX_BYTES, 1], sizeOf).batches.map(
        (batch) => batch.length,
      ),
    ).toEqual([1, 1]);
  });
});

describe('uploadCodeEnvBatch', () => {
  let respond: (body: Buffer) => { status: number; body: unknown };
  let requests: Array<{ url: string; headers: Record<string, unknown>; body: string }>;
  let baseUrl: string;
  const server = createServer(async (request, response) => {
    const body = await buffer(request);
    requests.push({ url: request.url!, headers: request.headers, body: body.toString('latin1') });
    const answer = respond(body);
    response
      .writeHead(answer.status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(answer.body));
  });
  const request = axios.create({ proxy: false });
  const files = [
    { filename: 'plots/a.png', buffer: Buffer.from('first') },
    { filename: 'b.txt', buffer: Buffer.from('second') },
  ];
  const send = () =>
    uploadCodeEnvBatch({
      request,
      baseUrl,
      headers: { 'User-Id': 'user' },
      identity: { kind: 'user', id: 'user' },
      files,
    });

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  beforeEach(() => {
    requests = [];
  });

  it('sends every file in one sized multipart request and pairs results by position', async () => {
    respond = () => ({
      status: 200,
      body: {
        message: 'success',
        storage_session_id: 'session',
        files: [
          { status: 'success', filename: 'plots/a.png', fileId: 'one' },
          { status: 'success', filename: 'b.txt', fileId: 'two' },
        ],
      },
    });

    await expect(send()).resolves.toEqual({
      storage_session_id: 'session',
      files: [
        { status: 'success', fileId: 'one', filename: 'plots/a.png' },
        { status: 'success', fileId: 'two', filename: 'b.txt' },
      ],
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('/v1/upload/batch');
    expect(requests[0].headers['user-id']).toBe('user');
    expect(requests[0].headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(Number(requests[0].headers['content-length'])).toBe(requests[0].body.length);
    expect(requests[0].body).toContain('name="kind"\r\n\r\nuser');
    expect(requests[0].body).toContain('filename="plots/a.png"');
    expect(requests[0].body).toContain('\r\n\r\nfirst\r\n');
    expect(requests[0].body).toContain('\r\n\r\nsecond\r\n');
  });

  it('keeps a per-file refusal apart from the files that were stored', async () => {
    respond = () => ({
      status: 200,
      body: {
        message: 'partial_success',
        storage_session_id: 'session',
        files: [
          { status: 'error', filename: 'plots/a.png', error: 'File size limit exceeded' },
          { status: 'success', filename: 'b.txt', fileId: 'two' },
        ],
      },
    });

    await expect(send()).resolves.toMatchObject({
      files: [
        { status: 'error', error: 'File size limit exceeded' },
        { status: 'success', fileId: 'two' },
      ],
    });
  });

  it('reads the per-file answers out of the 400 sent when every file failed', async () => {
    respond = () => ({
      status: 400,
      body: {
        message: 'error',
        storage_session_id: 'session',
        files: files.map(({ filename }) => ({ status: 'error', filename, error: 'refused' })),
      },
    });

    await expect(send()).resolves.toMatchObject({
      files: [
        { status: 'error', error: 'refused' },
        { status: 'error', error: 'refused' },
      ],
    });
  });

  it('pairs by name when the service answers for fewer files than it was sent', async () => {
    respond = () => ({
      status: 200,
      body: {
        message: 'success',
        storage_session_id: 'session',
        filesLimitReached: true,
        files: [{ status: 'success', filename: 'b.txt', fileId: 'two' }],
      },
    });

    await expect(send()).resolves.toMatchObject({
      files: [
        { status: 'unknown', error: 'the Code API returned no result' },
        { status: 'success', fileId: 'two' },
      ],
    });
  });

  it('does not read a refusal into an answer that confirms nothing', async () => {
    respond = () => ({
      status: 200,
      body: {
        message: 'success',
        storage_session_id: 'session',
        files: [
          { status: 'success', filename: 'plots/a.png' },
          { status: 'stored', filename: 'b.txt', fileId: 'two' },
        ],
      },
    });

    await expect(send()).resolves.toMatchObject({
      files: [
        { status: 'unknown', error: 'the Code API returned an unusable result' },
        { status: 'unknown', error: 'the Code API returned an unusable result' },
      ],
    });
  });

  it.each([
    [429, { error: 'Too many file uploads. Please retry in 156 seconds.' }],
    [400, { error: 'No files provided' }],
    [500, { error: 'Error processing batch upload' }],
  ])('rejects the whole request on a %s without per-file answers', async (status, body) => {
    respond = () => ({ status, body });
    await expect(send()).rejects.toMatchObject({ response: { status } });
  });

  it('rejects a success response that names no storage session', async () => {
    respond = () => ({ status: 200, body: { message: 'success', files: [] } });
    await expect(send()).rejects.toThrow('Unexpected Code API batch upload response');
  });
});
