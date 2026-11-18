import { promises as fs } from 'node:fs';
import { Readable, PassThrough } from 'node:stream';
import { agentsEndpointSchema, FileSources } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import type { SdkFileSession } from './attachments';
import type { ServerRequest } from '~/types';
import { resolveStoredS3Key } from '~/storage/s3/crud';
import { createSdkFileHost } from './attachments';

const identity = {
  runtimeId: 'runtime',
  agentId: 'agent',
  runId: 'run',
  userId: 'user',
  tenantId: 'tenant',
  conversationId: 'conversation',
};
const file: TFile = {
  file_id: 'file',
  object: 'file',
  usage: 0,
  user: 'user',
  filename: 'input.txt',
  filepath: '/private/storage/input',
  type: 'text/plain',
  bytes: 8,
  source: FileSources.local,
  embedded: false,
};
const limits = agentsEndpointSchema.parse({
  sdkHostFiles: { maxFileBytes: 32, maxChunkBytes: 4, maxSnapshotBytes: 1024, maxSnapshotFiles: 2 },
}).sdkHostFiles!;
const req = { user: { id: 'user', tenantId: 'tenant', role: 'USER' }, config: {} } as ServerRequest;
const sessions: SdkFileSession[] = [];
function setup(
  host = createSdkFileHost(limits)!,
  sources = [file],
  audit?: (event: { action: 'cleanup_failed' }) => void,
) {
  let current = structuredClone(sources);
  let allowed = true;
  const download = jest.fn(async () => Readable.from([Buffer.from('abcdefgh')]));
  const loadFiles = jest.fn(async (ids: string[]) =>
    current.filter((entry) => ids.includes(entry.file_id)),
  );
  const filterFiles = jest.fn(async ({ files }: { files: TFile[] }) => (allowed ? files : []));
  const session = host.createSession({
    req,
    audit,
    getInputs: () => sources,
    loadFiles,
    filterFiles,
    getStrategyFunctions: (source) => ({
      getDownloadStream: download,
      ...([FileSources.s3, FileSources.cloudfront].includes(source as FileSources)
        ? { getStorageKey: resolveStoredS3Key }
        : {}),
    }),
  });
  sessions.push(session);
  const bound = session.bind(identity);
  const read = (offset = 0, length = 4) =>
    bound.service.read({
      version: 1,
      identity,
      reference: bound.sources[0].reference,
      revision: bound.sources[0].revision,
      offset,
      length,
    });
  return {
    host,
    session,
    bound,
    read,
    download,
    loadFiles,
    filterFiles,
    revoke: () => {
      allowed = false;
    },
    update: (files: TFile[]) => {
      current = files;
    },
  };
}
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  jest.restoreAllMocks();
});

test('reads native bytes once with bounded ranges and no locators on the wire', async () => {
  const mkdir = jest.spyOn(fs, 'mkdtemp');
  const f = setup();
  expect(f.bound.descriptor.operations).toEqual(['read']);
  expect(JSON.stringify(f.bound.sources)).not.toContain('/private/');
  expect(f.bound.sources[0].reference).not.toBe(file.file_id);
  const chunks = await Promise.all([f.read(0), f.read(4)]);
  expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data))).toString()).toBe('abcdefgh');
  expect(f.download).toHaveBeenCalledTimes(1);
  expect(f.loadFiles).toHaveBeenCalledTimes(3);
  expect(f.filterFiles).toHaveBeenCalledWith({
    files: [file],
    userId: 'user',
    role: 'USER',
    agentId: 'agent',
  });
  expect(f.host.snapshot().snapshots).toEqual({ operations: 1, reservedBytes: 8 });
  const directory = await mkdir.mock.results[0].value;
  await f.session.close();
  await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.host.snapshot().snapshots).toEqual({ operations: 0, reservedBytes: 0 });
  await expect(f.read()).rejects.toMatchObject({ code: 'cancelled' });
});

test.each(['revoked', 'deleted', 'changed'] as const)(
  'refuses %s files even after caching bytes',
  async (change) => {
    const f = setup();
    await f.read();
    if (change === 'revoked') f.revoke();
    if (change === 'deleted') f.update([]);
    if (change === 'changed') f.update([{ ...file, filepath: '/replaced/object' }]);
    await expect(f.read()).rejects.toMatchObject({
      code: change === 'changed' ? 'conflict' : 'forbidden',
    });
    expect(f.download).toHaveBeenCalledTimes(1);
  },
);

