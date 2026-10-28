import { randomUUID } from 'node:crypto';
import type {
  FileStorageMethods,
  FileStorageClaim,
  FileStorageScope,
  FileStorageDeleteClaim,
  FileProvisionCommit,
} from '@librechat/data-schemas';

export type FileStorageUploadObserver = (outcome?: 'rejected') => void;

export type RawProvisionStorage = Pick<
  FileStorageMethods,
  'acquireFileProvision' | 'releaseFileProvision' | 'commitFileProvision'
>;
export type FileProvisionStorage = RawProvisionStorage & { recovery: FileProvisionRecovery };
export type FileDeleteStorage = FileProvisionStorage &
  Pick<FileStorageMethods, 'acquireFileDeletion' | 'releaseFileDeletion'>;

type StorageIdentity = {
  file_id: string;
  user?: { toString(): string };
  tenantId?: string | null;
};

export type FileProvisionResult<T> = {
  value: T;
  commit: Omit<FileProvisionCommit, 'claim'>;
};

type ProvisionRun<T> = {
  file: StorageIdentity;
  userId: string;
  storage: RawProvisionStorage;
  destination: string;
  upload: (
    claim: FileStorageClaim,
    onUploadStart: FileStorageUploadObserver,
  ) => Promise<FileProvisionResult<T>>;
};

type DeletionRun<T> = {
  file: StorageIdentity & { updatedAt?: Date | string };
  userId: string;
  storage: FileDeleteStorage;
  operation: (
    primaryDeleted: (confirmed?: boolean) => void,
    onOutcomeUnknown: () => void,
  ) => Promise<T>;
};

type DeletionEntry = {
  claim: FileStorageDeleteClaim;
  phase: 'acquire' | 'operation' | 'release';
  active: boolean;
  retainDeletion: boolean;
  resumed: boolean;
  primaryConfirmed: boolean;
  uncertain: boolean;
  hasResult: boolean;
  value?: unknown;
};

export interface FileProvisionRecovery {
  delete<T>(options: DeletionRun<T>): Promise<T>;
  run<T>(options: ProvisionRun<T>): Promise<T>;
  recover(scope: FileStorageScope, storage: RawProvisionStorage): Promise<void>;
}

/** The remote copy exists but its durable pointer is not confirmed. Keep the claim for recovery. */
export class FileProvisionPersistenceError extends Error {
  constructor(cause?: unknown) {
    super('File provisioning persistence was not confirmed', { cause });
    this.name = 'FileProvisionPersistenceError';
  }
}

/** Dispatch may have created a remote copy. Only operator-verified absence can release its claim. */
export class FileProvisionOutcomeUnknownError extends FileProvisionPersistenceError {
  constructor(cause?: unknown) {
    super(cause);
    this.name = 'FileProvisionOutcomeUnknownError';
    this.message = 'File provisioning outcome is unknown; manual recovery is required';
  }
}

/** Only explicit denials establish that storage did not accept the operation. */
export function isDefinitiveFileStorageFailure(error: unknown): boolean {
  let current = error;
  // RAG wraps the HTTP failure; inspect at most two nested causes.
  for (let depth = 0; depth < 3; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    let status: unknown;
    let hasStatus = true;
    if (
      'response' in current &&
      typeof current.response === 'object' &&
      current.response !== null &&
      'status' in current.response
    ) {
      status = current.response.status;
    } else if (
      '$metadata' in current &&
      typeof current.$metadata === 'object' &&
      current.$metadata !== null &&
      'httpStatusCode' in current.$metadata
    ) {
      status = current.$metadata.httpStatusCode;
    } else if ('statusCode' in current) {
      status = current.statusCode;
    } else if ('status' in current) {
      status = current.status;
    } else {
      hasStatus = false;
    }
    if (hasStatus) {
      switch (status) {
        case 400:
        case 401:
        case 403:
        case 404:
        case 413:
        case 415:
        case 422:
        case 429:
          return true;
        default:
          return false;
      }
    }
    if ('code' in current) {
      switch (current.code) {
        case 'EACCES':
        case 'EPERM':
        case 'CODE_API_RATE_LIMITED':
          return true;
      }
    }
    if (!('cause' in current)) return false;
    current = current.cause;
  }
  return false;
}

type ProvisionEntry = {
  claim: FileStorageClaim;
  phase: 'upload' | 'commit' | 'release' | 'ambiguous';
  hasResult: boolean;
  value?: unknown;
  commit?: FileProvisionCommit;
  attempt?: Promise<unknown>;
  recovering?: boolean;
};

