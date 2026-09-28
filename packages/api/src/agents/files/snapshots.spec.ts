import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import type { RunArtifactDescriptor } from '~/files/code/publication';
import type { RunFileSnapshotStore } from './snapshots';
import { createRunFileSnapshotStore } from './snapshots';

const source: RunArtifactDescriptor = {
  id: 'source-object',
  name: '../../report.csv',
  sessionId: 'sandbox-storage',
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createRunFileSnapshotStore', () => {
  const stores: RunFileSnapshotStore[] = [];

  function create(options: Parameters<typeof createRunFileSnapshotStore>[0]): RunFileSnapshotStore {
    const store = createRunFileSnapshotStore(options);
    stores.push(store);
    return store;
  }

  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    jest.restoreAllMocks();
  });

  it('retains immutable bytes and hashes without exposing source names as local paths', async () => {
    const mkdir = jest.spyOn(fs, 'mkdtemp');
    let content = 'original';
    const store = create({
      open: async () => Readable.from([Buffer.from(content)]),
      maxBytes: 32,
      maxFiles: 3,
    });
    const first = await store.capture(source);
    content = 'changed';
    const second = await store.capture(source);

    expect(first).toEqual({
      snapshotId: expect.any(String),
      size: 8,
      sha256: createHash('sha256').update('original').digest('hex'),
    });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(second.sha256).not.toBe(first.sha256);
    const read = await store.read(first.snapshotId);
    expect(read.toString()).toBe('original');
    read.fill(0);
    expect((await store.read(first.snapshotId)).toString()).toBe('original');
    expect((await store.read(second.snapshotId)).toString()).toBe('changed');

    const directory: string = await mkdir.mock.results[0].value;
    expect((await fs.readdir(directory)).sort()).toEqual(
      [first.snapshotId, second.snapshotId].sort(),
    );
    if (process.platform !== 'win32') {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(join(directory, first.snapshotId))).mode & 0o777).toBe(0o600);
    }
    await store.close();
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reserves file slots before opening parallel sources', async () => {
    const opening = deferred<Readable>();
    const started = deferred<void>();
    let firstOpen = true;
    const open = jest.fn(async () => {
      if (!firstOpen) return Readable.from(['bytes']);
      firstOpen = false;
      started.resolve(undefined);
      return opening.promise;
    });
    const store = create({ open, maxBytes: 32, maxFiles: 1 });
    const first = store.capture(source);
    await started.promise;
    await expect(store.capture(source)).rejects.toThrow('file limit');
    expect(open).toHaveBeenCalledTimes(1);
    opening.resolve(Readable.from(['bytes']));
    const captured = await first;
    await store.discard(captured.snapshotId);
    await store.discard(captured.snapshotId);
    await expect(store.capture(source)).resolves.toMatchObject({ size: 5 });
  });

  it('shares one byte budget across parallel children and frees rejected partial writes', async () => {
    const store = create({
      open: async (artifact) => Readable.from([Buffer.from(artifact.name)]),
      maxBytes: 6,
      maxFiles: 3,
    });
    const results = await Promise.allSettled([
      store.capture({ ...source, name: 'abcd' }),
      store.capture({ ...source, name: 'efgh' }),
    ]);
    const successful = results.filter((result) => result.status === 'fulfilled');
    expect(successful).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(store.capture({ ...source, name: '12' })).resolves.toMatchObject({ size: 2 });
    await expect(store.capture({ ...source, name: 'x' })).rejects.toThrow('byte limit');
  });

  it('removes a failed stream and releases its disk and accounting reservations', async () => {
    const mkdir = jest.spyOn(fs, 'mkdtemp');
    let fail = true;
    const store = create({
      open: async () =>
        Readable.from(
          (async function* () {
            yield Buffer.from('abcdef');
            if (fail) throw new Error('upstream stopped');
          })(),
        ),
      maxBytes: 6,
      maxFiles: 1,
    });
    await expect(store.capture(source)).rejects.toThrow('upstream stopped');
    const directory: string = await mkdir.mock.results[0].value;
    expect(await fs.readdir(directory)).toEqual([]);
    fail = false;
    await expect(store.capture(source)).resolves.toMatchObject({ size: 6 });
  });

  it('cancels a streaming capture and permits a later capture within the same budget', async () => {
    const streaming = new PassThrough();
    const started = deferred<void>();
    let first = true;
    const store = create({
      open: async () => {
        if (!first) return Readable.from(['complete']);
        first = false;
        started.resolve(undefined);
        return streaming;
      },
      maxBytes: 8,
      maxFiles: 1,
    });
    const controller = new AbortController();
    const capturing = store.capture(source, controller.signal);
    await Promise.all([
      expect(capturing).rejects.toThrow(),
      (async () => {
        await started.promise;
        streaming.write('part');
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort(new Error('cancelled'));
      })(),
    ]);
    expect(streaming.destroyed).toBe(true);
    await expect(store.capture(source)).resolves.toMatchObject({ size: 8 });
  });

  it('closes without waiting for an uncooperative opener and destroys its late stream', async () => {
    const mkdir = jest.spyOn(fs, 'mkdtemp');
    const opening = deferred<Readable>();
    const started = deferred<void>();
    const store = create({
      open: async () => {
        started.resolve(undefined);
        return opening.promise;
      },
      maxBytes: 8,
      maxFiles: 1,
    });
    const capturing = store.capture(source);
    await Promise.all([
      expect(capturing).rejects.toThrow('closed'),
      (async () => {
        await started.promise;
        await store.close();
      })(),
    ]);
    const directory: string = await mkdir.mock.results[0].value;
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const late = new PassThrough();
    opening.resolve(late);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(late.destroyed).toBe(true);
    await expect(store.capture(source)).rejects.toThrow('closed');
    await expect(store.read('anything')).rejects.toThrow('closed');
    await store.close();
  });

  it('rejects unknown or discarded IDs without treating them as filesystem paths', async () => {
    const store = create({
      open: async () => Readable.from(['bytes']),
      maxBytes: 8,
      maxFiles: 1,
    });
    const snapshot = await store.capture(source);
    await store.discard(snapshot.snapshotId);
    await expect(store.read(snapshot.snapshotId)).rejects.toThrow('unavailable');
    await expect(store.read('../../report.csv')).rejects.toThrow('unavailable');
    await store.discard('../../report.csv');
  });
});
