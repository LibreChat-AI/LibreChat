import type { TSyncArtifactAppRequest } from 'librechat-data-provider';

const DATABASE_NAME = 'librechat-artifact-sync';
const DATABASE_VERSION = 1;
const STORE_NAME = 'registrations';

export interface ArtifactSyncQueueEntry {
  id: string;
  ownerId: string;
  request: TSyncArtifactAppRequest;
  signature: string;
  failures: number;
  nextAttemptAt: number;
  updatedAt: number;
}

type QueueListener = () => void;

const memoryQueue = new Map<string, ArtifactSyncQueueEntry>();
const listeners = new Set<QueueListener>();
let hydrationPromise: Promise<void> | null = null;
let persistencePromise: Promise<void> = Promise.resolve();

/**
 * Sub-millisecond `updatedAt` so two writes issued back-to-back (e.g. a rapid edit followed by
 * another) never tie under Date.now()'s 1ms resolution, which would make the "keep the newer
 * write" merge in hydration and broadcast handling silently favor whichever arrived first.
 */
function now(): number {
  return typeof performance !== 'undefined'
    ? performance.timeOrigin + performance.now()
    : Date.now();
}

/**
 * Order operations before opening IndexedDB; connection timing must not reorder snapshots.
 * The internal chain always recovers so one failed write doesn't wedge every later write behind
 * a permanently-rejected promise, but the caller gets the operation's own outcome, unmasked, so a
 * real IndexedDB failure surfaces instead of being reported as successful persistence.
 */
function persistQueueChange<T>(operation: () => Promise<T>): Promise<T> {
  const attempt = persistencePromise.then(operation);
  persistencePromise = attempt.then(
    () => undefined,
    () => undefined,
  );
  return attempt;
}

function notifyListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function hasIndexedDb(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
}

function hasBroadcastChannel(): boolean {
  return typeof window !== 'undefined' && typeof window.BroadcastChannel !== 'undefined';
}

type QueueBroadcastMessage =
  | { type: 'upsert'; entry: ArtifactSyncQueueEntry }
  | { type: 'delete'; id: string; signature: string };

/** Propagates writes/deletes to other tabs so a stale in-memory snapshot never outsurvives its source. */
const syncChannel: BroadcastChannel | null = hasBroadcastChannel()
  ? new window.BroadcastChannel('librechat-artifact-sync')
  : null;

function broadcast(message: QueueBroadcastMessage): void {
  syncChannel?.postMessage(message);
}

if (syncChannel) {
  syncChannel.onmessage = (event: MessageEvent<QueueBroadcastMessage>) => {
    const message = event.data;
    if (message.type === 'upsert') {
      const current = memoryQueue.get(message.entry.id);
      if (!current || current.updatedAt < message.entry.updatedAt) {
        memoryQueue.set(message.entry.id, message.entry);
        notifyListeners();
      }
    } else if (memoryQueue.get(message.id)?.signature === message.signature) {
      memoryQueue.delete(message.id);
      notifyListeners();
    }
  };
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('Unable to open artifact sync queue'));
  });
}

function isQueueEntry(value: unknown): value is ArtifactSyncQueueEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<ArtifactSyncQueueEntry>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.ownerId === 'string' &&
    typeof candidate.signature === 'string' &&
    typeof candidate.failures === 'number' &&
    typeof candidate.nextAttemptAt === 'number' &&
    typeof candidate.updatedAt === 'number' &&
    candidate.request != null
  );
}

async function readStoredEntries(): Promise<ArtifactSyncQueueEntry[]> {
  const database = await openDatabase();
  if (!database) {
    return [];
  }
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result.filter(isQueueEntry));
    request.onerror = () =>
      reject(request.error ?? new Error('Unable to read artifact sync queue'));
    transaction.oncomplete = () => database.close();
  });
}

async function hydrateQueue(): Promise<void> {
  if (!hydrationPromise) {
    hydrationPromise = readStoredEntries()
      .catch(() => [])
      .then((entries) => {
        for (const entry of entries) {
          const current = memoryQueue.get(entry.id);
          if (!current || current.updatedAt < entry.updatedAt) {
            memoryQueue.set(entry.id, entry);
          }
        }
      });
  }
  await hydrationPromise;
}

async function writeStoredEntry(entry: ArtifactSyncQueueEntry, retry = false): Promise<boolean> {
  const database = await openDatabase();
  if (!database) {
    return true;
  }
  return new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const readRequest = store.get(entry.id);
    let written = false;
    readRequest.onsuccess = () => {
      const stored = readRequest.result;
      if (!retry || !isQueueEntry(stored) || stored.signature === entry.signature) {
        store.put(entry);
        written = true;
      }
    };
    transaction.oncomplete = () => {
      database.close();
      resolve(written);
    };
    transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save sync item'));
  });
}