function scopeKey(scope: FileStorageScope): string {
  return JSON.stringify([scope.tenantId ?? null, scope.userId, scope.file_id]);
}

function fileScope(file: StorageIdentity, userId: string): FileStorageScope {
  return {
    file_id: file.file_id,
    userId: file.user?.toString() ?? userId,
    tenantId: file.tenantId,
  };
}

/** App-lifetime recovery only. Unknown claims, including those lost on restart, need manual recovery. */
export function createFileProvisionRecovery(): FileProvisionRecovery {
  const files = new Map<string, Map<string, ProvisionEntry>>();
  const deletions = new Map<string, DeletionEntry>();

  function remove(key: string, destination: string, entry: ProvisionEntry): void {
    const entries = files.get(key);
    if (entries?.get(destination) !== entry) return;
    entries.delete(destination);
    if (entries.size === 0) files.delete(key);
  }

  async function release(entry: ProvisionEntry, storage: RawProvisionStorage): Promise<void> {
    try {
      if (!(await storage.releaseFileProvision(entry.claim))) {
        throw new FileProvisionPersistenceError();
      }
    } catch (error) {
      if (error instanceof FileProvisionPersistenceError) throw error;
      throw new FileProvisionPersistenceError(error);
    }
  }

  async function settle(
    key: string,
    destination: string,
    entry: ProvisionEntry,
    storage: RawProvisionStorage,
  ): Promise<unknown> {
    if (entry.phase === 'ambiguous') throw new FileProvisionOutcomeUnknownError();
    if (entry.phase === 'commit' && entry.commit) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Storage receives a copy so a failed adapter cannot alter the recovery payload.
          await confirmFileProvision(storage, structuredClone(entry.commit));
          entry.phase = 'release';
          break;
        } catch (error) {
          if (attempt === 1) throw error;
        }
      }
    }
    await release(entry, storage);
    remove(key, destination, entry);
    return entry.value;
  }

  function retry(
    key: string,
    destination: string,
    entry: ProvisionEntry,
    storage: RawProvisionStorage,
  ): Promise<unknown> {
    if (entry.attempt) return entry.attempt;
    entry.recovering = true;
    entry.attempt = Promise.resolve()
      .then(() => settle(key, destination, entry, storage))
      .finally(() => {
        entry.attempt = undefined;
        entry.recovering = false;
      });
    return entry.attempt;
  }

  async function run<T>(options: ProvisionRun<T>): Promise<T> {
    const { file, userId, storage, destination, upload } = options;
    const scope = fileScope(file, userId);
    const key = scopeKey(scope);
    if (deletions.has(key)) throw new Error('File provisioning conflicts with deletion');
    let entries = files.get(key);
    const existing = entries?.get(destination);
    if (existing) {
      const reusable = existing.phase !== 'release' || existing.hasResult;
      const value = await (existing.attempt ?? retry(key, destination, existing, storage));
      // Only values from this exact scope and destination cross the internal generic map.
      if (reusable) return value as T;
      return run(options);
    }
    if (!entries) {
      entries = new Map();
      files.set(key, entries);
    }
    const entry: ProvisionEntry = {
      claim: Object.freeze({ ...scope, token: randomUUID() }),
      phase: 'upload',
      hasResult: false,
    };
    entries.set(destination, entry);
    const execute = async (): Promise<T> => {
      let acquired: boolean;
      try {
        acquired = await storage.acquireFileProvision(entry.claim);
      } catch (error) {
        // The claim may be durable even when its acknowledgement was lost.
        entry.phase = 'release';
        throw new FileProvisionPersistenceError(error);
      }
      if (!acquired) {
        remove(key, destination, entry);
        throw new Error('File provisioning conflicts with deletion or a missing record');
      }
      let result: FileProvisionResult<T>;
      let uploadStarted = false;
      try {
        result = await upload(entry.claim, (outcome) => {
          uploadStarted = outcome !== 'rejected';
        });
      } catch (error) {
        if (uploadStarted && !isDefinitiveFileStorageFailure(error)) {
          entry.phase = 'ambiguous';
          throw new FileProvisionOutcomeUnknownError(error);
        }
        entry.phase = 'release';
        try {
          await release(entry, storage);
          remove(key, destination, entry);
        } catch {
          // Preserve the upload error while retaining release-only recovery.
        }
        throw error;
      }
      entry.value = result.value;
      entry.hasResult = true;
      entry.commit = { ...structuredClone(result.commit), claim: entry.claim };
      entry.phase = 'commit';
      await settle(key, destination, entry, storage);
      return result.value;
    };
    entry.attempt = Promise.resolve()
      .then(execute)
      .finally(() => {
        entry.attempt = undefined;
      });
    return entry.attempt as Promise<T>;
  }

  async function releaseDeletion(entry: DeletionEntry, storage: FileDeleteStorage): Promise<void> {
    if (
      !(await storage.releaseFileDeletion({
        ...entry.claim,
        retainDeletion: entry.retainDeletion,
      }))
    ) {
      throw new Error('File deletion claim could not be released');
    }
  }

  async function runDeletion<T>(options: DeletionRun<T>): Promise<T> {
    const { file, userId, storage, operation } = options;
    const scope = fileScope(file, userId);
    const key = scopeKey(scope);
    const existing = deletions.get(key);
    if (existing?.active) throw new Error('File deletion conflicts with active storage work');
    if (existing) {
      existing.active = true;
      try {
        // An unacknowledged acquisition may have resumed an older deletion intent.
        if (existing.phase === 'acquire') existing.retainDeletion = true;
        await releaseDeletion(existing, storage);
        if (existing.hasResult) {
          deletions.delete(key);
          return existing.value as T;
        }
      } finally {
        existing.active = false;
      }
    }
    const entry: DeletionEntry = {
      claim: Object.freeze({ ...scope, updatedAt: file.updatedAt, token: randomUUID() }),
      phase: 'acquire',
      active: true,
      retainDeletion: true,
      resumed: false,
      primaryConfirmed: false,
      uncertain: false,
      hasResult: false,
    };
    // Register before any adapter runs, including synchronous/reentrant adapters.
    deletions.set(key, entry);
    try {
      try {
        await storage.recovery.recover(scope, storage);
      } catch (error) {
        deletions.delete(key);
        throw error;
      }
      const acquired = await storage.acquireFileDeletion(entry.claim);
      if (!acquired) {
        deletions.delete(key);
        throw new Error('File deletion conflicts with active storage work');
      }
      entry.resumed = acquired.resumed;
      entry.retainDeletion = acquired.resumed;
      entry.phase = 'operation';
      let value: T;
      try {
        value = await operation(
          (confirmed = true) => {
            entry.retainDeletion = true;
            entry.primaryConfirmed = entry.primaryConfirmed || confirmed;
          },
          () => {
            entry.uncertain = true;
            entry.retainDeletion = true;
          },
        );
      } catch (error) {
        if (
          entry.retainDeletion &&
          !entry.resumed &&
          !entry.primaryConfirmed &&
          !entry.uncertain &&
          isDefinitiveFileStorageFailure(error)
        ) {
          entry.retainDeletion = false;
        }
        entry.phase = 'release';
        try {
          await releaseDeletion(entry, storage);
          deletions.delete(key);
        } catch {
          // Preserve the operation failure and retain the original release token.
        }
        throw error;
      }
      entry.value = value;
      entry.hasResult = true;
      entry.phase = 'release';
      await releaseDeletion(entry, storage);
      deletions.delete(key);
      return value;
    } finally {
      entry.active = false;
    }
  }

  return {
    run,
    delete: runDeletion,
    async recover(scope, storage) {
      const key = scopeKey(scope);
      const entries = files.get(key);
      if (!entries) return;
      const attempts: Promise<unknown>[] = [];
      for (const [destination, entry] of entries) {
        if (entry.phase === 'upload' || (entry.attempt && !entry.recovering)) continue;
        attempts.push(retry(key, destination, entry, storage));
      }
      await Promise.all(attempts);
    },
  };
}

/** A durable claim spans upload, pointer persistence and release. */
export function withFileProvisioning<T>({
  operation,
  storage,
  ...options
}: Omit<ProvisionRun<T>, 'upload' | 'storage'> & {
  storage: FileProvisionStorage;
  operation: (
    claim: FileStorageClaim,
    onUploadStart: FileStorageUploadObserver,
  ) => Promise<FileProvisionResult<T>>;
}): Promise<T> {
  return storage.recovery.run({ ...options, storage, upload: operation });
}

/** Successful primary removal leaves deletion intent until conditional metadata finalization. */
export function withFileDeletion<T>(options: DeletionRun<T>): Promise<T> {
  return options.storage.recovery.delete(options);
}

/** A missing or replaced claim cannot publish a newly uploaded copy. */
export async function confirmFileProvision(
  storage: Pick<RawProvisionStorage, 'commitFileProvision'>,
  data: FileProvisionCommit,
): Promise<void> {
  try {
    if (!(await storage.commitFileProvision(data))) throw new FileProvisionPersistenceError();
  } catch (error) {
    if (error instanceof FileProvisionPersistenceError) throw error;
    throw new FileProvisionPersistenceError(error);
  }
}
