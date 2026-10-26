import type { Agents } from './types/agents';
import type { TAttachment } from './schemas';
import { reduceRunArtifactAttachments } from './runArtifacts';

function artifact(input: {
  fileId: string;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  outputPath?: string;
  ordinal?: number;
  selectionId?: string;
  sourceFileId?: string;
}): TAttachment {
  const outputPath = input.outputPath ?? (input.ordinal == null ? undefined : 'r12-selection.txt');
  return {
    file_id: input.fileId,
    filename: input.outputPath ?? 'r12-selection.txt',
    conversationId: input.conversationId ?? 'conversation-1',
    metadata: {
      runFile: {
        runId: input.runId ?? 'run-1',
        agentId: input.agentId ?? 'agent-1',
        ...(outputPath == null ? {} : { outputPath }),
        ...(input.ordinal == null ? {} : { selectionOrdinal: input.ordinal }),
        ...(input.selectionId == null ? {} : { selectionId: input.selectionId }),
        ...(input.sourceFileId == null ? {} : { sourceFileId: input.sourceFileId }),
      },
    },
  } as TAttachment;
}

function selection(input: {
  ordinal: number;
  fileId: string;
  runId?: string;
  agentId?: string;
  conversationId?: string;
  outputPath?: string;
  selectionId?: string;
}): Agents.OutputSelection {
  return {
    version: 1,
    runId: input.runId ?? 'run-1',
    agentId: input.agentId ?? 'agent-1',
    stepId: `step-${input.ordinal}`,
    toolCallId: `call-${input.ordinal}`,
    ordinal: input.ordinal,
    status: 'published',
    paths: [
      {
        pathIndex: 0,
        outputPath: input.outputPath ?? 'r12-selection.txt',
        status: 'published',
        selectionId: input.selectionId ?? `selection-${input.ordinal}`,
        fileId: input.fileId,
      },
    ],
  };
}

describe('reduceRunArtifactAttachments', () => {
  it('projects the canonical A-to-B-to-A file while retaining immutable and unrelated files', () => {
    const physicalHistory = [
      artifact({
        fileId: 'file-a1',
        ordinal: 1,
        selectionId: 'selection-1',
        sourceFileId: 'src-a1',
      }),
      artifact({
        fileId: 'file-b2',
        ordinal: 2,
        selectionId: 'selection-2',
        sourceFileId: 'src-b2',
      }),
      artifact({
        fileId: 'file-a3',
        ordinal: 3,
        selectionId: 'selection-3',
        sourceFileId: 'src-a3',
      }),
      artifact({ fileId: 'legacy-same-name', outputPath: undefined, ordinal: undefined }),
      artifact({ fileId: 'other-agent', agentId: 'agent-2', ordinal: 3 }),
      artifact({ fileId: 'other-run', runId: 'run-2', ordinal: 3 }),
    ];
    const visible = reduceRunArtifactAttachments({
      attachments: physicalHistory,
      conversationId: 'conversation-1',
      content: [
        null,
        {
          type: 'tool_call',
          tool_call: { outputSelection: selection({ ordinal: 1, fileId: 'file-a1' }) },
        },
        undefined,
        {
          type: 'tool_call',
          tool_call: { outputSelection: selection({ ordinal: 2, fileId: 'file-b2' }) },
        },
        {
          type: 'tool_call',
          tool_call: { outputSelection: selection({ ordinal: 3, fileId: 'file-a1' }) },
        },
      ],
    });

    expect(visible.map((file) => file.file_id)).toEqual([
      'file-a1',
      'legacy-same-name',
      'other-agent',
      'other-run',
    ]);
    expect(physicalHistory.map((file) => file.file_id)).toHaveLength(6);
  });

  it('uses the newest durable ordinal when selection content is sparse and preserves legacy rows', () => {
    const physicalHistory = [
      artifact({ fileId: 'older', ordinal: 1, selectionId: 'older-selection' }),
      artifact({ fileId: 'newer', ordinal: 3, selectionId: 'newer-selection' }),
      artifact({ fileId: 'legacy', ordinal: undefined, selectionId: undefined }),
    ];
    const visible = reduceRunArtifactAttachments({
      attachments: physicalHistory,
      content: [undefined, null],
      conversationId: 'conversation-1',
    });

    expect(visible.map((file) => file.file_id)).toEqual(['newer', 'legacy']);
  });
});