test('rejects forged identities, references, revisions, ranges and writes before storage', async () => {
  const f = setup();
  const input = {
    version: 1 as const,
    identity,
    reference: f.bound.sources[0].reference,
    revision: f.bound.sources[0].revision,
    offset: 0,
    length: 4,
  };
  for (const changed of [
    { identity: { ...identity, userId: 'other' } },
    { reference: 'file' },
    { revision: 'old' },
    { offset: 7 },
  ]) {
    await expect(f.bound.service.read({ ...input, ...changed })).rejects.toBeDefined();
  }
  await expect(
    f.bound.service.stage(
      {
        version: 1,
        identity,
        operationId: 'write',
        filename: 'output.txt',
        mediaType: 'text/plain',
        bytes: 0,
      },
      (async function* () {})(),
    ),
  ).rejects.toMatchObject({ code: 'forbidden' });
  await expect(
    f.bound.service.publish({
      version: 1,
      identity,
      operationId: 'publish',
      reference: input.reference,
      revision: input.revision,
    }),
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(f.download).not.toHaveBeenCalled();
});

test('shares snapshot quotas across sessions and releases them after close', async () => {
  const host = createSdkFileHost({ ...limits, maxSnapshotFiles: 1 })!;
  const first = setup(host);
  const second = setup(host);
  await first.read();
  await expect(second.read()).rejects.toMatchObject({ code: 'overflow' });
  expect(second.download).not.toHaveBeenCalled();
  await first.session.close();
  await expect(second.read()).resolves.toMatchObject({ offset: 0 });
});

test.each(['short', 'oversized', 'failed'] as const)(
  'cleans up %s storage responses without exposing bytes',
  async (mode) => {
    const f = setup();
    f.download.mockImplementationOnce(async () =>
      Readable.from(
        (async function* () {
          yield Buffer.from({ short: 'abc', oversized: 'abcdefghijk', failed: 'abcd' }[mode]);
          if (mode === 'failed') throw new Error('secret storage credential');
        })(),
      ),
    );
    await expect(f.read()).rejects.toMatchObject({
      code: mode === 'failed' ? 'unavailable' : 'conflict',
      message: `Host file service: ${mode === 'failed' ? 'unavailable' : 'conflict'}`,
    });
    expect(f.host.snapshot().snapshots).toEqual({ operations: 0, reservedBytes: 0 });
    await expect(f.read()).resolves.toMatchObject({ offset: 0 });
  },
);

test('aborts a streaming snapshot and frees admission after cleanup', async () => {
  const f = setup();
  const stream = new PassThrough();
  let opened!: () => void;
  const opening = new Promise<void>((resolve) => {
    opened = resolve;
  });
  f.download.mockImplementationOnce(async () => {
    opened();
    return stream;
  });
  const reading = f.read();
  const rejected = reading.catch((error: unknown) => error);
  await opening;
  stream.write(Buffer.from('ab'));
  await f.session.close();
  expect(await rejected).toMatchObject({ code: 'cancelled' });
  expect(stream.destroyed).toBe(true);
  expect(f.host.snapshot().snapshots).toEqual({ operations: 0, reservedBytes: 0 });
});

test('binds stable references on reconstruction but refuses a different tenant or run', () => {
  const f = setup();
  expect(setup().bound.sources).toEqual(f.bound.sources);
  expect(
    f.session.bind({
      conversationId: identity.conversationId,
      tenantId: identity.tenantId,
      userId: identity.userId,
      runId: identity.runId,
      agentId: identity.agentId,
      runtimeId: identity.runtimeId,
    }),
  ).toBe(f.bound);
  expect(() => f.session.bind({ ...identity, tenantId: 'other' })).toThrow();
  expect(() => f.session.bind({ ...identity, runId: 'other' })).toThrow();
});

test('does not admit ephemeral storage or oversized files', () => {
  expect(() => setup(undefined, [{ ...file, source: FileSources.execute_code }])).toThrow();
  expect(() => setup(undefined, [{ ...file, bytes: 33 }])).toThrow();
});

test('rechecks revocation during a download before returning any bytes', async () => {
  const f = setup();
  f.download.mockImplementationOnce(async () => {
    f.revoke();
    return Readable.from([Buffer.from('abcdefgh')]);
  });
  await expect(f.read()).rejects.toMatchObject({ code: 'forbidden' });
});

test('retains reservations for a timed-out snapshot until run cleanup settles', async () => {
  const f = setup(createSdkFileHost({ ...limits, timeoutMs: 25 })!);
  const stream = new PassThrough();
  f.download.mockResolvedValueOnce(stream);
  await expect(f.read()).rejects.toMatchObject({ code: 'timeout' });
  expect(f.host.snapshot().snapshots.reservedBytes).toBe(8);
  await f.session.close();
  expect(stream.destroyed).toBe(true);
  expect(f.host.snapshot().snapshots.reservedBytes).toBe(0);
});

test('fails closed for protected raw file bytes instead of inspecting only metadata', () => {
  const host = createSdkFileHost(limits)!;
  const download = jest.fn();
  const session = host.createSession({
    req: {
      ...req,
      config: { filters: { files: { pii: { uninspectable: 'block' } } } },
    } as ServerRequest,
    getInputs: () => [file],
    loadFiles: async () => [file],
    filterFiles: async ({ files }) => files,
    getStrategyFunctions: (source) => ({
      getDownloadStream: download,
      ...([FileSources.s3, FileSources.cloudfront].includes(source as FileSources)
        ? { getStorageKey: resolveStoredS3Key }
        : {}),
    }),
  });
  sessions.push(session);
  expect(() => session.bind(identity)).toThrow('forbidden');
  expect(download).not.toHaveBeenCalled();
});

test('retains process quota when failed capture cleanup cannot remove private bytes', async () => {
  const f = setup();
  f.download.mockResolvedValueOnce(Readable.from([Buffer.from('short')]));
  const remove = jest.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.host.snapshot().snapshots).toEqual({ operations: 1, reservedBytes: 8 });
  remove.mockRestore();
  await f.session.close();
  expect(f.host.snapshot().snapshots).toEqual({ operations: 0, reservedBytes: 0 });
});

