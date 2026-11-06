import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { FileSources, FileContext } from 'librechat-data-provider';
import { createModels, createMethods, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type {
  ChannelRunRecord,
  RunArtifactScope,
  RunArtifactContent,
  ResponseArtifactFile,
} from '@librechat/data-schemas';
import type { ChannelArtifactDependencies } from './artifacts';
import { createChannelArtifactService } from './artifacts';

let mongo: MongoMemoryServer;
let db: ReturnType<typeof createMethods>;
let run: ChannelRunRecord;
let deps: ChannelArtifactDependencies;
let service: ReturnType<typeof createChannelArtifactService>;
const userId = new mongoose.Types.ObjectId().toString();
const scope: RunArtifactScope = {
  userId,
  tenantId: 'tenant-a',
  conversationId: 'conversation-a',
  runId: 'response-a',
  executionId: 'execution-a',
  agentId: 'agent-a',
  sourceFileId: 'source-a',
};
const contentByFile = new Map<string, Buffer>();
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
let limits = {
  artifactMaxBytes: 10000,
  artifactMaxFiles: 3,
  artifactReadTimeoutMs: 1000,
  artifactAnswerFileThresholdBytes: 6000,
};

async function publish(
  bytes = 'result',
  identity: RunArtifactScope = scope,
  overrides: Partial<RunArtifactContent> = {},
) {
  const file = await tenantStorage.run({ tenantId: identity.tenantId ?? undefined }, () =>
    db.publishRunArtifactFile({
      scope: identity,
      provenance: {
        runId: identity.runId,
        executionId: identity.executionId,
        agentId: identity.agentId,
        sourceFileId: identity.sourceFileId,
        publishedAt: '2026-10-20T00:00:00.000Z',
        inputFileIds: [],
      },
      file: {
        filename: 'result.txt',
        filepath: '/uploads/result.txt',
        bytes: Buffer.byteLength(bytes),
        type: 'text/plain',
        source: FileSources.local,
        ...overrides,
      },
    }),
  );
  contentByFile.set(file.file_id, Buffer.from(bytes));
  return file;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await mongoose.models.File.init();
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(() =>
    Promise.all([mongoose.models.File.deleteMany({}), mongoose.models.Message.deleteMany({})]),
  );
  await tenantStorage.run({ tenantId: scope.tenantId ?? undefined }, () =>
    mongoose.models.Message.create({
      user: userId,
      tenantId: scope.tenantId,
      conversationId: scope.conversationId,
      messageId: scope.runId,
      isCreatedByUser: false,
      sender: 'Agent',
      endpoint: 'agents',
      model: 'agent-a',
      text: 'Owned response',
      attachments: [],
    }),
  );
  contentByFile.clear();
  limits = {
    artifactMaxBytes: 10000,
    artifactMaxFiles: 3,
    artifactReadTimeoutMs: 1000,
    artifactAnswerFileThresholdBytes: 6000,
  };
  run = {
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
      userId,
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
      responseId: scope.runId,
      protocol: 'responses',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
    },
    snapshot: { responseId: 'response-a', status: 'completed', text: 'answer', elapsedMs: 1 },
  };
  deps = {
    readArtifacts: (identity, query) =>
      tenantStorage.run({ tenantId: identity.tenantId ?? undefined }, () =>
        db.readResponseArtifacts(identity, query),
      ),
    readFile: jest.fn(async (file) => Readable.from([contentByFile.get(file.file_id)!])),
    limits: async () => limits,
  };
  service = createChannelArtifactService(deps);
});

it('hashes exact saved response bytes and reauthorizes the immutable file at download', async () => {
  const file = await publish('snowman ☃', scope, {
    filename: '../nested\\report\n.csv',
    type: 'text/plain; bad',
  });
  const listed = await service.list(run, run.snapshot!);
  expect(listed).toEqual({
    unavailable: false,
    artifacts: [
      {
        artifactId: `${file.file_id}:${digest('snowman ☃')}`,
        filename: 'report.csv',
        mediaType: 'application/octet-stream',
        bytes: Buffer.byteLength('snowman ☃'),
        sha256: digest('snowman ☃'),
      },
    ],
  });
  run.snapshot!.artifacts = listed.artifacts;
  const downloaded = await service.content(run, listed.artifacts[0].artifactId);
  expect(downloaded.bytes).toEqual(Buffer.from('snowman ☃'));
  expect(downloaded.descriptor).toEqual(listed.artifacts[0]);
});

