import { Readable } from 'node:stream';
import { Providers } from '@librechat/agents';
import { ChatBedrockConverse } from '@langchain/aws';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { IMongoFile } from '@librechat/data-schemas';
import type { HttpRequest } from '@smithy/protocol-http';
import type { ServerRequest, StrategyFunctions } from '~/types';
import {
  BedrockDocumentContext,
  getBedrockDocumentContext,
  registerBedrockResumeDocuments,
} from './context';
import { bedrockWireSize, guardBedrockDocuments, withBedrockDocuments } from './client';
import { BedrockDocumentError, bedrockRequestLimit } from './limits';
import { InFlightBytesSemaphore } from '../encode/memoryGuard';
import { encodeAndFormatDocuments } from '../encode/document';

const model = 'anthropic.claude-sonnet-4-20250514-v1:0';
const req = (limit?: number): ServerRequest =>
  ({
    config: { fileConfig: { endpoints: { default: { fileSizeLimit: limit ?? 512 } } } },
  }) as unknown as ServerRequest;
const file = (id = 'file-1', overrides: Partial<IMongoFile> = {}): IMongoFile =>
  ({
    file_id: id,
    filepath: '/stored/test.pdf',
    filename: 'test.pdf',
    source: 'local',
    type: 'application/pdf',
    bytes: 10,
    ...overrides,
  }) as IMongoFile;
const request = (documents: unknown[], modelId = model): ConverseCommandInput =>
  ({
    modelId,
    messages: [{ role: 'user', content: [{ text: 'Read the attachments' }, ...documents] }],
  }) as ConverseCommandInput;
const encode = (
  r: ServerRequest,
  files: IMongoFile[],
  download: StrategyFunctions['getDownloadStream'],
  selected = model,
) =>
  encodeAndFormatDocuments(r, files, { provider: Providers.BEDROCK, model: selected }, () => ({
    getDownloadStream: download,
  }));
const sdkBlocks = (documents: Awaited<ReturnType<typeof encode>>['documents']) =>
  documents.map((part) => {
    if (!('document' in part)) throw new Error('fixture');
    return { document: part.document };
  });
const pdf = Buffer.from('%PDF-test document');

it('retains only authorized file IDs in prompts, message JSON and real checkpoints', async () => {
  const r = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download);
  expect(download).not.toHaveBeenCalled();
  expect(JSON.stringify(result.documents)).not.toContain('Buffer');
  const message = new HumanMessage({ content: result.documents.map((part) => ({ ...part })) });
  const json = JSON.stringify(message.toJSON());
  expect(json.length).toBeLessThan(1500);
  expect(json).toContain('librechatFile');
  expect(json).not.toContain('stored/test.pdf');
  const serializer = new MemorySaver().serde;
  const [type, bytes] = await serializer.dumpsTyped({ messages: [message] });
  expect(bytes.byteLength).toBeLessThan(2000);
  const restored = await serializer.loadsTyped(type, bytes);
  expect(JSON.stringify(restored)).not.toContain('Buffer');
});

it('materializes once at the SDK boundary and never mutates or retains prompt bytes', async () => {
  const r = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download);
  const original = request(sdkBlocks(result.documents));
  const before = JSON.stringify(original);
  let captured: ConverseCommandInput | undefined;
  await withBedrockDocuments(
    original,
    getBedrockDocumentContext(r),
    model,
    undefined,
    async (input) => {
      captured = input;
      expect(input.messages?.[0].content?.[1].document?.source?.bytes).toEqual(pdf);
      return 'sent';
    },
  );
  expect(download).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(original)).toBe(before);
  expect(captured?.messages?.[0].content?.[1].document?.source?.bytes?.byteLength).toBe(0);
});

it.each([undefined, 1])(
  'bounds the real stream with stored size %s and destroys it on overflow',
  async (bytes) => {
    const r = req(0.001);
    let emitted = 0;
    const stream = Readable.from(
      (async function* () {
        for (let i = 0; i < 100; i++) {
          emitted++;
          yield Buffer.alloc(256, 65);
        }
      })(),
    );
    const result = await encode(r, [file('csv', { type: 'text/csv', bytes })], async () => stream);
    await expect(
      withBedrockDocuments(
        request(sdkBlocks(result.documents)),
        getBedrockDocumentContext(r),
        model,
        undefined,
        async () => 'unreachable',
      ),
    ).rejects.toBeInstanceOf(BedrockDocumentError);
    expect(stream.destroyed).toBe(true);
    expect(emitted).toBeLessThan(10);
  },
);

