import { Readable } from 'node:stream';
import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { ChatBedrockConverse } from '@langchain/aws';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseCommandInput } from '@aws-sdk/client-bedrock-runtime';
import type { IMongoFile } from '@librechat/data-schemas';
import type { HttpRequest } from '@smithy/protocol-http';
import type { TFile } from 'librechat-data-provider';
import type { RunFileEncodingAgent } from '~/agents/files/encode';
import type { MissingAttachmentHandler } from '../encode/utils';
import type { ServerRequest, StrategyFunctions } from '~/types';
import {
  BedrockDocumentContext,
  getBedrockDocumentContext,
  registerBedrockResumeDocuments,
} from './context';
import { replayMessageAttachments, AttachmentObjectNotFoundError } from '../encode/utils';
import { bedrockWireSize, guardBedrockDocuments, withBedrockDocuments } from './client';
import { BedrockDocumentError, bedrockRequestLimit } from './limits';
import { resolveTurnDeliveryRouting } from '~/agents/files/delivery';
import { createRunFileMessageEncoder } from '~/agents/files/encode';
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
  recipientId?: string,
  endpoint?: string,
  onMissingFile?: MissingAttachmentHandler,
) =>
  encodeAndFormatDocuments(
    r,
    files,
    { provider: Providers.BEDROCK, model: selected, recipientId, endpoint, onMissingFile },
    () => ({
      getDownloadStream: download,
    }),
  );
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