it('real Mongo scope excludes other users, tenants, conversations, responses and expired artifacts', async () => {
  const allowed = await publish();
  await publish('other owner', { ...scope, userId: new mongoose.Types.ObjectId().toString() });
  await publish('other tenant', { ...scope, tenantId: 'tenant-b' });
  await publish('other conversation', { ...scope, conversationId: 'conversation-b' });
  await publish('other response', { ...scope, runId: 'response-b' });
  await publish('expired', { ...scope, sourceFileId: 'expired' }, { expiredAt: new Date(0) });
  const listed = await service.list(run, run.snapshot!);
  expect(listed.artifacts).toHaveLength(1);
  expect(listed.artifacts[0].artifactId).toBe(`${allowed.file_id}:${digest('result')}`);
  expect(deps.readFile).toHaveBeenCalledTimes(1);
  run.snapshot!.artifacts = listed.artifacts;
  await expect(
    service.content(
      { ...run, principal: { ...run.principal, userId: new mongoose.Types.ObjectId().toString() } },
      listed.artifacts[0].artifactId,
    ),
  ).rejects.toMatchObject({ code: 'artifact_unavailable' });
  await expect(
    service.content({ ...run, tenantId: 'tenant-b' }, listed.artifacts[0].artifactId),
  ).rejects.toMatchObject({ code: 'artifact_unavailable' });
});

it('rejects unknown identifiers before storage and rejects changed bytes even at the same length', async () => {
  const file = await publish('before');
  const listed = await service.list(run, run.snapshot!);
  run.snapshot!.artifacts = listed.artifacts;
  jest.mocked(deps.readFile).mockClear();
  for (const id of [
    'https://untrusted.invalid/file',
    '/etc/passwd',
    file.file_id,
    `${file.file_id}:${digest('other')}`,
  ]) {
    await expect(service.content(run, id)).rejects.toMatchObject({ code: 'artifact_unavailable' });
  }
  expect(deps.readFile).not.toHaveBeenCalled();
  contentByFile.set(file.file_id, Buffer.from('after!'));
  await expect(service.content(run, listed.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_changed',
  });
  contentByFile.set(file.file_id, Buffer.from('longer bytes'));
  await expect(service.content(run, listed.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_changed',
  });
});

it('resolves default tenant artifacts without matching files in a named tenant', async () => {
  const file = await publish('default tenant', { ...scope, tenantId: undefined });
  await publish('named tenant');
  await runAsSystem(() =>
    mongoose.models.Message.collection.insertOne({
      user: userId,
      conversationId: scope.conversationId,
      messageId: scope.runId,
      isCreatedByUser: false,
      attachments: [],
    }),
  );
  const defaultRun = { ...run, tenantId: '_' };
  const listed = await service.list(defaultRun, defaultRun.snapshot!);
  expect(listed.artifacts).toHaveLength(1);
  expect(listed.artifacts[0].artifactId).toBe(`${file.file_id}:${digest('default tenant')}`);
});

it('rechecks expiry at download even when the snapshot still advertises the file', async () => {
  const file = await publish();
  const listed = await service.list(run, run.snapshot!);
  run.snapshot!.artifacts = listed.artifacts;
  await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
    mongoose.models.File.updateOne({ file_id: file.file_id }, { $set: { expiredAt: new Date(0) } }),
  );
  jest.mocked(deps.readFile).mockClear();
  await expect(service.content(run, listed.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_unavailable',
  });
  expect(deps.readFile).not.toHaveBeenCalled();
});

