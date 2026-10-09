import type { TFile } from 'librechat-data-provider';

export interface SteerRequestUser {
  id?: string;
  tenantId?: string;
}

function isLlmDeliveryPath(value: unknown): value is NonNullable<TFile['llmDeliveryPath']> {
  return value === 'provider' || value === 'text' || value === 'none';
}

/**
 * Copies the display-metadata fields a steer attachment ref may carry,
 * dropping everything else. The single source of truth for the ref shape —
 * used by the request sanitizer (untrusted client input) and the media
 * builder (trusted DB docs) alike; the per-field type checks are the
 * validation for the former and harmless for the latter. Only `file_id` is
 * ever meaningful server-side: the drain re-fetches owner-scoped and
 * re-derives everything else.
 *
 * Returns `null` when there is no usable `file_id`.
 */
export function toSteerFileRef(raw: unknown): Partial<TFile> | null {
  if (raw == null || typeof raw !== 'object') {
    return null;
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.file_id !== 'string' || candidate.file_id.length === 0) {
    return null;
  }
  return {
    file_id: candidate.file_id,
    ...(typeof candidate.type === 'string' && { type: candidate.type }),
    ...(typeof candidate.filepath === 'string' && { filepath: candidate.filepath }),
    ...(typeof candidate.filename === 'string' && { filename: candidate.filename }),
    ...(isLlmDeliveryPath(candidate.llmDeliveryPath) && {
      llmDeliveryPath: candidate.llmDeliveryPath,
    }),
    ...(typeof candidate.height === 'number' && { height: candidate.height }),
    ...(typeof candidate.width === 'number' && { width: candidate.width }),
    ...(typeof candidate.bytes === 'number' && { bytes: candidate.bytes }),
  };
}

/** Unique, order-preserving `file_id`s from a steer ref list. */
export function collectFileIds(files: Partial<TFile>[] | undefined): string[] {
  return [
    ...new Set(
      (files ?? [])
        .map((file) => file?.file_id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  ];
}

/** Owner-scoped `db.getFiles` filter shared by the enqueue-time resolve and
 *  the injection/replay fetches; `null` when there is nothing to scope with. */
export function buildOwnerFilter(
  fileIds: string[],
  user: SteerRequestUser | undefined,
): Record<string, unknown> | null {
  if (!user?.id || fileIds.length === 0) {
    return null;
  }
  const filter: Record<string, unknown> = { file_id: { $in: fileIds }, user: user.id };
  if (user.tenantId) {
    filter.tenantId = user.tenantId;
  }
  return filter;
}
