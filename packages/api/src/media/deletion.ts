import { randomUUID } from 'node:crypto';
import { isMediaFileId } from '@librechat/data-schemas';
import type { MediaMethods, MediaOwnerScope } from '@librechat/data-schemas';
import type { MediaObjectLocation, MediaStrategyResolver } from './objects';
import {
  createLocalMediaObjectStore,
  createMediaStrategyObjectStores,
  removeMediaObjectLocations,
} from './objects';
import { MediaServiceError } from './errors';

type DeletionRepository = Pick<
  MediaMethods,
  'claimMediaAssetDeletion' | 'completeMediaAssetDeletion'
>;

/** The storage acknowledgment covers every planned and committed object before the tombstone retires. */
export async function removeMediaAsset({
  repository,
  scope,
  fileId,
  removeLocations,
}: {
  repository: DeletionRepository;
  scope: MediaOwnerScope;
  fileId: string;
  removeLocations(scope: MediaOwnerScope, locations: MediaObjectLocation[]): Promise<void>;
}): Promise<boolean> {
  const token = randomUUID();
  const content = await repository.claimMediaAssetDeletion({ scope, fileId, token });
  if (!content) return false;
  await removeLocations(scope, [
    ...(content.mediaRenditionLocations ?? []).map((location) => ({
      ...location,
      filepath: location.filepath ?? location.storageKey,
    })),
    ...Object.values(content.mediaRenditions ?? {}),
    content,
  ]);
  return repository.completeMediaAssetDeletion({ scope, fileId, token });
}

/** Every legacy storage-first delete passes this boundary before touching an immutable original. */
export async function deleteMediaAwareFile<
  TRequest extends {
    user?: { id?: string; tenantId?: string };
    config?: { paths?: { imageOutput?: string; uploads?: string } };
  },
  TFile extends { file_id: string },
  TClient,
>({
  request,
  file,
  client,
  deleteFile,
  repository,
  resolveStrategy,
}: {
  request: TRequest;
  file: TFile;
  client?: TClient;
  deleteFile(request: TRequest, file: TFile, client?: TClient): Promise<void>;
  resolveStrategy?: MediaStrategyResolver;
  repository: Pick<
    MediaMethods,
    'isMediaFile' | 'claimMediaAssetDeletion' | 'completeMediaAssetDeletion'
  >;
}): Promise<void> {
  if (!isMediaFileId(file.file_id)) {
    await deleteFile(request, file, client);
    return;
  }
  const ownerId = request.user?.id;
  if (!ownerId) {
    throw new MediaServiceError('forbidden', 403, 'Authentication is required.');
  }
  const scope = { ownerId, tenantId: request.user?.tenantId ?? null };
  if (!(await repository.isMediaFile(scope, file.file_id))) {
    throw new MediaServiceError('not_found', 404, 'Media content is unavailable.');
  }
  const { imageOutput, uploads } = request.config?.paths ?? {};
  if (!imageOutput || !uploads || !resolveStrategy) {
    throw new MediaServiceError('not_ready', 503, 'Media storage deletion is unavailable.');
  }
  const stores = [
    createLocalMediaObjectStore({ imageDirectory: imageOutput, uploadDirectory: uploads }),
    ...createMediaStrategyObjectStores(resolveStrategy),
  ];
  const removed = await removeMediaAsset({
    repository,
    scope,
    fileId: file.file_id,
    removeLocations(owner, locations) {
      return removeMediaObjectLocations(owner, locations, (source) =>
        stores.find((entry) => entry.source === source),
      );
    },
  });
  if (!removed) {
    throw new MediaServiceError(
      'version_conflict',
      409,
      'This original is retained by media history.',
    );
  }
}