it('bounds declared size, actual streamed bytes and number of files without erasing answer text', async () => {
  limits.artifactMaxBytes = 8;
  await publish('too many bytes', scope);
  await publish('lying stream exceeds limit', { ...scope, sourceFileId: 'lying' }, { bytes: 1 });
  await publish('valid', { ...scope, sourceFileId: 'valid' });
  const listed = await service.list(run, run.snapshot!);
  expect(listed.unavailable).toBe(true);
  expect(listed.artifacts).toHaveLength(1);
  expect(listed.artifacts[0].bytes).toBe(5);
  expect(deps.readFile).toHaveBeenCalledTimes(2);
  expect(run.snapshot!.text).toBe('answer');
  limits.artifactMaxFiles = 1;
  jest.mocked(deps.readFile).mockClear();
  expect((await service.list(run, run.snapshot!)).unavailable).toBe(true);
  expect(jest.mocked(deps.readFile).mock.calls.length).toBeLessThanOrEqual(1);
});

it('preserves safe source fallback when optional storage is unsupported or unavailable', async () => {
  await publish();
  run.snapshot!.text = '```sql\nSELECT 1\n```';
  jest.mocked(deps.readFile).mockResolvedValueOnce(null);
  const unsupported = await service.list(run, run.snapshot!);
  expect(unsupported.unavailable).toBe(true);
  expect(unsupported.artifacts).toEqual([
    {
      artifactId: `answer:${digest(run.snapshot!.text)}`,
      filename: 'agent-response.md',
      mediaType: 'text/markdown',
      bytes: Buffer.byteLength(run.snapshot!.text),
      sha256: digest(run.snapshot!.text),
    },
  ]);
  jest.mocked(deps.readFile).mockRejectedValueOnce(new Error('storage unavailable'));
  expect(await service.list(run, run.snapshot!)).toEqual(unsupported);
  run.snapshot!.artifacts = unsupported.artifacts;
  expect((await service.content(run, unsupported.artifacts[0].artifactId)).bytes.toString()).toBe(
    run.snapshot!.text,
  );
  run.snapshot!.text = 'changed source';
  await expect(service.content(run, unsupported.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_changed',
  });
});

it('bounds source fallback at listing and honors a reduced byte limit at download', async () => {
  run.snapshot!.text = 'a'.repeat(6001);
  const listed = await service.list(run, run.snapshot!);
  expect(listed.artifacts).toHaveLength(1);
  run.snapshot!.artifacts = listed.artifacts;
  limits.artifactMaxBytes = 100;
  await expect(service.content(run, listed.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_too_large',
  });
  expect((await service.list(run, run.snapshot!)).artifacts).toEqual([]);
});

it('destroys timed out or invalid streams without losing retained response text', async () => {
  await publish();
  limits.artifactReadTimeoutMs = 15;
  run.snapshot!.text = '```text\nanswer\n```';
  const hanging = new Readable({ read() {} });
  jest.mocked(deps.readFile).mockResolvedValueOnce(hanging);
  const listed = await service.list(run, run.snapshot!);
  expect(hanging.destroyed).toBe(true);
  expect(listed.unavailable).toBe(true);
  expect(listed.artifacts).toEqual([]);
  expect(run.snapshot!.text).toBe('```text\nanswer\n```');
  const invalid = Readable.from([{ unexpected: 'object' }]);
  jest.mocked(deps.readFile).mockResolvedValueOnce(invalid);
  expect((await service.list(run, run.snapshot!)).unavailable).toBe(true);
  expect(invalid.destroyed).toBe(true);
});

it('does not resolve files for incomplete or missing responses, but propagates database failures', async () => {
  const readArtifacts = jest.spyOn(deps, 'readArtifacts');
  expect(await service.list(run, { ...run.snapshot!, status: 'running' })).toEqual({
    artifacts: [],
    unavailable: false,
  });
  expect(await service.list(run, { ...run.snapshot!, responseId: undefined })).toEqual({
    artifacts: [],
    unavailable: false,
  });
  expect(readArtifacts).not.toHaveBeenCalled();
  readArtifacts.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(service.list(run, run.snapshot!)).rejects.toThrow('database unavailable');
});

it('binds both catalog and stored content to the exact execution response', async () => {
  await publish();
  await expect(
    service.list(run, { ...run.snapshot!, responseId: 'previous-response' }),
  ).rejects.toMatchObject({ code: 'artifact_changed' });
  const listed = await service.list(run, run.snapshot!);
  run.snapshot!.artifacts = listed.artifacts;
  run.execution!.responseId = 'another-response';
  await expect(service.content(run, listed.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_changed',
  });
});