it('rejects oversized known metadata before opening storage despite the merged 512 MB default', async () => {
  const download = jest.fn();
  await expect(
    encode(req(), [file('csv', { type: 'text/csv', bytes: 8 * 1024 * 1024 })], download),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
  expect(download).not.toHaveBeenCalled();
});

it.each([NaN, Infinity, -1, 1.5])(
  'rejects malformed stored size %s without reading',
  async (bytes) => {
    const download = jest.fn();
    await expect(encode(req(), [file('invalid', { bytes })], download)).rejects.toBeInstanceOf(
      BedrockDocumentError,
    );
    expect(download).not.toHaveBeenCalled();
  },
);

it('uses the canonical storage key for remote backends and forwards cancellation', async () => {
  const r = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const stored = file('s3', {
    source: 's3',
    storageKey: 'uploads/owner/test.pdf',
    filepath: 'https://storage.invalid/expired',
  });
  const result = await encode(r, [stored], download);
  await withBedrockDocuments(
    request(sdkBlocks(result.documents)),
    getBedrockDocumentContext(r),
    model,
    new AbortController().signal,
    async () => 'ok',
  );
  expect(download).toHaveBeenCalledWith(r, stored.storageKey, { signal: expect.any(AbortSignal) });
});

it('destroys a stalled stream on abort and permits a fresh retry', async () => {
  const r = req();
  const stream = new Readable({ read() {} });
  const download = jest
    .fn()
    .mockResolvedValueOnce(stream)
    .mockImplementation(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download);
  const controller = new AbortController();
  const send = jest.fn(async () => 'ok');
  const pending = withBedrockDocuments(
    request(sdkBlocks(result.documents)),
    getBedrockDocumentContext(r),
    model,
    controller.signal,
    send,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(stream.destroyed).toBe(true);
  expect(send).not.toHaveBeenCalled();
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(result.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      send,
    ),
  ).resolves.toBe('ok');
});

it('times out a storage read and releases its admission', async () => {
  const r = req();
  r.config!.timeouts = { documentFetchMs: 20 };
  const stream = new Readable({ read() {} });
  const result = await encode(r, [file()], async () => stream);
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(result.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => '',
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(stream.destroyed).toBe(true);
});

it('rejects malformed PDF bytes and propagates stream failures without sending', async () => {
  const r = req();
  const result = await encode(r, [file()], async () => Readable.from(Buffer.from('invalid')));
  const send = jest.fn();
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(result.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      send,
    ),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
  expect(send).not.toHaveBeenCalled();
});

it('enforces five documents across historical messages even when configured above the provider cap', async () => {
  const r = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download);
  const original = request(sdkBlocks(result.documents));
  original.messages = Array.from({ length: 6 }, () => original.messages![0]);
  await expect(
    withBedrockDocuments(original, getBedrockDocumentContext(r), model, undefined, async () => ''),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
  expect(download).not.toHaveBeenCalled();
});

it('enforces actual aggregate bytes even when each document is individually allowed', async () => {
  const r = req();
  r.config!.fileConfig = { endpoints: { default: { fileSizeLimit: 1, totalSizeLimit: 0.00003 } } };
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(
    r,
    [file('one', { bytes: undefined }), file('two', { bytes: undefined })],
    download,
  );
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(result.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => '',
    ),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
});

it('accounts for base64, escaped text and the complete Nova request before any read', async () => {
  const r = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download, 'amazon.nova-pro-v1:0');
  const input = request(sdkBlocks(result.documents), 'amazon.nova-pro-v1:0');
  input.system = [{ text: '\\'.repeat(13_000_000) }];
  await expect(
    withBedrockDocuments(
      input,
      getBedrockDocumentContext(r),
      input.modelId,
      undefined,
      async () => '',
    ),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
  expect(download).not.toHaveBeenCalled();
  expect(bedrockRequestLimit(input.modelId)).toBe(25_000_000);
  expect(bedrockWireSize({ bytes: Buffer.alloc(4) }, 100)).toBe(
    Buffer.byteLength('{"bytes":"AAAAAA=="}'),
  );
});

it('refuses unregistered references rather than accepting a checkpoint-supplied path', async () => {
  const input = request([
    {
      document: {
        name: 'unknown',
        format: 'pdf',
        source: { librechatFile: 'not-authorized', filepath: '/private' },
      },
    },
  ]);
  await expect(
    withBedrockDocuments(
      input,
      new BedrockDocumentContext(req()),
      model,
      undefined,
      async () => '',
    ),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
});

it('rehydrates stable checkpoint IDs only from the current resume authorization projection', async () => {
  const originalReq = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(originalReq, [file()], download);
  const resumedReq = req();
  registerBedrockResumeDocuments(
    resumedReq,
    [file()],
    [{ provider: Providers.BEDROCK, model }],
    () => ({ getDownloadStream: download }),
  );
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(result.documents)),
      getBedrockDocumentContext(resumedReq),
      model,
      undefined,
      async () => 'resumed',
    ),
  ).resolves.toBe('resumed');
});

