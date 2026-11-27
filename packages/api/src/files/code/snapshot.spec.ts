import axios from 'axios';
import { PassThrough, Readable } from 'node:stream';
import { FileSources } from 'librechat-data-provider';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import type { FiltersConfig } from 'librechat-data-provider';
import type { RunArtifactDescriptor } from './publication';
import type { ServerRequest } from '~/types';
import { createRunFileSnapshotStore } from '~/agents/files/snapshots';
import { createRunArtifactSnapshotAdapter } from './snapshot';

const source: RunArtifactDescriptor = {
  id: 'file ?#',
  name: 'reports/result.csv',
  sessionId: 'session ?#',
  codeExecutionContext: {
    baseUrl: 'https://selected-worker.test/code/',
    executionProfile: 'stateful',
    executionRouteKey: 'worker-route',
    bridgeWorkerId: 'worker-id',
  },
};

function setup({
  open = () => Readable.from([Buffer.from('name,total\na,10\n')]),
  headers = {},
  filters,
  maxBytes = 1024,
  fileLimit = 10,
}: {
  open?: () => Readable;
  headers?: Record<string, string>;
  filters?: FiltersConfig;
  maxBytes?: number;
  fileLimit?: number;
} = {}) {
  const transport = jest.fn(
    async (config: InternalAxiosRequestConfig): Promise<AxiosResponse<Readable>> => ({
      config,
      data: open(),
      status: 200,
      statusText: 'OK',
      headers,
    }),
  );
  const request = axios.create({ adapter: transport });
  const req = { body: {} } as ServerRequest;
  req.user = { id: 'user+id' } as ServerRequest['user'];
  req.config = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    filters,
    fileConfig: {
      endpoints: {
        agents: { fileSizeLimit: maxBytes / (1024 * 1024), fileLimit },
      },
    },
  };
  const getAuthHeaders = jest.fn(async () => ({ Authorization: 'Bearer test-token' }));
  const getBaseURL = jest.fn(() => 'https://default-worker.test');
  const determineFileType = jest.fn(async (): Promise<{ mime: string } | undefined> => undefined);
  const adapter = createRunArtifactSnapshotAdapter({
    req,
    request,
    getAuthHeaders,
    getBaseURL,
    determineFileType,
  });
  return { adapter, transport, req, getAuthHeaders, getBaseURL, determineFileType };
}

describe('createRunArtifactSnapshotAdapter', () => {
  it('downloads the trusted worker route with scoped auth and encoded resource identity', async () => {
    const { adapter, transport, req, getAuthHeaders, getBaseURL } = setup();
    const controller = new AbortController();

    await expect(consumeBuffer(await adapter.open(source, controller.signal))).resolves.toEqual(
      Buffer.from('name,total\na,10\n'),
    );

    expect(getAuthHeaders).toHaveBeenCalledWith(req, 'worker-id');
    expect(getBaseURL).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://selected-worker.test/code/download/session%20%3F%23/file%20%3F%23?kind=user&id=user%2Bid',
        responseType: 'stream',
        timeout: 15000,
        signal: controller.signal,
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'X-CodeAPI-Expected-Profile': 'stateful',
          'X-LibreChat-Code-Worker-ID': 'worker-id',
        }),
      }),
    );
  });

  it('publishes inspected immutable bytes without downloading the changed sandbox file again', async () => {
    let current = Buffer.from('name,total\na,10\n');
    const { adapter, transport, determineFileType } = setup({
      open: () => Readable.from([current]),
    });
    const snapshots = createRunFileSnapshotStore({
      open: adapter.open,
      maxBytes: 1024,
      maxFiles: 2,
    });
    try {
      const snapshot = await snapshots.capture(source);
      current = Buffer.from('name,total\na,999\n');
      const captured = await snapshots.read(snapshot.snapshotId);

      await expect(adapter.prepare(source, captured)).resolves.toBe(captured);
      expect(captured.toString()).toBe('name,total\na,10\n');
      expect(transport).toHaveBeenCalledTimes(1);
      expect(determineFileType).not.toHaveBeenCalled();
    } finally {
      await snapshots.close();
    }
  });

  it('applies content filters to the captured bytes rather than trusting metadata or redownloading', async () => {
    const { adapter, transport, determineFileType } = setup({
      filters: {
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private token', regex: 'PRIVATE-[A-Z]+' }],
          },
        },
      },
    });

    await expect(adapter.prepare(source, Buffer.from('PRIVATE-SECRET'))).rejects.toMatchObject({
      body: { source: 'file', field: 'content' },
    });
    expect(determineFileType).toHaveBeenCalledWith(Buffer.from('PRIVATE-SECRET'), true);
    expect(transport).not.toHaveBeenCalled();
  });

  it('rejects a binary snapshot when policy requires complete extracted text', async () => {
    const { adapter, determineFileType } = setup({
      filters: {
        files: { pii: { fields: ['extracted_text'], starterPatterns: [], uninspectable: 'block' } },
      },
    });
    determineFileType.mockResolvedValue({ mime: 'image/png' });

    await expect(adapter.prepare(source, Buffer.from([0, 1, 2, 3]))).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
  });

  it('does not fall back to a mutable download when inspection exceeds configured limits', async () => {
    const { adapter, transport } = setup({ maxBytes: 4 });
    await expect(adapter.prepare(source, Buffer.from('large'))).rejects.toThrow(
      'could not pass file inspection',
    );
    const disabled = setup({ fileLimit: 0 });
    await expect(disabled.adapter.prepare(source, Buffer.from('ok'))).rejects.toThrow(
      'could not pass file inspection',
    );
    expect(transport).not.toHaveBeenCalled();
    expect(disabled.transport).not.toHaveBeenCalled();
  });

  it('rejects oversized advertised and chunked bodies and closes their streams', async () => {
    const advertised = new PassThrough();
    const withLength = setup({
      maxBytes: 4,
      headers: { 'content-length': '5' },
      open: () => advertised,
    });
    await expect(withLength.adapter.open(source)).rejects.toThrow('response too large');
    expect(advertised.destroyed).toBe(true);

    const chunked = Readable.from([Buffer.from('123'), Buffer.from('45')]);
    const withoutLength = setup({ maxBytes: 4, open: () => chunked });
    await expect(consumeBuffer(await withoutLength.adapter.open(source))).rejects.toThrow(
      'response too large',
    );
    expect(chunked.destroyed).toBe(true);
  });

  it('propagates source failures and closes an unfinished download when cancelled', async () => {
    const broken = new PassThrough();
    const failed = setup({ open: () => broken });
    const reading = consumeBuffer(await failed.adapter.open(source));
    broken.destroy(new Error('connection reset'));
    await expect(reading).rejects.toThrow('connection reset');

    const pending = new PassThrough();
    const cancelled = setup({ open: () => pending });
    const controller = new AbortController();
    const stream = await cancelled.adapter.open(source, controller.signal);
    const cancelledRead = consumeBuffer(stream);
    controller.abort();
    await expect(cancelledRead).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending.destroyed).toBe(true);
  });

  it('checks cancellation before auth, download, and publication', async () => {
    const { adapter, transport, getAuthHeaders, determineFileType } = setup();
    const controller = new AbortController();
    controller.abort();

    await expect(adapter.open(source, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      adapter.prepare(source, Buffer.from('safe'), controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(getAuthHeaders).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(determineFileType).not.toHaveBeenCalled();
  });
});
