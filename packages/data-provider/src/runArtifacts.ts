import type { TAttachment } from './schemas';
import type { Agents } from './types/agents';

type SelectionPart = {
  type?: string;
  tool_call?: unknown;
};

type RunFileAttachment = TAttachment & {
  metadata?: {
    runFile?: {
      runId?: string;
      agentId?: string;
      outputPath?: string;
      selectionId?: string;
      selectionOrdinal?: number;
    };
  };
};

type SelectedOutput = {
  ordinal: number;
  status: Agents.OutputSelectionStatus;
  fileId?: string;
  selectionId?: string;
};

function getOutputSelection(
  part: SelectionPart | null | undefined,
): Agents.OutputSelection | undefined {
  if (part?.type !== 'tool_call' || part.tool_call == null || typeof part.tool_call !== 'object') {
    return undefined;
  }
  return (part.tool_call as { outputSelection?: Agents.OutputSelection }).outputSelection;
}

function isOutputSelection(value: unknown): value is Agents.OutputSelection {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const selection = value as Partial<Agents.OutputSelection>;
  return (
    selection.version === 1 &&
    typeof selection.runId === 'string' &&
    selection.runId.length > 0 &&
    typeof selection.agentId === 'string' &&
    selection.agentId.length > 0 &&
    typeof selection.stepId === 'string' &&
    selection.stepId.length > 0 &&
    typeof selection.toolCallId === 'string' &&
    selection.toolCallId.length > 0 &&
    Number.isSafeInteger(selection.ordinal) &&
    (selection.ordinal ?? 0) > 0 &&
    Array.isArray(selection.paths)
  );
}

function outputSlotKey(
  conversationId: string | null | undefined,
  runId: string,
  agentId: string,
  outputPath: string,
): string {
  return JSON.stringify([conversationId ?? '', runId, agentId, outputPath]);
}

/** Hides superseded explicit Code outputs in the UI without removing file history. */
export function reduceRunArtifactAttachments(input: {
  attachments: readonly TAttachment[];
  content: readonly (SelectionPart | null | undefined)[];
  conversationId?: string | null;
}): TAttachment[] {
  const { attachments, content, conversationId } = input;
  const currentBySlot = new Map<string, SelectedOutput>();
  const contentSelectionSlots = new Set<string>();

  for (const part of content) {
    const selection = getOutputSelection(part);
    if (!isOutputSelection(selection)) {
      continue;
    }
    for (const selectedPath of selection.paths) {
      if (
        typeof selectedPath.outputPath !== 'string' ||
        selectedPath.outputPath.length === 0 ||
        selectedPath.status !== 'published'
      ) {
        continue;
      }
      const key = outputSlotKey(
        conversationId,
        selection.runId,
        selection.agentId,
        selectedPath.outputPath,
      );
      const current = currentBySlot.get(key);
      contentSelectionSlots.add(key);
      if (!current || selection.ordinal >= current.ordinal) {
        currentBySlot.set(key, {
          ordinal: selection.ordinal,
          status: 'published',
          fileId: selectedPath.fileId,
          selectionId: selectedPath.selectionId,
        });
      }
    }
  }

  /* Older saved messages may have durable run-file rows but no tool-call selection state. */
  for (const attachment of attachments) {
    const file = attachment as RunFileAttachment;
    const runFile = file.metadata?.runFile;
    if (
      typeof runFile?.runId !== 'string' ||
      typeof runFile.agentId !== 'string' ||
      typeof runFile.outputPath !== 'string' ||
      !Number.isSafeInteger(runFile.selectionOrdinal) ||
      (runFile.selectionOrdinal ?? 0) < 1 ||
      (conversationId != null && file.conversationId !== conversationId)
    ) {
      continue;
    }
    const key = outputSlotKey(conversationId, runFile.runId, runFile.agentId, runFile.outputPath);
    if (contentSelectionSlots.has(key)) {
      continue;
    }
    const current = currentBySlot.get(key);
    if (!current || (runFile.selectionOrdinal ?? 0) > current.ordinal) {
      currentBySlot.set(key, {
        ordinal: runFile.selectionOrdinal ?? 0,
        status: 'published',
        fileId: 'file_id' in file && typeof file.file_id === 'string' ? file.file_id : undefined,
        selectionId: runFile.selectionId,
      });
    }
  }

  return attachments.filter((attachment) => {
    const file = attachment as RunFileAttachment;
    const runFile = file.metadata?.runFile;
    if (
      typeof runFile?.runId !== 'string' ||
      typeof runFile.agentId !== 'string' ||
      typeof runFile.outputPath !== 'string' ||
      (conversationId != null && file.conversationId !== conversationId)
    ) {
      return true;
    }
    const current = currentBySlot.get(
      outputSlotKey(conversationId, runFile.runId, runFile.agentId, runFile.outputPath),
    );
    if (!current) {
      return true;
    }
    if (current.fileId && 'file_id' in file) {
      return file.file_id === current.fileId;
    }
    if (current.selectionId) {
      return runFile.selectionId === current.selectionId;
    }
    return runFile.selectionOrdinal === current.ordinal;
  });
}
