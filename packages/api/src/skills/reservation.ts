import { FileContext, FileSources } from 'librechat-data-provider';
import type { SaveBufferParams } from '~/storage/types';
import { extractKeyFromS3Url, getS3Key, parseS3Key } from '~/storage/s3/crud';
import { extractFirebaseBlobPath } from '~/storage/ownedBlobDelete';
import { getStorageMetadata } from '~/storage/metadata';

type FutureURL = (params: {
  userId: string;
  fileName: string;
  basePath: 'uploads';
  tenantId?: string;
  storageRegion?: string | null;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
}) => Promise<string>;
type WriteLocation = Omit<SaveBufferParams, 'buffer'> & { basePath: 'uploads' };

export interface SkillBlobReservation {
  readonly source: string;
  readonly filepath: string;
  readonly storageKey?: string;
  readonly storageRegion?: string;
  readonly writeLocation: Readonly<WriteLocation>;
}

type SkillStorageStrategy = {
  saveBuffer?: (params: SaveBufferParams) => Promise<string>;
  deleteFile?: unknown;
  getFileURL?: FutureURL | null;
};

type ResolvedSkillStorage = {
  source: string;
  saveBuffer: (params: SaveBufferParams) => Promise<string>;
  getFileURL?: FutureURL | null;
};

type SavedSkillBuffer = {
  filepath: string;
  source: string;
  storageKey?: string;
  storageRegion?: string;
};

function freezeReservation(reservation: SkillBlobReservation): SkillBlobReservation {
  return Object.freeze({
    ...reservation,
    writeLocation: Object.freeze({ ...reservation.writeLocation }),
  });
}

/** Select and validate one Skill store; callers keep its writer for this upload. */
export function createSkillStorageResolver<TConfig>(deps: {
  getFileStrategy: (config: TConfig, options: { context: FileContext; isImage: boolean }) => string;
  getStrategyFunctions: (source: string) => SkillStorageStrategy;
}): (config: TConfig, options: { isImage: boolean }) => ResolvedSkillStorage {
  return (config: TConfig, options: { isImage: boolean }) => {
    const source = deps.getFileStrategy(config, {
      context: FileContext.skill_file,
      isImage: options.isImage,
    });
    const strategy = deps.getStrategyFunctions(source);
    if (typeof strategy.saveBuffer !== 'function' || typeof strategy.deleteFile !== 'function') {
      throw new Error('Skill storage cannot guarantee cleanup');
    }
    return { source, saveBuffer: strategy.saveBuffer, getFileURL: strategy.getFileURL };
  };
}

/** Write with the already-reserved provider, even if live configuration changes. */
export function createSkillBufferWriter(deps: {
  getStrategyFunctions: (source: string) => SkillStorageStrategy;
}): (params: { reservation: SkillBlobReservation; buffer: Buffer }) => Promise<SavedSkillBuffer> {
  return async ({ reservation, buffer }) => {
    const strategy = deps.getStrategyFunctions(reservation.source);
    if (typeof strategy.saveBuffer !== 'function' || typeof strategy.deleteFile !== 'function') {
      throw new Error('Skill storage cannot guarantee cleanup');
    }
    const filepath = await strategy.saveBuffer({ ...reservation.writeLocation, buffer });
    return {
      filepath,
      source: reservation.source,
      ...getStorageMetadata({ filepath, source: reservation.source }),
    };
  };
}

/** Compare provider object identities while ignoring expiring URL signatures. */
export function assertSavedSkillBlobMatchesReservation(
  reservation: SkillBlobReservation,
  savedPath: string,
): void {
  let matches = false;
  try {
    if (reservation.source === FileSources.s3 || reservation.source === FileSources.cloudfront) {
      matches = extractKeyFromS3Url(savedPath) === reservation.storageKey;
    } else if (reservation.source === FileSources.firebase) {
      matches =
        extractFirebaseBlobPath(savedPath) === extractFirebaseBlobPath(reservation.filepath);
    } else if (reservation.source === FileSources.azure_blob) {
      const savedURL = new URL(savedPath);
      const reservedURL = new URL(reservation.filepath);
      matches =
        savedURL.origin === reservedURL.origin && savedURL.pathname === reservedURL.pathname;
    } else {
      matches = savedPath === reservation.filepath;
    }
  } catch {
    // A malformed provider result is not proof that the journal names its object.
  }
  if (!matches) throw new Error('Skill storage wrote outside its reserved location');
}

