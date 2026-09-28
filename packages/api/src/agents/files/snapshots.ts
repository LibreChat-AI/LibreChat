import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import type { Readable, TransformCallback } from 'node:stream';
import type { RunArtifactDescriptor } from '~/files/code/publication';

export interface RunFileSnapshot {
  snapshotId: string;
  size: number;
  sha256: string;
}

export interface RunFileSnapshotStore {
  capture: (source: RunArtifactDescriptor, signal?: AbortSignal) => Promise<RunFileSnapshot>;
  read: (snapshotId: string, signal?: AbortSignal) => Promise<Buffer>;
  discard: (snapshotId: string) => Promise<void>;
  close: () => Promise<void>;
}

interface SnapshotEntry {
  snapshotId: string;
  size: number;
  ready: boolean;
  path?: string;
  controller: AbortController;
  reads: Set<Promise<Buffer>>;
  removal?: Promise<void>;
}

/** Keeps immutable private bytes off the heap and outside the public file store. */
export function createRunFileSnapshotStore({
  open,
  maxBytes,
  maxFiles,
}: {
  open: (source: RunArtifactDescriptor, signal?: AbortSignal) => Promise<Readable>;
  /** Aggregate bytes reserved by completed and currently streaming snapshots. */
  maxBytes: number;
  /** Includes captures that have not yet finished opening their source. */
  maxFiles: number;
}): RunFileSnapshotStore {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(maxFiles) ||
    maxFiles < 1
  ) {
    throw new Error('Private artifact snapshot limits must be positive safe integers.');
  }

  const entries = new Map<string, SnapshotEntry>();
  const operations = new Set<Promise<unknown>>();
  const lifetime = new AbortController();
  let directory: Promise<string> | undefined;
  let allocatedBytes = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  function assertOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (closed) throw new Error('Private artifact snapshots are closed.');
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation);
    const release = (): void => {
      operations.delete(operation);
    };
    void operation.then(release, release);
    return operation;
  }

  function getDirectory(): Promise<string> {
    directory ??= (async () => {
      const created = await fs.mkdtemp(join(tmpdir(), 'librechat-run-files-'));
      try {
        await fs.chmod(created, 0o700);
        return created;
      } catch (error) {
        await fs.rm(created, { recursive: true, force: true });
        throw error;
      }
    })();
    return directory;
  }

  function openSource(source: RunArtifactDescriptor, signal: AbortSignal): Promise<Readable> {
    return new Promise<Readable>((resolve, reject) => {
      const aborted = (): void => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          return open(source, signal);
        })
        .then(
          (stream) => {
            signal.removeEventListener('abort', aborted);
            // An adapter may resolve after cancellation even when passed a signal.
            // Do not let that late source keep a socket or start another disk write.
            if (signal.aborted) {
              stream.destroy();
              reject(signal.reason);
              return;
            }
            resolve(stream);
          },
          (error: unknown) => {
            signal.removeEventListener('abort', aborted);
            reject(error);
          },
        );
    });
  }

  function remove(entry: SnapshotEntry): Promise<void> {
    if (entry.removal) return entry.removal;
    entry.ready = false;
    entry.controller.abort(new Error('The private artifact snapshot was discarded.'));
    const removal = (async () => {
      await Promise.allSettled([...entry.reads]);
      if (entry.path) await fs.rm(entry.path, { force: true });
      if (entries.get(entry.snapshotId) === entry) {
        entries.delete(entry.snapshotId);
        allocatedBytes -= entry.size;
      }
    })();
    entry.removal = removal;
    void removal.catch(() => {
      // A later close can retry cleanup after a transient filesystem failure.
      if (entry.removal === removal) entry.removal = undefined;
    });
    return removal;
  }

  function capture(source: RunArtifactDescriptor, signal?: AbortSignal): Promise<RunFileSnapshot> {
    return track(
      (async () => {
        assertOpen(signal);
        if (entries.size >= maxFiles) {
          throw new Error('The private artifact snapshot file limit has been reached.');
        }
        const entry: SnapshotEntry = {
          snapshotId: randomUUID(),
          size: 0,
          ready: false,
          controller: new AbortController(),
          reads: new Set(),
        };
        entries.set(entry.snapshotId, entry);
        const effectiveSignal = AbortSignal.any([
          lifetime.signal,
          entry.controller.signal,
          ...(signal ? [signal] : []),
        ]);
        try {
          const root = await getDirectory();
          effectiveSignal.throwIfAborted();
          const stream = await openSource(source, effectiveSignal);
          entry.path = join(root, entry.snapshotId);
          const hash = createHash('sha256');
          const counter = new Transform({
            transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
              if (chunk.byteLength > maxBytes - allocatedBytes) {
                callback(new Error('The private artifact snapshot byte limit has been reached.'));
                return;
              }
              // No await between the check and reservation: concurrent child streams
              // consume one shared budget, including writes still in progress.
              allocatedBytes += chunk.byteLength;
              entry.size += chunk.byteLength;
              hash.update(chunk);
              callback(null, chunk);
            },
          });
          await pipeline(
            stream,
            counter,
            createWriteStream(entry.path, { flags: 'wx', mode: 0o600 }),
            { signal: effectiveSignal },
          );
          effectiveSignal.throwIfAborted();
          entry.ready = true;
          return { snapshotId: entry.snapshotId, size: entry.size, sha256: hash.digest('hex') };
        } catch (error) {
          await remove(entry);
          throw error;
        }
      })(),
    );
  }

  function read(snapshotId: string, signal?: AbortSignal): Promise<Buffer> {
    return track(
      (async () => {
        assertOpen(signal);
        const entry = entries.get(snapshotId);
        if (!entry?.ready || !entry.path) {
          throw new Error('The private artifact snapshot is unavailable.');
        }
        const effectiveSignal = AbortSignal.any([
          lifetime.signal,
          entry.controller.signal,
          ...(signal ? [signal] : []),
        ]);
        const reading = fs.readFile(entry.path, { signal: effectiveSignal });
        entry.reads.add(reading);
        try {
          const buffer = await reading;
          effectiveSignal.throwIfAborted();
          return buffer;
        } finally {
          entry.reads.delete(reading);
        }
      })(),
    );
  }

  function discard(snapshotId: string): Promise<void> {
    const entry = entries.get(snapshotId);
    return entry ? track(remove(entry)) : Promise.resolve();
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    lifetime.abort(new Error('Private artifact snapshots are closed.'));
    closing = (async () => {
      await Promise.allSettled([...operations]);
      await Promise.allSettled([...entries.values()].map(remove));
      const root = await directory?.catch(() => undefined);
      if (root) await fs.rm(root, { recursive: true, force: true });
      entries.clear();
      allocatedBytes = 0;
    })();
    return closing;
  }

  return { capture, read, discard, close };
}
