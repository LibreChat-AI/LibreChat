import axios from 'axios';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { logger } from '@librechat/data-schemas';
import type { ContainerClient } from '@azure/storage-blob';
import { assertStorageRange, createAzureFileStream, createFirebaseFileStream } from './read';

const bytes = Buffer.alloc(8 * 1024 * 1024, 7);
const range = { start: bytes.length - 32, end: bytes.length - 1 };
const contentRange = `bytes ${range.start}-${range.end}/${bytes.length}`;
async function consume(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

it('fetches only the requested Firebase tail over HTTP', async () => {
  let sent = 0;
  const server = createServer((request, response) => {
    expect(request.headers.range).toBe(`bytes=${range.start}-${range.end}`);
    const selected = bytes.subarray(range.start, range.end + 1);
    sent += selected.length;
    response.writeHead(206, { 'Content-Range': contentRange, 'Content-Length': selected.length });
    response.end(selected);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
    const open = createFirebaseFileStream({ getStorage: () => ({}), http: axios });
    const result = await consume(
      await open({}, `http://127.0.0.1:${address.port}/video`, { range }),
    );
    expect(result).toEqual(bytes.subarray(range.start));
    expect(sent).toBe(32);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it('passes Azure offset and length while resolving the configured Azurite container', async () => {
  const download = jest.fn(async () => ({
    readableStreamBody: Readable.from(bytes.subarray(range.start)),
    contentRange,
  }));
  const getBlockBlobClient = jest.fn(() => ({ download }));
  const getContainerClient = jest.fn(
    async () =>
      ({
        url: 'http://127.0.0.1:10000/account/files',
        getBlockBlobClient,
      }) as unknown as ContainerClient,
  );
  const open = createAzureFileStream({ getContainerClient });
  const signal = new AbortController().signal;
  expect(
    await consume(
      await open({}, 'http://127.0.0.1:10000/account/files/video%20one.mp4', { range, signal }),
    ),
  ).toHaveLength(32);
  expect(getContainerClient).toHaveBeenCalledTimes(1);
  expect(getBlockBlobClient).toHaveBeenCalledWith('video one.mp4');
  expect(download).toHaveBeenCalledWith(range.start, 32, { abortSignal: signal });
});

it.each([undefined, 'bytes 0-31/8388608', 'bytes 8388576-8388607/32'])(
  'closes a backend stream when its range is absent or incorrect: %s',
  (header) => {
    const stream = Readable.from(bytes);
    expect(() => assertStorageRange(stream, range, header)).toThrow('requested byte range');
    expect(stream.destroyed).toBe(true);
  },
);

it('logs a storage download failure without its credentials before rethrowing', async () => {
  const error = jest.spyOn(logger, 'error').mockImplementation(() => logger);
  const getContainerClient = jest.fn(
    async () =>
      ({
        url: 'http://127.0.0.1:10000/account/files',
        getBlockBlobClient: () => ({
          download: async () => {
            throw Object.assign(new Error('Blob not found'), { statusCode: 404 });
          },
        }),
      }) as unknown as ContainerClient,
  );
  const openAzure = createAzureFileStream({ getContainerClient });
  await expect(openAzure({}, 'http://127.0.0.1:10000/account/files/missing.png')).rejects.toThrow(
    'Blob not found',
  );
  const openFirebase = createFirebaseFileStream({ getStorage: () => undefined, http: axios });
  await expect(openFirebase({}, 'https://storage.example/object')).rejects.toThrow(
    'Firebase is not initialized',
  );
  expect(error).toHaveBeenCalledWith('[getAzureFileStream] Error getting blob stream:', {
    type: 'Error',
    status: 404,
  });
  expect(error).toHaveBeenCalledWith('Error getting Firebase file stream:', { type: 'Error' });
  error.mockRestore();
});
