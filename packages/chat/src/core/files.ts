import { MAX_FILE_TEXT_PREVIEW_LENGTH } from 'librechat-data-provider';
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
  /** Exact local paste, retained synchronously until its upload completes. */
  pastedText?: string;
  /** Staged source superseded by this replacement upload. */
  replacesFileId?: string;
  /** Server-extracted text for attachment previews. */
  text?: string;
  /** Bounded display-only text, never an editable source. */
  textPreview?: string;
  progress: number;
  source?: FileSources;
  attached?: boolean;
  embedded?: boolean;
  llmDeliveryPath?: TFile['llmDeliveryPath'];
  tool_resource?: string;
  metadata?: TFile['metadata'];
}

/** Only an explicit local paste can bypass an unfinished upload. */
export function isInlineablePastedText(
  file: Pick<ExtendedFile, 'progress' | 'pastedText'>,
): file is Pick<ExtendedFile, 'progress' | 'pastedText'> & { pastedText: string } {
  return file.progress < 1 && typeof file.pastedText === 'string';
}

/** A paste cannot close its enclosing fence, even if it contains Markdown fences. */
export function formatPastedText(text: string): string {
  let fenceLength = 3;
  for (const match of text.matchAll(/`+/g)) {
    fenceLength = Math.max(fenceLength, match[0].length + 1);
  }
  const fence = '`'.repeat(fenceLength);
  return `${fence}text\n${text}\n${fence}`;
}

export type PartitionedComposerFiles = {
  text: string;
  files: NonNullable<TMessage['files']>;
  submittedFileIds: (string | undefined)[];
  canceledUploadIds: string[];
  replacedFileIds: string[];
  hasIncompleteFiles: boolean;
};

/** Separates inline fallback from server refs without consuming the draft. */
export function partitionComposerFiles(
  text: string,
  files: ReadonlyMap<string, ExtendedFile>,
): PartitionedComposerFiles {
  const parts = text.length > 0 ? [text] : [];
  const refs: NonNullable<TMessage['files']> = [];
  const submittedFileIds: (string | undefined)[] = [];
  const canceledUploadIds = new Set<string>();
  const replacedFileIds = new Set<string>();
  const replacedSources = new Set<string>();
  for (const file of files.values()) {
    if (isInlineablePastedText(file) && file.replacesFileId) {
      replacedSources.add(file.replacesFileId);
    }
  }
  let hasIncompleteFiles = false;
  for (const [key, file] of files) {
    if (
      replacedSources.has(key) ||
      replacedSources.has(file.file_id) ||
      (file.temp_file_id != null && replacedSources.has(file.temp_file_id))
    ) {
      for (const id of [key, file.file_id, file.temp_file_id]) {
        if (id) {
          replacedFileIds.add(id);
        }
      }
      continue;
    }
    if (isInlineablePastedText(file)) {
      parts.push(formatPastedText(file.pastedText));
      for (const id of [key, file.file_id, file.temp_file_id]) {
        if (id) {
          canceledUploadIds.add(id);
        }
      }
      continue;
    }
    hasIncompleteFiles ||= file.progress < 1;
    refs.push({
      file_id: file.file_id,
      filepath: file.filepath,
      filename: file.filename,
      type: file.type ?? '',
      llmDeliveryPath: file.llmDeliveryPath,
      height: file.height,
      width: file.width,
      bytes: file.size,
      ...(/^text\/plain(?:;|$)/i.test(file.type ?? '') && {
        textPreview: (file.pastedText ?? file.textPreview ?? file.text)?.slice(
          0,
          MAX_FILE_TEXT_PREVIEW_LENGTH,
        ),
      }),
    });
    submittedFileIds.push(key, file.file_id, file.temp_file_id);
  }
  return {
    text: parts.join('\n\n'),
    files: refs,
    submittedFileIds,
    canceledUploadIds: [...canceledUploadIds],
    replacedFileIds: [...replacedFileIds],
    hasIncompleteFiles,
  };
}

export type FileDeliveryMetadataMap = Readonly<
  Record<string, Pick<TFile, 'llmDeliveryPath' | 'textPreview' | 'text'> | undefined>
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
    const llmDeliveryPath =
      file.llmDeliveryPath ?? local?.llmDeliveryPath ?? stored?.llmDeliveryPath;
    const textPreview = file.textPreview ?? local?.textPreview ?? stored?.textPreview;
    if (file.llmDeliveryPath === llmDeliveryPath && file.textPreview === textPreview) return file;
    changed = true;
    return { ...file, llmDeliveryPath, textPreview };
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