it.each(['open', 'read'])(
  'sanitizes private storage %s failures and bounded diagnostics',
  async (phase) => {
    const r = req();
    const privateError = Object.assign(
      new Error('EACCES /private/owner/document.pdf upstream diagnostics'),
      { code: 'EACCES' },
    );
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const result = await encode(r, [file()], async () => {
      if (phase === 'open') throw privateError;
      return Readable.from(
        (async function* () {
          throw privateError;
          yield pdf;
        })(),
      );
    });
    const error = await withBedrockDocuments(
      request(sdkBlocks(result.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => '',
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(BedrockDocumentError);
    expect(String(error)).not.toContain('/private');
    expect(warn).toHaveBeenCalledWith('[BedrockDocument] Storage read failed', { type: 'Error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/private');
  },
);

it.each(['text/csv', 'application/csv'])(
  'sends the registered CSV alias %s without rejecting equivalent formats',
  async (type) => {
    const r = req();
    const content = Buffer.from('a,b\n1,2');
    const result = await encode(r, [file('csv-alias', { type, bytes: content.length })], async () =>
      Readable.from(content),
    );
    await withBedrockDocuments(
      request(sdkBlocks(result.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async (input) => {
        expect(input.messages?.[0].content?.[1].document?.source?.bytes).toEqual(content);
      },
    );
  },
);

const restrictiveModel = 'anthropic.claude-3-5-sonnet-20241022-v2:0';
const sixMiB = (): Buffer => {
  const bytes = Buffer.alloc(6 * 1024 * 1024, 65);
  bytes.write('%PDF-');
  return bytes;
};

it('isolates normal registration by recipient/model without weakening the stricter sender', async () => {
  const r = req();
  const bytes = sixMiB();
  const stored = file('normal-shared', { bytes: undefined });
  const download = jest.fn(async () => Readable.from(bytes));
  const root = await encode(r, [stored], download, model, 'root');
  const child = await encode(r, [stored], download, restrictiveModel, 'child');
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(root.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => 'root',
      Providers.BEDROCK,
      'root',
    ),
  ).resolves.toBe('root');
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(child.documents), restrictiveModel),
      getBedrockDocumentContext(r),
      restrictiveModel,
      undefined,
      async () => 'child',
      Providers.BEDROCK,
      'child',
    ),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
});

it('isolates normal endpoint configuration and does not raise the strict recipient limit', async () => {
  const r = req();
  r.config!.fileConfig = {
    endpoints: { generous: { fileSizeLimit: 1 }, strict: { fileSizeLimit: 0.001 } },
  };
  const content = Buffer.alloc(2048, 65);
  const stored = file('endpoint-file', { type: 'text/csv', bytes: undefined });
  const download = async () => Readable.from(content);
  const root = await encode(r, [stored], download, model, 'root', 'generous');
  const child = await encode(r, [stored], download, model, 'child', 'strict');
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(root.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => 'ok',
      'generous',
      'root',
    ),
  ).resolves.toBe('ok');
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(child.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => '',
      'strict',
      'child',
    ),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
});

it.each([false, true])(
  'restores scoped/shared resume policies without cross-recipient clamping (shared: %s)',
  async (shared) => {
    const original = req();
    const bytes = sixMiB();
    const stored = file('resume-six', { bytes: bytes.length });
    const download = jest.fn(async () => Readable.from(bytes));
    const root = await encode(original, [stored], download, model, 'root');
    const resumed = req();
    registerBedrockResumeDocuments(
      resumed,
      shared ? [stored] : [],
      [
        { id: 'root', provider: Providers.BEDROCK, model },
        { id: 'child', provider: Providers.BEDROCK, model: restrictiveModel },
      ],
      () => ({ getDownloadStream: download }),
      new Map(shared ? [] : [['root', [stored]]]),
    );
    await expect(
      withBedrockDocuments(
        request(sdkBlocks(root.documents)),
        getBedrockDocumentContext(resumed),
        model,
        undefined,
        async () => 'root',
        Providers.BEDROCK,
        'root',
      ),
    ).resolves.toBe('root');
    await expect(
      withBedrockDocuments(
        request(sdkBlocks(root.documents), restrictiveModel),
        getBedrockDocumentContext(resumed),
        restrictiveModel,
        undefined,
        async () => '',
        Providers.BEDROCK,
        'child',
      ),
    ).rejects.toBeInstanceOf(BedrockDocumentError);
    expect(download).toHaveBeenCalledTimes(1);
  },
);

it('permits an allowed shared document for both resumed recipients', async () => {
  const original = req();
  const stored = file();
  const download = jest.fn(async () => Readable.from(pdf));
  const result = await encode(original, [stored], download, model, 'root');
  const resumed = req();
  registerBedrockResumeDocuments(
    resumed,
    [stored],
    [
      { id: 'root', provider: Providers.BEDROCK, model },
      { id: 'child', provider: Providers.BEDROCK, model: restrictiveModel },
    ],
    () => ({ getDownloadStream: download }),
  );
  for (const [recipient, selected] of [
    ['root', model],
    ['child', restrictiveModel],
  ]) {
    await expect(
      withBedrockDocuments(
        request(sdkBlocks(result.documents), selected),
        getBedrockDocumentContext(resumed),
        selected,
        undefined,
        async () => 'ok',
        Providers.BEDROCK,
        recipient,
      ),
    ).resolves.toBe('ok');
  }
  expect(download).toHaveBeenCalledTimes(2);
});

it('accepts long individually valid history and tools without a request-global message node cap', async () => {
  const r = req();
  const result = await encode(r, [file('tiny', { type: 'text/csv', bytes: 1 })], async () =>
    Readable.from(Buffer.from('x')),
  );
  const input = request(sdkBlocks(result.documents));
  input.messages!.unshift(
    ...Array.from({ length: 900 }, () => ({
      role: 'user' as const,
      content: Array.from({ length: 6 }, () => ({ text: 'short' })),
    })),
  );
  input.toolConfig = {
    tools: Array.from({ length: 64 }, (_, i) => ({
      toolSpec: {
        name: `tool_${i}`,
        inputSchema: {
          json: {
            type: 'object',
            properties: Object.fromEntries(
              Array.from({ length: 40 }, (_, j) => [`arg_${j}`, { type: 'string' }]),
            ),
          },
        },
      },
    })),
  };
  await expect(
    withBedrockDocuments(input, getBedrockDocumentContext(r), model, undefined, async () => 'ok'),
  ).resolves.toBe('ok');
});

it('still rejects a pathological single message, cyclic data and oversized bytes', () => {
  expect(() =>
    bedrockWireSize(
      { messages: [{ content: Array.from({ length: 4096 }, () => ({ text: 'x' })) }] },
      32_000_000,
    ),
  ).toThrow(BedrockDocumentError);
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(() => bedrockWireSize({ messages: [cyclic] }, 32_000_000)).toThrow(BedrockDocumentError);
  expect(() =>
    bedrockWireSize({ messages: [{ content: [{ text: 'x'.repeat(1000) }] }] }, 100),
  ).toThrow(BedrockDocumentError);
  expect(() =>
    bedrockWireSize(
      {
        toolConfig: {
          tools: [
            { toolSpec: { inputSchema: { json: Array.from({ length: 4096 }, () => ({})) } } },
          ],
        },
      },
      32_000_000,
    ),
  ).toThrow(BedrockDocumentError);
});

it('does not reset depth or node budgets for nested lookalike message containers', () => {
  let nested: object = { text: 'leaf' };
  for (let i = 0; i < 128; i++) nested = { messages: [nested] };
  expect(() => bedrockWireSize({ messages: [nested] }, 32_000_000)).toThrow(BedrockDocumentError);
});

const absentStorage = async (): Promise<Readable> => {
  throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
};
const bedrockRoot = { id: 'root', provider: Providers.BEDROCK, model };

it.each([false, true])(
  'omits deferred historical storage misses after repeated topology registration (explicit history: %s)',
  async (explicitHistory) => {
    const r = req();
    const stored = file('historical');
    let encoded: Awaited<ReturnType<typeof encode>> | undefined;
    await replayMessageAttachments({
      message: {},
      addFileContext: async () => undefined,
      processAttachments: async (onMissingFile) => {
        encoded = await encode(r, [stored], absentStorage, model, 'root', undefined, onMissingFile);
        return encoded.files;
      },
    });
    for (let i = 0; i < 2; i++)
      registerBedrockResumeDocuments(
        r,
        [stored],
        [bedrockRoot],
        () => ({ getDownloadStream: absentStorage }),
        new Map(),
        explicitHistory ? new Set([stored.file_id]) : undefined,
      );
    const send = jest.fn(async (input: ConverseCommandInput) => {
      expect(JSON.stringify(input)).toContain('no longer available');
      expect(input.messages?.[0].content?.some((part) => part.document != null)).toBe(false);
    });
    await withBedrockDocuments(
      request(sdkBlocks(encoded!.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      send,
      Providers.BEDROCK,
      'root',
    );
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each(['historical-first', 'current-first'])(
  'keeps same-file current input strict regardless of registration order: %s',
  async (order) => {
    const r = req();
    const stored = file('current-and-history');
    const omitted = jest.fn();
    let encoded: Awaited<ReturnType<typeof encode>> | undefined;
    for (const historical of order === 'historical-first' ? [true, false] : [false, true]) {
      encoded = await encode(
        r,
        [stored],
        absentStorage,
        model,
        'root',
        undefined,
        historical ? omitted : undefined,
      );
    }
    registerBedrockResumeDocuments(r, [stored], [bedrockRoot], () => ({
      getDownloadStream: absentStorage,
    }));
    const send = jest.fn();
    await expect(
      withBedrockDocuments(
        request(sdkBlocks(encoded!.documents)),
        getBedrockDocumentContext(r),
        model,
        undefined,
        send,
        Providers.BEDROCK,
        'root',
      ),
    ).rejects.toBeInstanceOf(AttachmentObjectNotFoundError);
    expect(send).not.toHaveBeenCalled();
    expect(omitted).not.toHaveBeenCalled();
  },
);

it('treats a historical ID reattached this turn as current before its deferred encoding', async () => {
  const r = req();
  const stored = file('reattached');
  const omitted = jest.fn();
  const encoded = await encode(r, [stored], absentStorage, model, 'root', undefined, omitted);
  registerBedrockResumeDocuments(
    r,
    [stored],
    [bedrockRoot],
    () => ({ getDownloadStream: absentStorage }),
    new Map(),
    new Set(),
  );
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(encoded.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => '',
      Providers.BEDROCK,
      'root',
    ),
  ).rejects.toBeInstanceOf(AttachmentObjectNotFoundError);
  expect(omitted).not.toHaveBeenCalled();
});

it('restores historical absence policy on resume/late registration without leaking it to a current recipient', async () => {
  const r = req();
  const stored = file('resume-absence');
  const current = await encode(r, [stored], absentStorage, model, 'root');
  const child = { id: 'late-child', provider: Providers.BEDROCK, model };
  registerBedrockResumeDocuments(
    r,
    [stored],
    [child],
    () => ({ getDownloadStream: absentStorage }),
    new Map(),
    new Set([stored.file_id]),
  );
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(current.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => 'omitted',
      Providers.BEDROCK,
      child.id,
    ),
  ).resolves.toBe('omitted');
  await expect(
    withBedrockDocuments(
      request(sdkBlocks(current.documents)),
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => '',
      Providers.BEDROCK,
      'root',
    ),
  ).rejects.toBeInstanceOf(AttachmentObjectNotFoundError);
});

it('encodes native run-file PDF for a newly loaded child and resolves it with that exact receiving identity', async () => {
  const r = req();
  const agents = new Map<string, RunFileEncodingAgent>();
  const stored = file('late-shared-pdf', { bytes: pdf.length });
  const shared: TFile = {
    file_id: stored.file_id,
    filename: stored.filename,
    filepath: stored.filepath,
    type: stored.type,
    bytes: pdf.length,
    user: 'user',
    object: 'file',
    usage: 0,
    embedded: false,
    llmDeliveryPath: 'provider',
  };
  const download = jest.fn(async () => Readable.from(pdf));
  const encoder = createRunFileMessageEncoder({
    req: r,
    getAgent: (id) => agents.get(id),
    encodeDocuments: async (request, files, params, strategies) => {
      expect(files).toEqual([shared]);
      const result = await encodeAndFormatDocuments(
        request,
        [stored],
        { ...params, provider: Providers.BEDROCK },
        strategies,
      );
      return { documents: result.documents.map((part) => ({ ...part })) };
    },
    encodeImages: async () => ({ image_urls: [] }),
    encodeAudios: async () => ({ audios: [] }),
    encodeVideos: async () => ({ videos: [] }),
    extractText: async () => undefined,
    getStrategyFunctions: () => ({ getDownloadStream: download }),
  });
  agents.set('late-child', {
    provider: Providers.BEDROCK,
    model,
    deliveryRouting: resolveTurnDeliveryRouting({
      agent: { provider: Providers.BEDROCK, endpoint: Providers.BEDROCK },
      config: r.config,
    }),
  });
  const messages = await encoder.encode([shared], 'late-child');
  expect(download).not.toHaveBeenCalled();
  const content = messages[0].content;
  if (!Array.isArray(content)) throw new Error('fixture');
  const input = request(content);
  await expect(
    withBedrockDocuments(
      input,
      getBedrockDocumentContext(r),
      model,
      undefined,
      async (wire) => {
        expect(
          wire.messages?.[0].content?.find((part) => part.document)?.document?.source?.bytes,
        ).toEqual(pdf);
        return 'sent';
      },
      Providers.BEDROCK,
      'late-child',
    ),
  ).resolves.toBe('sent');
  expect(download).toHaveBeenCalledTimes(1);
  await expect(
    withBedrockDocuments(
      input,
      getBedrockDocumentContext(r),
      model,
      undefined,
      async () => '',
      Providers.BEDROCK,
      'different-child',
    ),
  ).rejects.toBeInstanceOf(BedrockDocumentError);
});

it('rechecks strict current-input policy when an already-started historical read reports a miss', async () => {
  const r = req();
  const stored = file('in-flight-current');
  let opened!: () => void;
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let fail!: (error: Error) => void;
  const download = jest.fn(() => {
    opened();
    return new Promise<Readable>((_resolve, reject) => {
      fail = reject;
    });
  });
  const omitted = jest.fn();
  const encoded = await encode(r, [stored], download, model, 'root', undefined, omitted);
  const pending = withBedrockDocuments(
    request(sdkBlocks(encoded.documents)),
    getBedrockDocumentContext(r),
    model,
    undefined,
    async () => '',
    Providers.BEDROCK,
    'root',
  );
  await started;
  await encode(r, [stored], download, model, 'root');
  fail(Object.assign(new Error('missing fixture'), { code: 'ENOENT' }));
  await expect(pending).rejects.toBeInstanceOf(AttachmentObjectNotFoundError);
  expect(omitted).not.toHaveBeenCalled();
});
