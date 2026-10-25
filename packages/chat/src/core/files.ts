import type { FileSources, TFile, TMessage } from 'librechat-data-provider';

/** A file attached to a chat pane's composer, from local pick through upload. */
export interface ExtendedFile {
  file?: File;
  file_id: string;
  temp_file_id?: string;
  type?: string;
  filepath?: string;
  filename?: string;
  width?: number;
  height?: number;
  size: number;
  preview?: string;
  progress: number;
  source?: FileSources;
  attached?: boolean;
  embedded?: boolean;
  llmDeliveryPath?: TFile['llmDeliveryPath'];
  tool_resource?: string;
  metadata?: TFile['metadata'];
}

export type FileDeliveryMetadataMap = Readonly<
  Record<string, Pick<TFile, 'llmDeliveryPath'> | undefined>
>;

/** Restores display-only delivery metadata that an older replica may have
 * omitted from a persisted attachment ref. The persisted ref wins, followed
 * by the matching process-local ref, then the owner-scoped stored file map. */
export function hydrateFileDeliveryMetadata(
  persistedFiles: TMessage['files'],
  localFiles?: TMessage['files'],
  storedFiles?: FileDeliveryMetadataMap,
): TMessage['files'] {
  if (persistedFiles == null || persistedFiles.length === 0) {
    return persistedFiles;
  }
  const localById = new Map(
    (localFiles ?? []).flatMap((file) =>
      file.file_id != null ? [[file.file_id, file] as const] : [],
    ),
  );
  let changed = false;
  const hydrated = persistedFiles.map((file) => {
    const local = file.file_id == null ? undefined : localById.get(file.file_id);
    const stored = file.file_id == null ? undefined : storedFiles?.[file.file_id];
    const llmDeliveryPath = local?.llmDeliveryPath ?? stored?.llmDeliveryPath;
    if (file.llmDeliveryPath != null || llmDeliveryPath == null) {
      return file;
    }
    changed = true;
    return { ...file, llmDeliveryPath };
  });
  return changed ? hydrated : persistedFiles;
}