it('includes only generated attachments referenced by the owned response and projects bounded reader metadata', async () => {
  await tenantStorage.run({ tenantId: scope.tenantId ?? undefined }, async () => {
    for (let index = 0; index < 8; index++) {
      const id = `ordinary-${index}`;
      await mongoose.models.File.create({
        file_id: id,
        user: userId,
        tenantId: scope.tenantId,
        conversationId: scope.conversationId,
        filename: `${id}.txt`,
        filepath: `/uploads/${id}`,
        type: 'text/plain',
        source: FileSources.local,
        bytes: 6,
        context: FileContext.execute_code,
        text: 'private extracted text',
      });
      contentByFile.set(id, Buffer.from('result'));
    }
    await mongoose.models.Message.updateOne(
      { messageId: scope.runId, user: userId },
      {
        $set: {
          attachments: Array.from({ length: 7 }, (_, index) => ({ file_id: `ordinary-${index}` })),
        },
      },
    );
    const catalog = await db.readResponseArtifacts(scope, { kind: 'list', limit: 3 });
    expect(catalog).toHaveLength(3);
    for (const file of catalog!) {
      expect(file).not.toHaveProperty('text');
      expect(file).not.toHaveProperty('metadata');
      expect(file).not.toHaveProperty('_id');
    }
  });
  limits.artifactMaxFiles = 2;
  const listed = await service.list(run, run.snapshot!);
  expect(listed.unavailable).toBe(true);
  expect(listed.artifacts).toHaveLength(2);
  expect(listed.artifacts.every((file) => !file.artifactId.startsWith('ordinary-7:'))).toBe(true);
  run.snapshot!.artifacts = listed.artifacts;
  limits.artifactMaxFiles = 1;
  expect((await service.content(run, listed.artifacts[1].artifactId)).bytes.toString()).toBe(
    'result',
  );
});

it('refuses expired response retention for generated files and answer fallbacks', async () => {
  await publish();
  const listed = await service.list(run, run.snapshot!);
  run.snapshot!.artifacts = listed.artifacts;
  await tenantStorage.run({ tenantId: scope.tenantId ?? undefined }, () =>
    mongoose.models.Message.updateOne(
      { messageId: scope.runId, user: userId },
      { $set: { expiredAt: new Date(Date.now() - 1) } },
    ),
  );
  await expect(service.content(run, listed.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_unavailable',
  });
  run.snapshot!.text = '```text\nanswer\n```';
  expect(await service.list(run, run.snapshot!)).toEqual({ artifacts: [], unavailable: true });
});

it('bounds stream acquisition even when its reader ignores cancellation and destroys late streams', async () => {
  await publish();
  limits.artifactReadTimeoutMs = 15;
  run.snapshot!.text = '```text\nanswer\n```';
  let deliver!: (stream: Readable) => void;
  const stalled = new Promise<Readable>((resolve) => {
    deliver = resolve;
  });
  jest.mocked(deps.readFile).mockReturnValueOnce(stalled);
  const listed = await service.list(run, run.snapshot!);
  expect(listed.unavailable).toBe(true);
  expect(listed.artifacts).toEqual([]);
  const late = new Readable({
    read() {},
    destroy(_error, callback) {
      callback(new Error('late cleanup failure'));
    },
  });
  deliver(late);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(late.destroyed).toBe(true);
});

it('rejects invalid catalog bounds and cross-tenant contexts rather than hiding query failures', async () => {
  for (const limit of [0, 22, 1.5, Number.MAX_SAFE_INTEGER]) {
    await expect(deps.readArtifacts(scope, { kind: 'list', limit })).rejects.toThrow('page size');
  }
  await expect(
    tenantStorage.run({ tenantId: 'tenant-b' }, () =>
      db.readResponseArtifacts(scope, { kind: 'authorize' }),
    ),
  ).rejects.toThrow('authenticated scope');
  await expect(
    deps.readArtifacts({ ...scope, tenantId: '_' }, { kind: 'authorize' }),
  ).rejects.toThrow('Reserved tenant identifier');
});

