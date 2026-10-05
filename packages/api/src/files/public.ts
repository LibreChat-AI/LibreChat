import { ContentTypes } from 'librechat-data-provider';
import { isMediaFileId, toMediaAsset } from '@librechat/data-schemas';
import type { MediaAsset, TMessage } from 'librechat-data-provider';

type FileView = Pick<MediaAsset, 'file_id' | 'filepath'> &
  Partial<Pick<MediaAsset, 'filename' | 'type' | 'bytes'>> & {
    source?: string;
    mediaRetainers?: readonly string[];
  };
type PrivateMediaFields<T> =
  | Extract<keyof T, `media${string}`>
  | 'storageKey'
  | 'storageRegion'
  | 'contentDigest';

/** Response-only projection. Storage and provider reads retain the unmodified canonical File. */
export function toPublicFile<T extends FileView>(
  file: T,
): Omit<T, PrivateMediaFields<T>> & { deletionRestriction?: 'retained_media' } {
  if (!isMediaFileId(file.file_id)) return file;
  const publicFields: Partial<T> = { ...file };
  for (const key in publicFields) {
    if (key.startsWith('media') || ['storageKey', 'storageRegion', 'contentDigest'].includes(key)) {
      delete publicFields[key];
    }
  }
  const original = toMediaAsset({
    file_id: file.file_id,
    filename: file.filename ?? '',
    filepath: file.filepath,
    type: file.type ?? '',
    bytes: file.bytes ?? 0,
    source: file.source ?? 'local',
  });
  return {
    ...publicFields,
    filepath: original.filepath,
    ...(file.mediaRetainers?.length ? { deletionRestriction: 'retained_media' as const } : {}),
  } as Omit<T, PrivateMediaFields<T>> & { deletionRestriction?: 'retained_media' };
}

export function toPublicFiles<T extends FileView>(
  files: T[],
): Array<Omit<T, PrivateMediaFields<T>>> {
  return files.map(toPublicFile);
}

function isFileView(value: unknown): value is FileView {
  return (
    value != null &&
    typeof value === 'object' &&
    'file_id' in value &&
    typeof value.file_id === 'string' &&
    'filepath' in value &&
    typeof value.filepath === 'string'
  );
}

type MessageFileFields = Pick<TMessage, 'files' | 'attachments' | 'content'>;

/** Saved message snapshots can predate the canonical media URL; no File lookup is required. */
export function toPublicMessageFiles<T extends MessageFileFields>(message: T): T {
  const result = { ...message };
  if (Array.isArray(message.files)) {
    result.files = message.files.map((file) => (isFileView(file) ? toPublicFile(file) : file));
  }
  if (Array.isArray(message.attachments)) {
    result.attachments = message.attachments.map((file) =>
      isFileView(file) ? toPublicFile(file) : file,
    );
  }
  if (Array.isArray(result.content)) {
    result.content = result.content.map((part) => {
      if (part?.type === ContentTypes.IMAGE_FILE && isFileView(part.image_file)) {
        return { ...part, image_file: toPublicFile(part.image_file) };
      }
      if (part?.type === ContentTypes.STEER && Array.isArray(part.files)) {
        return {
          ...part,
          files: part.files.map((file) => (isFileView(file) ? toPublicFile(file) : file)),
        };
      }
      return part;
    });
  }
  return result;
}

export function toPublicMessagePage<T extends { messages: MessageFileFields[] }>(page: T): T {
  if (!Array.isArray(page.messages)) return page;
  return {
    ...page,
    messages: page.messages.map(toPublicMessageFiles),
  };
}