async function deleteStoredEntry(id: string, signature: string): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const readRequest = store.get(id);
    readRequest.onsuccess = () => {
      if (isQueueEntry(readRequest.result) && readRequest.result.signature === signature) {
        store.delete(id);
      }
    };
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Unable to remove artifact sync item'));
  });
}

export function getArtifactSyncQueueId(ownerId: string, request: TSyncArtifactAppRequest): string {
  return `${ownerId}\u0000${request.source.conversationId}\u0000${request.source.sourceKey}`;
}

export async function enqueueArtifactSync(
  ownerId: string,
  request: TSyncArtifactAppRequest,
  signature: string,
  delayMs: number,
): Promise<void> {
  await hydrateQueue();
  const id = getArtifactSyncQueueId(ownerId, request);
  const current = memoryQueue.get(id);
  const entry: ArtifactSyncQueueEntry = {
    id,
    ownerId,
    request,
    signature,
    failures: current?.signature === signature ? current.failures : 0,
    nextAttemptAt: Date.now() + delayMs,
    updatedAt: now(),
  };
  memoryQueue.set(id, entry);
  const persisted = persistQueueChange(() => writeStoredEntry(entry));
  notifyListeners();
  broadcast({ type: 'upsert', entry });
  await persisted;
}

export async function listArtifactSyncQueue(ownerId: string): Promise<ArtifactSyncQueueEntry[]> {
  await hydrateQueue();
  return Array.from(memoryQueue.values()).filter((entry) => entry.ownerId === ownerId);
}

/**
 * Re-reads the in-memory snapshot for one entry. Other tabs keep this current via
 * {@link broadcast}, so a caller can check it immediately before sending or activating a
 * queued request to reject one superseded since it was read off {@link listArtifactSyncQueue}.
 */
export function getCurrentArtifactSyncEntry(id: string): ArtifactSyncQueueEntry | undefined {
  return memoryQueue.get(id);
}

export async function completeArtifactSync(id: string, signature: string): Promise<void> {
  await hydrateQueue();
  if (memoryQueue.get(id)?.signature !== signature) {
    return;
  }
  memoryQueue.delete(id);
  const persisted = persistQueueChange(() => deleteStoredEntry(id, signature));
  notifyListeners();
  broadcast({ type: 'delete', id, signature });
  await persisted;
}

/**
 * Locks in a baseline that failed to resolve when this entry was enqueued, once the worker
 * manages to resolve it before a later send attempt. Applies only while the entry still has no
 * baseline and is still the exact request it was resolved for (same signature) — an
 * already-resolved baseline, or one superseded by a newer edit since the resolve started, is
 * left alone.
 */
export async function recordArtifactSyncBaseline(
  id: string,
  signature: string,
  basedOnVersionNumber: number,
): Promise<boolean> {
  await hydrateQueue();
  const current = memoryQueue.get(id);
  if (!current || current.signature !== signature || current.request.basedOnVersionNumber != null) {
    return false;
  }
  const updated: ArtifactSyncQueueEntry = {
    ...current,
    request: { ...current.request, basedOnVersionNumber },
    updatedAt: now(),
  };
  memoryQueue.set(id, updated);
  const persisted = await persistQueueChange(() => writeStoredEntry(updated, true));
  if (!persisted) {
    if (memoryQueue.get(id) === updated) {
      memoryQueue.delete(id);
    }
    return false;
  }
  notifyListeners();
  broadcast({ type: 'upsert', entry: updated });
  const latest = memoryQueue.get(id);
  return (
    latest?.signature === signature && latest.request.basedOnVersionNumber === basedOnVersionNumber
  );
}

export async function rescheduleArtifactSync(
  id: string,
  signature: string,
  delayMs: number,
): Promise<void> {
  await hydrateQueue();
  const current = memoryQueue.get(id);
  if (!current || current.signature !== signature) {
    return;
  }
  const updated: ArtifactSyncQueueEntry = {
    ...current,
    failures: current.failures + 1,
    nextAttemptAt: Date.now() + delayMs,
    updatedAt: now(),
  };
  memoryQueue.set(id, updated);
  const persisted = persistQueueChange(() => writeStoredEntry(updated, true));
  notifyListeners();
  broadcast({ type: 'upsert', entry: updated });
  await persisted;
}

export function subscribeToArtifactSyncQueue(listener: QueueListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only: releases this module instance's broadcast channel handle. */
export function closeArtifactSyncChannelForTests(): void {
  syncChannel?.close();
}

/** Test-only reset; production callers must retain queued registrations. */
export async function clearArtifactSyncQueueForTests(): Promise<void> {
  await persistencePromise;
  memoryQueue.clear();
  hydrationPromise = null;
  const database = await openDatabase();
  if (!database) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('Unable to clear sync queue'));
  });
}
