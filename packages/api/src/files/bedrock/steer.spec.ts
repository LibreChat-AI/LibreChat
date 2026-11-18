import { Readable } from 'node:stream';
import { Providers } from '@librechat/agents';
import { ChatBedrockConverse } from '@langchain/aws';
import { HumanMessage } from '@langchain/core/messages';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import type { PostToolBatchHookOutput } from '@librechat/agents';
import type { IMongoFile } from '@librechat/data-schemas';
import type { SteerQueueItem } from '~/stream/interfaces/IJobStore';
import type { ServerRequest } from '~/types';
import {
  getBedrockDocumentContext,
  prepareBedrockSteerDocuments,
  settleBedrockSteerDocuments,
  restoreBedrockSteerOwners,
} from './context';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { buildSteerMedia, repairSteerAttachmentRefs } from '~/agents/steering/media';
import { collectStoredSteerOwners, withoutRepairedSteerMedia } from './owners';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { createSteerDrainHook } from '~/agents/steering/runtime';
import { encodeAndFormatDocuments } from '../encode/document';
import { guardBedrockDocuments } from './client';

const model = 'anthropic.claude-sonnet-4-20250514-v1:0';
const pdf = Buffer.from('%PDF-fixture');
const request = (): ServerRequest =>
  ({
    user: { id: 'fixture' },
    body: {},
    config: { fileConfig: { endpoints: { default: { fileSizeLimit: 0.001 } } } },
  }) as unknown as ServerRequest;
const row = {
  file_id: 'owned-file',
  filename: 'fixture.pdf',
  filepath: '/fixture/file',
  type: 'application/pdf',
  bytes: 1,
  source: 'local',
} as IMongoFile;