/**
 * All supported Skill stores can name the future object before writing it.
 * This reference goes into Mongo first, closing the upload-before-row gap.
 */
export async function reserveSkillBlob(params: {
  source: string;
  userId: string;
  fileName: string;
  tenantId?: string;
  storageRegion?: string | null;
  includeRegionInPath?: boolean;
  useInlinePath?: boolean;
  getFileURL?: FutureURL | null;
}): Promise<SkillBlobReservation> {
  const {
    source,
    userId,
    fileName,
    tenantId,
    storageRegion,
    includeRegionInPath,
    useInlinePath,
    getFileURL,
  } = params;
  if (!userId || !fileName || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('Invalid Skill storage identity');
  }
  const writeLocation: WriteLocation = { userId, fileName, basePath: 'uploads', tenantId };
  if (source === FileSources.local) {
    return freezeReservation({ source, filepath: `/uploads/${userId}/${fileName}`, writeLocation });
  }
  if (source === FileSources.firebase) {
    const key = `uploads/${userId}/${fileName}`;
    return freezeReservation({
      source,
      filepath: `https://firebase.invalid/o/${encodeURIComponent(key)}`,
      writeLocation,
    });
  }
  if (
    source !== FileSources.s3 &&
    source !== FileSources.cloudfront &&
    source !== FileSources.azure_blob
  ) {
    throw new Error('Unsupported Skill storage strategy');
  }
  if (!getFileURL) throw new Error('Skill storage strategy cannot reserve an object');
  const filepath = await getFileURL({
    userId,
    fileName,
    basePath: 'uploads',
    tenantId,
    storageRegion,
    includeRegionInPath,
    useInlinePath,
  });
  if (!filepath) throw new Error('Skill storage strategy returned no reserved object');
  if (source === FileSources.azure_blob) {
    const path = new URL(filepath).pathname.split('/').map(decodeURIComponent);
    if (path.slice(-3).join('/') !== `uploads/${userId}/${fileName}`) {
      throw new Error('Skill storage strategy returned a different reserved object');
    }
    return freezeReservation({ source, filepath, writeLocation });
  }
  const key = extractKeyFromS3Url(filepath);
  const parsed = parseS3Key(key);
  if (
    !parsed ||
    parsed.basePath !== 'uploads' ||
    parsed.userId !== userId ||
    parsed.fileName !== fileName ||
    (parsed.tenantId ?? undefined) !== tenantId ||
    parsed.useInlinePath
  ) {
    throw new Error('Skill storage strategy returned a different reserved object');
  }
  const plannedLocation: WriteLocation = {
    ...writeLocation,
    storageRegion: parsed.storageRegion,
    includeRegionInPath: Boolean(parsed.storageRegion),
    useInlinePath: false,
  };
  if (getS3Key(plannedLocation) !== key) {
    throw new Error('Skill storage strategy returned an ambiguous reserved object');
  }
  return freezeReservation({
    source,
    filepath,
    storageKey: key,
    storageRegion: parsed.storageRegion,
    writeLocation: plannedLocation,
  });
}

/** Selects and validates the provider before reserving a future Skill object. */
export function createSkillBlobReserver<TConfig>(deps: {
  getFileStrategy: (config: TConfig, options: { context: FileContext; isImage: boolean }) => string;
  getStrategyFunctions: (source: string) => SkillStorageStrategy;
}) {
  const resolveStorage = createSkillStorageResolver(deps);
  return async (
    config: TConfig | Promise<TConfig>,
    params: {
      userId: string;
      fileName: string;
      isImage: boolean;
      tenantId?: string;
      storageRegion?: string | null;
      includeRegionInPath?: boolean;
      useInlinePath?: boolean;
    },
  ): Promise<SkillBlobReservation> => {
    const { source, getFileURL } = resolveStorage(await config, params);
    return reserveSkillBlob({
      source,
      userId: params.userId,
      fileName: params.fileName,
      tenantId: params.tenantId,
      storageRegion: params.storageRegion,
      includeRegionInPath: params.includeRegionInPath,
      useInlinePath: params.useInlinePath,
      getFileURL,
    });
  };
}
