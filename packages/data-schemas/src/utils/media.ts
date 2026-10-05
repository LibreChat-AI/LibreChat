import type { MediaAsset } from 'librechat-data-provider';
import type { MediaAssetContent, MediaOwnerScope } from '~/types/media';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/** Public projection of a loaded media File. Original locations stay private to storage readers. */
export function toMediaAsset(
  content: MediaAsset & Partial<Pick<MediaAssetContent, 'source' | 'mediaRenditions'>>,
): MediaAsset {
  const contentPath = `/api/media/assets/${encodeURIComponent(content.file_id)}/content`;
  const renditions = content.mediaRenditions
    ? Object.fromEntries(
        Object.entries(content.mediaRenditions).map(([kind, rendition]) => [
          kind,
          {
            filepath: `${contentPath}?rendition=${kind}`,
            type: rendition.type,
            bytes: rendition.bytes,
            ...(rendition.width != null ? { width: rendition.width } : {}),
            ...(rendition.height != null ? { height: rendition.height } : {}),
            ...(rendition.durationSeconds != null
              ? { durationSeconds: rendition.durationSeconds }
              : {}),
          },
        ]),
      )
    : content.renditions;
  return {
    file_id: content.file_id,
    filename: content.filename,
    type: content.type,
    bytes: content.bytes,
    filepath: content.source ? contentPath : content.filepath,
    ...(renditions ? { renditions } : {}),
    ...(content.width != null ? { width: content.width } : {}),
    ...(content.height != null ? { height: content.height } : {}),
    ...(content.durationSeconds != null ? { durationSeconds: content.durationSeconds } : {}),
  };
}

export class MediaPersistenceError extends Error {
  readonly code:
    | 'conflict'
    | 'version_conflict'
    | 'capacity'
    | 'not_found'
    | 'retired'
    | 'invalid_input'
    | 'unsafe_retry';
  constructor(code: MediaPersistenceError['code'], message: string) {
    super(message);
    this.name = 'MediaPersistenceError';
    this.code = code;
  }
}

export function isMediaTenantScope(tenantId: string | null | undefined): boolean {
  const context = tenantStorage.getStore()?.tenantId;
  return (
    tenantId !== '' &&
    tenantId !== SYSTEM_TENANT_ID &&
    !(context && context !== SYSTEM_TENANT_ID && context !== tenantId)
  );
}

export function assertMediaTenant(tenantId: string | null | undefined): void {
  if (!isMediaTenantScope(tenantId)) {
    throw new MediaPersistenceError('not_found', 'Media tenant is unavailable');
  }
}

export function mediaScopeFilter(scope: MediaOwnerScope): MediaOwnerScope {
  if (!scope.ownerId || !isMediaTenantScope(scope.tenantId)) {
    throw new MediaPersistenceError('not_found', 'Media owner scope is unavailable');
  }
  return { ownerId: scope.ownerId, tenantId: scope.tenantId ?? null };
}

export function positiveMediaLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new MediaPersistenceError('invalid_input', 'A positive media limit is required');
  }
  return value;
}