afterEach(async () => {
  await GenerationJobManager.destroy();
});
async function setup(download: () => Promise<Readable>, ids = ['owned']) {
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  const streamId = `deferred-${Date.now()}-${Math.random()}`;
  const job = await GenerationJobManager.createJob(streamId, 'fixture', streamId, {
    initialMetadata: { steerQuotesCapable: true },
  });
  const req = request();
  type Applied = NonNullable<Parameters<typeof repairSteerAttachmentRefs>[0]['applied']>;
  const applied = new Map<string, Applied>();
  const publishers = new Map(ids.map((id) => [id, jest.fn(async () => undefined)]));
  const repairs = new Map<string, jest.Mock<Promise<void>, []>>();
  for (const id of ids)
    await GenerationJobManager.steering.enqueue(streamId, {
      steerId: id,
      text: `words ${id}`,
      quotes: ['quoted context'],
      files: [{ file_id: row.file_id }],
      userId: 'fixture',
      createdAt: Date.now(),
    });
  const hook = createSteerDrainHook({
    streamId,
    jobCreatedAt: job.createdAt,
    applySteer: (item) => {
      applied.set(item.steerId, {
        index: applied.size,
        part: {
          type: 'steer',
          steerId: item.steerId,
          steer: item.text,
          quotes: item.quotes,
          files: item.files,
        },
      });
    },
    buildMedia: async (item: SteerQueueItem) => {
      const repair = jest.fn(async () =>
        repairSteerAttachmentRefs({
          applied: applied.get(item.steerId),
          publish: publishers.get(item.steerId)!,
          commit: (value) => {
            applied.set(item.steerId, value);
          },
          rollback: () => settleBedrockSteerDocuments(req, item.steerId, false),
        }),
      );
      repairs.set(item.steerId, repair);
      const media = await buildSteerMedia({
        user: req.user,
        item,
        getFiles: async () => [row],
        assertFilesAllowed: (files) =>
          prepareBedrockSteerDocuments(
            req,
            files,
            [{ id: 'root', provider: Providers.BEDROCK, model }],
            () => ({ getDownloadStream: download }),
            item.steerId,
            undefined,
            repair,
          )(),
        client: {
          resolveTurnAttachments: (files) => files,
          addFileContextToMessage: async () => undefined,
          processAttachments: async (message, files) => {
            const result = await encodeAndFormatDocuments(
              req,
              files,
              {
                provider: Providers.BEDROCK,
                model,
                recipientId: 'root',
                admissionId:
                  typeof message.documentAdmissionId === 'string'
                    ? message.documentAdmissionId
                    : undefined,
              },
              () => ({ getDownloadStream: download }),
            );
            message.documents = result.documents.map((part) => ({ ...part }));
            return files;
          },
        },
      });
      settleBedrockSteerDocuments(req, item.steerId, true);
      return media;
    },
  });
  const output = (await hook(
    { hook_event_name: 'PostToolBatch', runId: 'fixture', entries: [] },
    new AbortController().signal,
  )) as PostToolBatchHookOutput;
  const messages = (output.injectedMessages ?? []).map(
    (message) =>
      new HumanMessage({
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => {
                if (typeof part.type !== 'string') throw new Error('Invalid fixture block');
                return { ...part, type: part.type };
              }),
      }),
  );
  const transport = jest.fn(async () => ({
    response: {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(
        JSON.stringify({
          output: { message: { role: 'assistant', content: [{ text: 'continued' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          metrics: { latencyMs: 1 },
        }),
      ),
    },
  }));
  const client = guardBedrockDocuments(
    new BedrockRuntimeClient({
      region: 'us-east-1',
      maxAttempts: 1,
      credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
      requestHandler: { handle: transport },
    }),
    getBedrockDocumentContext(req),
    model,
    'bedrock',
    'root',
  );
  const chat = new ChatBedrockConverse({ model, client, region: 'us-east-1', streaming: false });
  return { req, messages, chat, client, transport, publishers, repairs, applied };
}

it.each(['missing', 'oversized', 'malformed', 'permission'])(
  'repairs an owned %s preparation failure before transport, preserving text/quotes and later invocation',
  async (kind) => {
    const download = jest.fn(async () => {
      if (kind === 'missing' || kind === 'permission')
        throw Object.assign(new Error('/private/fixture'), {
          code: kind === 'missing' ? 'ENOENT' : 'EACCES',
        });
      return Readable.from(kind === 'oversized' ? Buffer.alloc(2048) : Buffer.from('bad pdf'));
    });
    const h = await setup(download);
    expect(download).not.toHaveBeenCalled();
    await expect(h.chat.invoke(h.messages)).resolves.toMatchObject({ content: 'continued' });
    expect(download).toHaveBeenCalledTimes(1);
    expect(h.repairs.get('owned')).toHaveBeenCalledTimes(1);
    expect(h.publishers.get('owned')).toHaveBeenCalledTimes(1);
    expect(h.applied.get('owned')?.part.files).toBeUndefined();
    await h.chat.invoke(h.messages);
    expect(download).toHaveBeenCalledTimes(1);
    const call = h.transport.mock.calls[0] as unknown as [{ body: string }];
    const wire = JSON.parse(call[0].body);
    expect(wire.messages[0].content).toEqual([{ text: '> quoted context\n\nwords owned' }]);
    const owners = collectStoredSteerOwners([{ content: [h.applied.get('owned')!.part] }]);
    const resumed = request();
    restoreBedrockSteerOwners(resumed, owners);
    const restoredClient = guardBedrockDocuments(
      new BedrockRuntimeClient({
        region: 'us-east-1',
        credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
        requestHandler: { handle: h.transport },
      }),
      getBedrockDocumentContext(resumed),
      model,
      'bedrock',
      'root',
    );
    await new ChatBedrockConverse({
      model,
      client: restoredClient,
      region: 'us-east-1',
      streaming: false,
    }).invoke(h.messages);
    expect(download).toHaveBeenCalledTimes(1);
    expect(withoutRepairedSteerMedia(h.messages[0].content, new Set(['owned']))).toEqual([
      { type: 'text', text: '> quoted context\n\nwords owned' },
    ]);
    restoredClient.destroy();
    h.client.destroy();
  },
);

it('keeps successful owned data deferred and does not repair/replay a transport failure', async () => {
  const download = jest.fn(async () => Readable.from(pdf));
  const h = await setup(download);
  expect(download).not.toHaveBeenCalled();
  h.transport.mockRejectedValueOnce(new Error('transport fixture'));
  await expect(h.chat.invoke(h.messages, { maxConcurrency: 1 })).rejects.toThrow(
    'transport fixture',
  );
  expect(h.transport).toHaveBeenCalledTimes(1);
  expect(h.repairs.get('owned')).not.toHaveBeenCalled();
  expect(h.applied.get('owned')?.part.files).toHaveLength(1);
  h.client.destroy();
});

it('does not repair an ordinary current upload failure', async () => {
  const download = jest.fn(async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  const h = await setup(download);
  const plain = await encodeAndFormatDocuments(
    h.req,
    [{ ...row, file_id: 'current' }],
    { provider: Providers.BEDROCK, model, recipientId: 'root' },
    () => ({ getDownloadStream: download }),
  );
  await expect(
    h.chat.invoke([new HumanMessage({ content: plain.documents.map((part) => ({ ...part })) })]),
  ).rejects.toMatchObject({ code: 'ATTACHMENT_OBJECT_NOT_FOUND' });
  expect(h.repairs.get('owned')).not.toHaveBeenCalled();
  expect(h.transport).not.toHaveBeenCalled();
  h.client.destroy();
});

it('does not claim durable repair success when publication fails and does not repeat it', async () => {
  const download = jest.fn(async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  });
  const h = await setup(download);
  h.publishers.get('owned')!.mockRejectedValueOnce(new Error('durable publication fixture'));
  await expect(h.chat.invoke(h.messages)).rejects.toThrow('Steer attachment recovery failed');
  await expect(h.chat.invoke(h.messages)).rejects.toThrow('Steer attachment recovery failed');
  expect(h.applied.get('owned')?.part.files).toHaveLength(1);
  expect(h.repairs.get('owned')).toHaveBeenCalledTimes(1);
  expect(h.transport).not.toHaveBeenCalled();
  h.client.destroy();
});

it('propagates owned cancellation without media repair', async () => {
  let opened!: () => void;
  const started = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const stream = new Readable({ read() {} });
  const h = await setup(async () => {
    opened();
    return stream;
  });
  const controller = new AbortController();
  const pending = h.chat.invoke(h.messages, { signal: controller.signal });
  await started;
  controller.abort();
  expect(
    await pending.then(
      () => false,
      () => true,
    ),
  ).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(h.repairs.get('owned')).not.toHaveBeenCalled();
  expect(h.transport).not.toHaveBeenCalled();
  expect(stream.destroyed).toBe(true);
  h.client.destroy();
});

it('repairs only the failing owner when two steers share one file', async () => {
  const download = jest
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    .mockImplementation(async () => Readable.from(pdf));
  const h = await setup(download, ['one', 'two']);
  await h.chat.invoke(h.messages);
  expect(h.repairs.get('one')).toHaveBeenCalledTimes(1);
  expect(h.repairs.get('two')).not.toHaveBeenCalled();
  expect(h.applied.get('one')?.part.files).toBeUndefined();
  expect(h.applied.get('two')?.part.files).toHaveLength(1);
  expect(download).toHaveBeenCalledTimes(2);
  h.client.destroy();
});