it('holds process admission through send completion, not just the download', async () => {
  const r = req();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download);
  let sending!: () => void;
  const started = new Promise<void>((resolve) => {
    sending = resolve;
  });
  const first = withBedrockDocuments(
    request(sdkBlocks(result.documents)),
    getBedrockDocumentContext(r),
    model,
    undefined,
    async () => {
      sending();
      await gate;
    },
  );
  await started;
  const controller = new AbortController();
  const queued = withBedrockDocuments(
    request(sdkBlocks(result.documents)),
    getBedrockDocumentContext(r),
    model,
    controller.signal,
    async () => '',
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(download).toHaveBeenCalledTimes(1);
  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: 'AbortError' });
  release();
  await first;
});

it('removes cancelled semaphore waiters without blocking later work', async () => {
  const semaphore = new InFlightBytesSemaphore(100);
  const release = await semaphore.acquire(100);
  const controller = new AbortController();
  const cancelled = semaphore.acquire(100, controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  release();
  const next = await semaphore.acquire(100);
  next();
});

it('sends correct base64 through the real SDK serializer without a provider/network request', async () => {
  const r = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download);
  let body = '';
  let attempts = 0;
  const client = guardBedrockDocuments(
    new BedrockRuntimeClient({
      region: 'us-east-1',
      maxAttempts: 2,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: {
        handle: async (http: HttpRequest) => {
          body = String(http.body);
          if (++attempts === 1) {
            return {
              response: {
                statusCode: 500,
                headers: { 'content-type': 'application/json' },
                body: Buffer.from(JSON.stringify({ message: 'retry fixture' })),
              },
            };
          }
          return {
            response: {
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: Buffer.from(
                JSON.stringify({
                  output: {
                    message: { role: 'assistant', content: [{ text: 'fixture response' }] },
                  },
                  stopReason: 'end_turn',
                  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  metrics: { latencyMs: 1 },
                }),
              ),
            },
          };
        },
      },
    }),
    getBedrockDocumentContext(r),
    model,
  );
  await client.send(new ConverseCommand(request(sdkBlocks(result.documents))));
  expect(download).toHaveBeenCalledTimes(1);
  const chat = new ChatBedrockConverse({ model, client, streaming: false, region: 'us-east-1' });
  const reply = await chat.invoke([
    new HumanMessage({
      content: [
        { type: 'text', text: 'Read the attachments' },
        ...result.documents.map((part) => ({ ...part })),
      ],
    }),
  ]);
  expect(reply.content).toBe('fixture response');
  expect(download).toHaveBeenCalledTimes(2);
  expect(attempts).toBe(3);
  const wire = JSON.parse(body);
  expect(wire.messages[0].content[1].document.source.bytes).toBe(pdf.toString('base64'));
  expect(body).not.toContain('librechatFile');
  expect(JSON.stringify(result.documents)).not.toContain(pdf.toString('base64'));
  client.destroy();
});

it('rejects malformed null content with a safe attachment error', async () => {
  await expect(
    withBedrockDocuments(request([null]), undefined, model, undefined, async () => ''),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
});

it('clears materialized bytes after send failure and reads afresh on application retry', async () => {
  const r = req();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(r, [file()], download);
  const input = request(sdkBlocks(result.documents));
  let captured: ConverseCommandInput | undefined;
  await expect(
    withBedrockDocuments(input, getBedrockDocumentContext(r), model, undefined, async (value) => {
      captured = value;
      throw new Error('provider unavailable');
    }),
  ).rejects.toThrow('provider unavailable');
  expect(captured?.messages?.[0].content?.[1].document?.source?.bytes?.byteLength).toBe(0);
  await expect(
    withBedrockDocuments(input, getBedrockDocumentContext(r), model, undefined, async () => 'ok'),
  ).resolves.toBe('ok');
  expect(download).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(input)).not.toContain('Buffer');
});

it('keeps a real 4 MiB attachment out of prompt and checkpoint allocation', async () => {
  const r = req();
  let opened = 0;
  const result = await encode(
    r,
    [file('large', { type: 'text/csv', bytes: 4 * 1024 * 1024 })],
    async () => {
      opened++;
      return Readable.from(Buffer.alloc(4 * 1024 * 1024, 65));
    },
  );
  const message = new HumanMessage({ content: result.documents.map((part) => ({ ...part })) });
  const serializer = new MemorySaver().serde;
  const [, checkpoint] = await serializer.dumpsTyped({ messages: [message] });
  const promptBytes = Buffer.byteLength(JSON.stringify(message.toJSON()));
  expect(opened).toBe(0);
  expect(promptBytes).toBeLessThan(1500);
  expect(checkpoint.byteLength).toBeLessThan(2000);
  let sent = 0;
  await withBedrockDocuments(
    request(sdkBlocks(result.documents)),
    getBedrockDocumentContext(r),
    model,
    undefined,
    async (input) => {
      sent = input.messages?.[0].content?.[1].document?.source?.bytes?.byteLength ?? 0;
    },
  );
  expect(opened).toBe(1);
  expect(sent).toBe(4 * 1024 * 1024);
  console.info('Bedrock allocation fixture', {
    rawBytes: sent,
    promptBytes,
    checkpointBytes: checkpoint.byteLength,
    reads: opened,
  });
});