it('requires the actual response attachment and rejects expired, foreign-owner and foreign-conversation generated files', async () => {
  const attachmentIds: string[] = [];
  await runAsSystem(async () => {
    for (const [id, extra] of [
      ['allowed-generated', {}],
      ['unreferenced-generated', {}],
      ['expired-generated', { expiresAt: new Date(0) }],
      ['foreign-owner', { user: new mongoose.Types.ObjectId() }],
      ['foreign-conversation', { conversationId: 'other' }],
      ['foreign-tenant', { tenantId: 'tenant-b' }],
    ] as const) {
      await mongoose.models.File.collection.insertOne({
        file_id: id,
        user: new mongoose.Types.ObjectId(userId),
        tenantId: scope.tenantId,
        conversationId: scope.conversationId,
        filename: id,
        filepath: '/uploads/result',
        bytes: 6,
        type: 'text/plain',
        source: FileSources.local,
        context: FileContext.execute_code,
        ...extra,
      });
      if (id !== 'unreferenced-generated') attachmentIds.push(id);
    }
  });
  await tenantStorage.run({ tenantId: scope.tenantId ?? undefined }, () =>
    mongoose.models.Message.updateOne(
      { messageId: scope.runId, user: userId },
      { $set: { attachments: attachmentIds.map((file_id) => ({ file_id })) } },
    ),
  );
  expect(
    (await deps.readArtifacts(scope, { kind: 'list', limit: 21 }))?.map((file) => file.file_id),
  ).toEqual(['allowed-generated']);
  expect(
    await deps.readArtifacts(scope, { kind: 'file', fileId: 'unreferenced-generated' }),
  ).toEqual([]);
  await tenantStorage.run({ tenantId: scope.tenantId ?? undefined }, () =>
    mongoose.models.Message.updateOne(
      { messageId: scope.runId, user: userId },
      { $set: { isCreatedByUser: true } },
    ),
  );
  expect(await deps.readArtifacts(scope, { kind: 'authorize' })).toBeNull();
});

