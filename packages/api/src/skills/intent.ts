import { randomUUID } from 'node:crypto';
import type { SkillBlobReservation } from './reservation';
import { assertSavedSkillBlobMatchesReservation } from './reservation';

type ReserveInput = {
  skillId: string;
  author: string;
  fileId: string;
  source: string;
  storageKey: string;
  tenantId?: string;
  writerId: string;
};

export interface SkillUploadIntentDeps {
  reserveSkillUploadIntent: (input: ReserveInput) => Promise<{ fileId: string }>;
  transitionSkillUploadIntent: (
    fileId: string,
    writerId: string,
    from: 'uploading' | 'committing' | 'committed' | 'abandoned',
    to: 'uploading' | 'committing' | 'committed' | 'abandoned',
  ) => Promise<boolean>;
}

export interface SkillUploadOperation<T> {
  skillId: string;
  author: string;
  tenantId?: string;
  fileId: string;
  source: string;
  reservation: SkillBlobReservation;
  save: () => Promise<string>;
  persist: (filepath: string) => Promise<T>;
  readPersisted: () => Promise<T | null>;
  deleteReserved: (reservation: SkillBlobReservation, savedPath?: string) => Promise<void>;
}

/** Persist the future object location before bytes can reach external storage. */
export async function withSkillUploadIntent<T>(
  deps: SkillUploadIntentDeps,
  operation: SkillUploadOperation<T>,
): Promise<T> {
  if (operation.source !== operation.reservation.source) {
    throw new Error('Skill upload source differs from its reserved provider');
  }
  const writerId = randomUUID();
  await deps.reserveSkillUploadIntent({
    skillId: operation.skillId,
    author: operation.author,
    tenantId: operation.tenantId,
    fileId: operation.fileId,
    source: operation.source,
    storageKey: operation.reservation.storageKey ?? operation.reservation.filepath,
    writerId,
  });
  let savedPath: string | undefined;
  let persistedResult: { value: T } | undefined;
  let persistStarted = false;
  try {
    const filepath = await operation.save();
    if (typeof filepath !== 'string' || filepath.trim().length === 0) {
      throw new Error('Skill storage returned no saved object path');
    }
    savedPath = filepath;
    assertSavedSkillBlobMatchesReservation(operation.reservation, filepath);
    const claimed = await deps.transitionSkillUploadIntent(
      operation.fileId,
      writerId,
      'uploading',
      'committing',
    );
    if (!claimed) {
      throw Object.assign(new Error('Skill upload was cancelled'), { code: 'SKILL_DELETING' });
    }
    persistStarted = true;
    persistedResult = { value: await operation.persist(filepath) };
    const committed = await deps.transitionSkillUploadIntent(
      operation.fileId,
      writerId,
      'committing',
      'committed',
    );
    if (!committed) throw new Error('Skill upload commit acknowledgement failed');
    return persistedResult.value;
  } catch (error) {
    let persisted: T | null = null;
    if (persistStarted) {
      try {
        persisted = await operation.readPersisted();
      } catch {
        // An attempted database write may have succeeded despite its error.
        // Do not delete a blob that may now belong to a live file row.
        throw error;
      }
    }
    if (persisted !== null) {
      const committed = await deps.transitionSkillUploadIntent(
        operation.fileId,
        writerId,
        'committing',
        'committed',
      );
      if (committed) return persistedResult ? persistedResult.value : persisted;
      throw error;
    }
    // A transient journal error must not skip immediate blob compensation.
    // The final commit acknowledgement may have succeeded in Mongo before
    // its reply was lost, so include that state once the row is known absent.
    // If both journal updates and compensation fail, the reserved intent still
    // supports explicit stopped-writer recovery once the database is healthy.
    for (const from of ['uploading', 'committing', 'committed'] as const) {
      try {
        await deps.transitionSkillUploadIntent(operation.fileId, writerId, from, 'abandoned');
      } catch {
        // Preserve the original upload failure after attempting both states.
      }
    }
    try {
      await operation.deleteReserved(operation.reservation, savedPath);
    } catch {
      // The abandoned intent remains durable for the reconciler.
    }
    throw error;
  }
}
