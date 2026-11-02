import type { FileSources, TFile, TMessage, TAttachment } from 'librechat-data-provider';

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

/** Text-routed images use the file action so their extracted preview is reachable. */
export function usesImagePreview(file: Partial<Pick<TFile, 'type' | 'llmDeliveryPath'>>): boolean {
  return file.type?.startsWith('image/') === true && file.llmDeliveryPath !== 'text';
}

/**
 * Filters a part's mapped attachments to its saved-agent and host run-step
 * owner. Provider tool-call ids repeat across agents and turns, so
 * `toolCallId` alone can route sibling output to the wrong card. Missing
 * attachment ownership remains a wildcard for legacy rows; a live part with
 * no step excludes step identities already owned by message siblings.
 */
export function filterAttachmentsForPart(
  attachments: TAttachment[] | undefined,
  partAgentId?: string,
  partStepId?: string,
  siblingStepIds?: ReadonlySet<string>,
): TAttachment[] | undefined {
  if (
    !attachments ||
    (partAgentId == null &&
      partStepId == null &&
      (siblingStepIds == null || siblingStepIds.size === 0))
  ) {
    return attachments;
  }
  const filtered = attachments.filter((attachment) => {
    const agentMatches =
      partAgentId == null || attachment.agentId == null || attachment.agentId === partAgentId;
    const stepMatches =
      partStepId != null
        ? attachment.stepId == null || attachment.stepId === partStepId
        : attachment.stepId == null || siblingStepIds?.has(attachment.stepId) !== true;
    return agentMatches && stepMatches;
  });
  return filtered.length === attachments.length ? attachments : filtered;
}