test('keeps admission for an uncooperative opener until its late stream is destroyed', async () => {
  const f = setup(createSdkFileHost({ ...limits, timeoutMs: 25 })!);
  let resolve!: (stream: Readable) => void;
  f.download.mockReturnValueOnce(
    new Promise<Readable>((done) => {
      resolve = done;
    }),
  );
  await expect(f.read()).rejects.toMatchObject({ code: 'timeout' });
  const closing = f.session.close();
  await new Promise<void>((done) => setImmediate(done));
  const late = new PassThrough();
  try {
    expect(f.host.snapshot()).toEqual({
      operations: { operations: 1, reservedBytes: 8 },
      snapshots: { operations: 1, reservedBytes: 8 },
    });
  } finally {
    resolve(late);
    await closing;
  }
  expect(late.destroyed).toBe(true);
  expect(f.host.snapshot().snapshots).toEqual({ operations: 0, reservedBytes: 0 });
});

test('does not clone extracted content into the file binding', () => {
  const host = createSdkFileHost(limits)!;
  const clone = jest.spyOn(global, 'structuredClone');
  const input = { ...file, text: 'already-loaded extracted content' };
  const session = host.createSession({
    req,
    getInputs: () => [input],
    loadFiles: async () => [input],
    filterFiles: async ({ files }) => files,
    getStrategyFunctions: () => ({ getDownloadStream: async () => Readable.from([]) }),
  });
  sessions.push(session);
  session.bind(identity);
  expect(clone.mock.calls).toEqual([
    [expect.objectContaining({ file_id: file.file_id, filepath: file.filepath })],
  ]);
  expect(clone.mock.calls[0][0]).not.toHaveProperty('text');
});

test.each([FileSources.s3, FileSources.cloudfront])(
  'keeps %s references valid across URL renewal and legacy-key backfill',
  async (source) => {
    const key = 'uploads/user/input.txt';
    const original = {
      ...file,
      source,
      filepath: `https://bucket.s3.amazonaws.com/${key}?X-Amz-Signature=old`,
    };
    const refreshed = {
      ...original,
      storageKey: key,
      filepath: `https://bucket.s3.amazonaws.com/${key}?X-Amz-Signature=new`,
    };
    const f = setup(undefined, [original]);
    f.update([refreshed]);
    await expect(f.read()).resolves.toMatchObject({ offset: 0 });
    expect(f.download).toHaveBeenCalledWith(req, key, expect.anything());
    const resumed = setup(undefined, [refreshed]);
    expect(resumed.bound.sources).toEqual(f.bound.sources);
    await expect(
      resumed.bound.service.read({
        version: 1,
        identity,
        reference: f.bound.sources[0].reference,
        revision: f.bound.sources[0].revision,
        offset: 4,
        length: 4,
      }),
    ).resolves.toMatchObject({ offset: 4 });
    resumed.update([{ ...refreshed, storageKey: 'uploads/user/replaced.txt' }]);
    await expect(resumed.read()).rejects.toMatchObject({ code: 'conflict' });
  },
);

test('isolates failed cleanup and diagnostic errors while retaining disk quota', async () => {
  const mkdir = jest.spyOn(fs, 'mkdtemp');
  const audit = jest.fn(() => {
    throw new Error('diagnostic failed');
  });
  const f = setup(undefined, [file], audit);
  await f.read();
  const directory = await mkdir.mock.results[0].value;
  const remove = jest.spyOn(fs, 'rm').mockRejectedValue(new Error('filesystem unavailable'));
  try {
    await expect(f.session.close()).resolves.toBeUndefined();
    expect(audit).toHaveBeenCalledWith({ action: 'cleanup_failed' });
    expect(f.host.snapshot().snapshots).toEqual({ operations: 1, reservedBytes: 8 });
  } finally {
    remove.mockRestore();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
