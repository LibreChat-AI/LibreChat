import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { FileSources } from 'librechat-data-provider';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import type { AppConfig, ChannelRunRecord, RunArtifactFile } from '@librechat/data-schemas';
import type { ChannelArtifactStorageRequest } from './artifactStorage';
import { createChannelArtifactReader } from './artifactStorage';

const run: ChannelRunRecord = {
  tenantId: 'tenant-a',
  channelId: 'channel-a',
  agentId: 'agent-a',
  runId: 'run-a',
  laneId: 'lane-a',
  state: 'delivered',
  sequence: 1,
  payloadHash: 'hash',
  receivedAt: 1,
  leaseEpoch: 1,
  leaseExpiresAt: 0,
  cancellationRequested: false,
  receipts: [],
  principal: {
    userId: 'user-a',
    channelRevision: 'channel-rev',
    linkId: 'link-a',
    linkRevision: 'link-rev',
  },
  admission: {
    eventId: 'Ev1',
    externalChannelId: 'C1',
    externalThreadKey: 'C1:1',
    externalMessageKey: 'C1:1',
    actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
    input: 'hello',
  },
  execution: {
    requestId: 'request-a',
    conversationId: 'conversation-a',
    parentMessageId: 'parent-a',
  },
};
const file: RunArtifactFile = {
  file_id: 'file-a',
  user: 'user-a',
  tenantId: 'tenant-a',
  conversationId: 'conversation-a',
  filename: 'result.txt',
  filepath: '/uploads/result.txt?cache=1',
  bytes: 6,
  type: 'text/plain',
  source: FileSources.local,
  embedded: false,
  object: 'file',
  usage: 0,
  metadata: {
    runFile: {
      runId: 'response-a',
      executionId: 'execution-a',
      agentId: 'agent-a',
      sourceFileId: 'source-a',
      publishedAt: '2026-10-20T00:00:00.000Z',
      inputFileIds: [],
    },
  },
};
const config = { paths: { uploads: '/configured/uploads' } } as AppConfig;

it('reads a real local file through the configured storage stream with the exact run principal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'channel-artifact-reader-'));
  const path = join(directory, 'result.txt');
  try {
    await writeFile(path, 'result');
    const signal = new AbortController().signal;
    const getConfig = jest.fn(async () => config);
    const getDownloadStream = jest.fn(
      async (request: ChannelArtifactStorageRequest, storedPath: string) => {
        expect(request).toEqual({ config, user: { id: 'user-a' }, tenantId: 'tenant-a' });
        expect(storedPath).toBe(path);
        return createReadStream(storedPath);
      },
    );
    const getStrategyFunctions = jest.fn(() => ({ getDownloadStream }));
    const reader = createChannelArtifactReader({ getConfig, getStrategyFunctions });
    const stream = await reader.readFile({ ...file, storageKey: path }, run, signal);
    expect(stream).not.toBeNull();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('result');
    expect(getConfig).toHaveBeenCalledWith(run);
    expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.local);
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), path, { signal });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  FileSources.local,
  FileSources.s3,
  FileSources.cloudfront,
  FileSources.azure_blob,
  FileSources.firebase,
])('uses the persisted download reference and forwards cancellation for %s', async (source) => {
  const signal = new AbortController().signal;
  const getDownloadStream = jest.fn(async () => Readable.from(['result']));
  const reader = createChannelArtifactReader({
    getConfig: async () => config,
    getStrategyFunctions: () => ({ getDownloadStream }),
  });
  const stream = await reader.readFile({ ...file, source }, run, signal);
  expect(getDownloadStream).toHaveBeenCalledWith(
    { config, user: { id: 'user-a' }, tenantId: 'tenant-a' },
    file.filepath,
    { signal },
  );
  stream?.destroy();
});

it('rejects another owner, tenant, conversation, or missing execution before any storage/config I/O', async () => {
  const getConfig = jest.fn(async () => config);
  const getStrategyFunctions = jest.fn();
  const reader = createChannelArtifactReader({ getConfig, getStrategyFunctions });
  const signal = new AbortController().signal;
  for (const other of [
    { ...file, user: 'user-b' },
    { ...file, tenantId: 'tenant-b' },
    { ...file, tenantId: undefined },
    { ...file, conversationId: 'conversation-b' },
    { ...file, expiredAt: new Date(0) },
    { ...file, expiredAt: new Date(Number.NaN) },
  ]) {
    expect(await reader.readFile(other, run, signal)).toBeNull();
  }
  expect(await reader.readFile(file, { ...run, execution: undefined }, signal)).toBeNull();
  expect(getConfig).not.toHaveBeenCalled();
  expect(getStrategyFunctions).not.toHaveBeenCalled();
});

it('does not route unsupported provider/code sources to storage or expose credentials', async () => {
  const getConfig = jest.fn(async () => config);
  const getStrategyFunctions = jest.fn();
  const reader = createChannelArtifactReader({ getConfig, getStrategyFunctions });
  for (const source of Object.values(FileSources).filter(
    (source) =>
      ![
        FileSources.local,
        FileSources.s3,
        FileSources.cloudfront,
        FileSources.azure_blob,
        FileSources.firebase,
      ].includes(source),
  )) {
    expect(
      await reader.readFile({ ...file, source }, run, new AbortController().signal),
    ).toBeNull();
  }
  expect(getConfig).not.toHaveBeenCalled();
  expect(getStrategyFunctions).not.toHaveBeenCalled();
});

it('normalizes only the default tenant sentinel without admitting a named tenant', async () => {
  const getDownloadStream = jest.fn(async () => Readable.from(['result']));
  const reader = createChannelArtifactReader({
    getConfig: async () => config,
    getStrategyFunctions: () => ({ getDownloadStream }),
  });
  const defaultRun = { ...run, tenantId: '_' };
  const signal = new AbortController().signal;
  const stream = await reader.readFile({ ...file, tenantId: undefined }, defaultRun, signal);
  expect(stream).not.toBeNull();
  stream?.destroy();
  expect(getDownloadStream).toHaveBeenCalledWith(
    { config, user: { id: 'user-a' }, tenantId: '_' },
    file.filepath,
    { signal },
  );
  expect(await reader.readFile(file, defaultRun, signal)).toBeNull();
  expect(getDownloadStream).toHaveBeenCalledTimes(1);
});

it('returns null for missing config/strategy/path and never starts an already aborted read', async () => {
  const getDownloadStream = jest.fn(async () => Readable.from(['result']));
  const deps = {
    getConfig: async () => config,
    getStrategyFunctions: () => ({ getDownloadStream }),
  };
  const signal = new AbortController().signal;
  expect(
    await createChannelArtifactReader({ ...deps, getConfig: async () => undefined }).readFile(
      file,
      run,
      signal,
    ),
  ).toBeNull();
  expect(
    await createChannelArtifactReader({ ...deps, getStrategyFunctions: () => undefined }).readFile(
      file,
      run,
      signal,
    ),
  ).toBeNull();
  expect(
    await createChannelArtifactReader(deps).readFile({ ...file, filepath: '' }, run, signal),
  ).toBeNull();
  const controller = new AbortController();
  controller.abort();
  await expect(
    createChannelArtifactReader(deps).readFile(file, run, controller.signal),
  ).rejects.toThrow();
  expect(getDownloadStream).not.toHaveBeenCalled();
});
