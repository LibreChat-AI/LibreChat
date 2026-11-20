import type { ISkillDeletion, ISkillUploadIntent } from '~/types/skillDeletion';
import type { ISkillFile } from '~/types/skill';

export interface SkillDeletionRecord {
  skillId: string;
  completedAt?: Date;
}

export interface SkillUploadIntentRecord {
  skillId: string;
  author: string;
  fileId: string;
  source: string;
  storageKey: string;
  tenantId?: string;
  state: 'uploading' | 'committing' | 'committed' | 'abandoned';
  cleanedAt?: Date;
}

export interface SkillDeletionFileRecord {
  file_id: string;
  filepath: string;
  source: string;
  storageKey?: string;
  storageRegion?: string;
  author: string;
  tenantId?: string;
}

type Source = {
  iterateSkillCleanupFiles: (
    id: string,
    batchSize: number,
  ) => AsyncIterable<
    Array<
      Pick<
        ISkillFile,
        'file_id' | 'filepath' | 'source' | 'storageKey' | 'storageRegion' | 'author' | 'tenantId'
      >
    >
  >;
  iterateSkillCleanupIntents: (
    id: string,
    batchSize: number,
  ) => AsyncIterable<
    Array<
      Pick<
        ISkillUploadIntent,
        | 'skillId'
        | 'author'
        | 'fileId'
        | 'source'
        | 'storageKey'
        | 'tenantId'
        | 'state'
        | 'cleanedAt'
      >
    >
  >;
  hasInFlightSkillUploads: (id: string) => Promise<boolean>;
  listExistingSkillFileIds: (id: string, fileIds: string[]) => Promise<string[]>;
  beginSkillDeletion: (
    id: string,
  ) => Promise<Pick<ISkillDeletion, 'skillId' | 'completedAt'> | null>;
  getSkillDeletion: (id: string) => Promise<Pick<ISkillDeletion, 'skillId' | 'completedAt'> | null>;
  listSkillDeletionTombstones: (
    limit: number,
  ) => Promise<Array<Pick<ISkillDeletion, 'skillId' | 'completedAt'>>>;
  listSkillUploadIntents: (
    id: string,
    options?: { cleanupOnly?: boolean },
  ) => Promise<
    Array<
      Pick<
        ISkillUploadIntent,
        | 'skillId'
        | 'author'
        | 'fileId'
        | 'source'
        | 'storageKey'
        | 'tenantId'
        | 'state'
        | 'cleanedAt'
      >
    >
  >;
  listAbandonedSkillUploadIntents: (
    limit: number,
  ) => Promise<
    Array<
      Pick<
        ISkillUploadIntent,
        | 'skillId'
        | 'author'
        | 'fileId'
        | 'source'
        | 'storageKey'
        | 'tenantId'
        | 'state'
        | 'cleanedAt'
      >
    >
  >;
  listSkillFiles: (
    id: string,
  ) => Promise<
    Array<
      Pick<
        ISkillFile,
        'file_id' | 'filepath' | 'source' | 'storageKey' | 'storageRegion' | 'author' | 'tenantId'
      >
    >
  >;
};

function journal(row: Pick<ISkillDeletion, 'skillId' | 'completedAt'>): SkillDeletionRecord {
  return { skillId: row.skillId.toString(), completedAt: row.completedAt };
}

function intent(
  row: Pick<
    ISkillUploadIntent,
    'skillId' | 'author' | 'fileId' | 'source' | 'storageKey' | 'tenantId' | 'state' | 'cleanedAt'
  >,
): SkillUploadIntentRecord {
  return {
    skillId: row.skillId.toString(),
    author: row.author.toString(),
    fileId: row.fileId,
    source: row.source,
    storageKey: row.storageKey,
    tenantId: row.tenantId,
    state: row.state,
    cleanedAt: row.cleanedAt,
  };
}

function file(
  row: Pick<
    ISkillFile,
    'file_id' | 'filepath' | 'source' | 'storageKey' | 'storageRegion' | 'author' | 'tenantId'
  >,
): SkillDeletionFileRecord {
  return {
    file_id: row.file_id,
    filepath: row.filepath,
    source: row.source,
    storageKey: row.storageKey,
    storageRegion: row.storageRegion,
    author: row.author.toString(),
    tenantId: row.tenantId,
  };
}

/** Project database records once, before they cross into the storage-independent API service. */
export function createSkillDeletionPersistenceAdapter(source: Source): {
  iterateSkillCleanupFiles: (
    id: string,
    batchSize: number,
  ) => AsyncIterable<SkillDeletionFileRecord[]>;
  iterateSkillCleanupIntents: (
    id: string,
    batchSize: number,
  ) => AsyncIterable<SkillUploadIntentRecord[]>;
  hasInFlightSkillUploads: (id: string) => Promise<boolean>;
  listExistingSkillFileIds: (id: string, fileIds: string[]) => Promise<string[]>;
  beginSkillDeletion: (id: string) => Promise<SkillDeletionRecord | null>;
  getSkillDeletion: (id: string) => Promise<SkillDeletionRecord | null>;
  listSkillDeletionTombstones: (limit: number) => Promise<SkillDeletionRecord[]>;
  listSkillUploadIntents: (id: string) => Promise<SkillUploadIntentRecord[]>;
  listAbandonedSkillUploadIntents: (limit: number) => Promise<SkillUploadIntentRecord[]>;
  listSkillFiles: (id: string) => Promise<SkillDeletionFileRecord[]>;
} {
  return {
    iterateSkillCleanupFiles: async function* (id, batchSize) {
      for await (const rows of source.iterateSkillCleanupFiles(id, batchSize)) yield rows.map(file);
    },
    iterateSkillCleanupIntents: async function* (id, batchSize) {
      for await (const rows of source.iterateSkillCleanupIntents(id, batchSize))
        yield rows.map(intent);
    },
    hasInFlightSkillUploads: (id) => source.hasInFlightSkillUploads(id),
    listExistingSkillFileIds: (id, fileIds) => source.listExistingSkillFileIds(id, fileIds),
    beginSkillDeletion: async (id: string): Promise<SkillDeletionRecord | null> => {
      const row = await source.beginSkillDeletion(id);
      return row ? journal(row) : null;
    },
    getSkillDeletion: async (id: string): Promise<SkillDeletionRecord | null> => {
      const row = await source.getSkillDeletion(id);
      return row ? journal(row) : null;
    },
    listSkillDeletionTombstones: async (limit: number): Promise<SkillDeletionRecord[]> =>
      (await source.listSkillDeletionTombstones(limit)).map(journal),
    listSkillUploadIntents: async (id: string): Promise<SkillUploadIntentRecord[]> =>
      (await source.listSkillUploadIntents(id, { cleanupOnly: true })).map(intent),
    listAbandonedSkillUploadIntents: async (limit: number): Promise<SkillUploadIntentRecord[]> =>
      (await source.listAbandonedSkillUploadIntents(limit)).map(intent),
    listSkillFiles: async (id: string): Promise<SkillDeletionFileRecord[]> =>
      (await source.listSkillFiles(id)).map(file),
  };
}