it.each([0, 1])(
  'bounds all files and policy resolution after %i successful reads by one deadline',
  async (successful) => {
    const files: ResponseArtifactFile[] = [];
    for (let index = 0; index < 3; index++)
      files.push(await publish('result', { ...scope, sourceFileId: `source-${index}` }));
    deps.readArtifacts = jest.fn(async (_scope, query) => (query.kind === 'list' ? files : []));
    limits.artifactReadTimeoutMs = 50;
    const late: Array<(stream: Readable) => void> = [];
    let reads = 0;
    jest
      .mocked(deps.readFile)
      .mockImplementation(() =>
        reads++ < successful
          ? Promise.resolve(Readable.from(['result']))
          : new Promise<Readable>((resolve) => late.push(resolve)),
      );
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      deps.limits = () => new Promise((resolve) => setTimeout(() => resolve(limits), 20));
      let settled = false;
      const listing = service.list(run, run.snapshot!).then((result) => {
        settled = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(50);
      const settledAtBudget = settled;
      await jest.advanceTimersByTimeAsync(200);
      const result = await listing;
      expect(settledAtBudget).toBe(true);
      expect(deps.readFile).toHaveBeenCalledTimes(successful + 1);
      expect(result).toEqual({ artifacts: [], unavailable: true });
    } finally {
      jest.useRealTimers();
      for (const resolve of late) resolve(Readable.from(['late']));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  },
);

it.each(['list', 'authorize'] as const)(
  'bounds a stalled %s query without exposing an unverified answer file',
  async (stalledKind) => {
    limits.artifactReadTimeoutMs = 50;
    run.snapshot!.text = '```text\nanswer\n```';
    let release!: () => void;
    const stalled = new Promise<[]>((resolve) => {
      release = () => resolve([]);
    });
    deps.readArtifacts = jest.fn(async (_scope, query) =>
      query.kind === stalledKind ? stalled : [],
    );
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let settled = false;
      const listing = service.list(run, run.snapshot!).then((result) => {
        settled = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(50);
      const settledAtBudget = settled;
      release();
      const result = await listing;
      expect(settledAtBudget).toBe(true);
      expect(result).toEqual({ artifacts: [], unavailable: true });
      expect(deps.readFile).not.toHaveBeenCalled();
    } finally {
      release();
      jest.useRealTimers();
    }
  },
);

it('rejects user-submitted assistant-shaped rows for all catalog reads and saved descriptors', async () => {
  const file = await publish();
  const listed = await service.list(run, run.snapshot!);
  run.snapshot!.artifacts = listed.artifacts;
  await tenantStorage.run({ tenantId: scope.tenantId ?? undefined }, () =>
    mongoose.models.Message.updateOne(
      { messageId: scope.runId, user: userId },
      { $set: { isUserSubmitted: true } },
    ),
  );
  for (const query of [
    { kind: 'list', limit: 4 },
    { kind: 'file', fileId: file.file_id },
    { kind: 'authorize' },
  ] as const)
    expect(await deps.readArtifacts(scope, query)).toBeNull();
  await expect(service.content(run, listed.artifacts[0].artifactId)).rejects.toMatchObject({
    code: 'artifact_unavailable',
  });
  run.snapshot!.text = '```text\nanswer\n```';
  expect(await service.list(run, run.snapshot!)).toEqual({ artifacts: [], unavailable: true });
});

it('uses the configured byte threshold for new answer files and preserves authorized saved identities', async () => {
  run.snapshot!.text = 'ééé';
  limits.artifactAnswerFileThresholdBytes = 5;
  const listed = await service.list(run, run.snapshot!);
  expect(listed.artifacts).toHaveLength(1);
  expect(listed.artifacts[0].bytes).toBe(6);
  run.snapshot!.artifacts = listed.artifacts;
  limits.artifactAnswerFileThresholdBytes = 6;
  expect((await service.list(run, run.snapshot!)).artifacts).toEqual([]);
  expect((await service.content(run, listed.artifacts[0].artifactId)).bytes.toString()).toBe('ééé');
  run.snapshot!.text = '```text\nshort\n```';
  expect((await service.list(run, run.snapshot!)).artifacts).toHaveLength(1);
});

it('bounds a stalled policy lookup by the schema hard maximum and never starts late catalog work', async () => {
  let release!: () => void;
  deps.limits = () =>
    new Promise((resolve) => {
      release = () => resolve(limits);
    });
  deps.readArtifacts = jest.fn(async () => []);
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    const listing = service.list(run, run.snapshot!);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(await listing).toEqual({ artifacts: [], unavailable: true });
    release();
    await Promise.resolve();
    expect(deps.readArtifacts).not.toHaveBeenCalled();
  } finally {
    release();
    jest.useRealTimers();
  }
});

it('keeps downloads inside the same budget through final reauthorization', async () => {
  const file = await publish();
  const listed = await service.list(run, run.snapshot!);
  run.snapshot!.artifacts = listed.artifacts;
  limits.artifactReadTimeoutMs = 50;
  let release!: () => void;
  const authorization = new Promise<[]>((resolve) => {
    release = () => resolve([]);
  });
  deps.readArtifacts = jest.fn(async (_scope, query) =>
    query.kind === 'file' ? [file] : authorization,
  );
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  try {
    let settled = false;
    const download = service.content(run, listed.artifacts[0].artifactId).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: Error) => {
        settled = true;
        return error;
      },
    );
    await jest.advanceTimersByTimeAsync(50);
    const settledAtBudget = settled;
    release();
    expect(await download).toMatchObject({ code: 'artifact_unavailable' });
    expect(settledAtBudget).toBe(true);
  } finally {
    release();
    jest.useRealTimers();
  }
});

it('uses at most one storage stream while listing the maximum number of artifacts', async () => {
  limits.artifactMaxFiles = 20;
  for (let index = 0; index < 20; index++)
    await publish('result', { ...scope, sourceFileId: `bounded-${index}` });
  let active = 0;
  let maximumActive = 0;
  jest.mocked(deps.readFile).mockImplementation(async () => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    return new Readable({
      read() {
        this.push('result');
        this.push(null);
      },
      destroy(_error, callback) {
        active--;
        callback(null);
      },
    });
  });
  const listed = await service.list(run, run.snapshot!);
  expect(listed.artifacts).toHaveLength(20);
  expect(maximumActive).toBe(1);
  expect(active).toBe(0);
});
