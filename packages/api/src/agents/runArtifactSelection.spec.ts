import type { Agents } from 'librechat-data-provider';
import type { OutputSelectionCall } from './runArtifactSelection';
import { createRunArtifactSelectionRegistry } from './runArtifactSelection';

type SelectionPart = {
  type: 'tool_call';
  agentId: string;
  tool_call: OutputSelectionCall & { name: string };
};

describe('run artifact output selection registry', () => {
  it('assigns finalized A to B to A calls in dispatch order and attaches each to its exact run step', () => {
    const contentParts: SelectionPart[] = [
      { type: 'tool_call', agentId: 'agent-a', tool_call: { id: 'call-a', name: 'bash_tool' } },
      { type: 'tool_call', agentId: 'agent-a', tool_call: { id: 'call-b', name: 'bash_tool' } },
      { type: 'tool_call', agentId: 'agent-a', tool_call: { id: 'call-c', name: 'bash_tool' } },
    ];
    const stepMap = new Map<string, { index: number }>([
      ['step-a', { index: 0 }],
      ['step-b', { index: 1 }],
      ['step-c', { index: 2 }],
    ]);
    const registry = createRunArtifactSelectionRegistry({ contentParts, stepMap });
    const calls: OutputSelectionCall[] = [
      { id: 'call-a', args: { output_paths: ['/mnt/data/r12.txt'] } },
      { id: 'call-b', args: { output_paths: ['/mnt/data/r12.txt'] } },
      { id: 'call-c', args: { output_paths: ['/mnt/data/r12.txt'] } },
    ];

    const stepIds = ['step-a', 'step-b', 'step-c'] as const;
    calls.forEach((call, index) => {
      const stepId = stepIds[index];
      registry.restoreRunStep(
        { id: stepId, stepDetails: { tool_calls: [call] } },
        'run-1',
        'agent-a',
      );
      const selection = registry.assign({ runId: 'run-1', agentId: 'agent-a', stepId, call });
      expect(selection?.ordinal).toBe(index + 1);
      expect(contentParts[index]?.tool_call.outputSelection).toBe(selection);
    });

    expect(calls.map((call) => call.outputSelection?.paths[0]?.outputPath)).toEqual([
      'r12.txt',
      'r12.txt',
      'r12.txt',
    ]);
    expect(
      registry.get({ runId: 'run-1', agentId: 'agent-b', stepId: 'step-c', toolCallId: 'call-c' }),
    ).toBeUndefined();
  });

  it('keeps a selection failure bound to its exact run, agent, step, and tool call', () => {
    const contentParts: SelectionPart[] = [
      { type: 'tool_call', agentId: 'agent-a', tool_call: { id: 'call-a', name: 'bash_tool' } },
    ];
    const registry = createRunArtifactSelectionRegistry({
      contentParts,
      stepMap: new Map<string, { index: number }>([['step-a', { index: 0 }]]),
    });
    const call: OutputSelectionCall = {
      id: 'call-a',
      args: { output_paths: ['../outside.txt'] },
    };
    registry.restoreRunStep(
      { id: 'step-a', stepDetails: { tool_calls: [call] } },
      'run-1',
      'agent-a',
    );
    const selection = registry.assign({
      runId: 'run-1',
      agentId: 'agent-a',
      stepId: 'step-a',
      call,
    });

    expect(selection).toMatchObject({ status: 'failed', failureKind: 'selection' });
    expect(
      registry.markFailed(
        { runId: 'run-1', agentId: 'agent-b', stepId: 'step-a', toolCallId: 'call-a' },
        'execution',
        'tool_execution_error',
      ),
    ).toBeUndefined();
    expect(
      registry.get({ runId: 'run-1', agentId: 'agent-a', stepId: 'step-a', toolCallId: 'call-a' }),
    ).toMatchObject({ status: 'failed', failureKind: 'selection' });
  });

  it('ignores a selection copied from another run when restoring a completed call', () => {
    const contentParts: SelectionPart[] = [
      { type: 'tool_call', agentId: 'agent-a', tool_call: { id: 'call-a', name: 'bash_tool' } },
    ];
    const registry = createRunArtifactSelectionRegistry({
      contentParts,
      stepMap: new Map<string, { index: number }>([['step-a', { index: 0 }]]),
    });
    const copiedSelection: Agents.OutputSelection = {
      version: 1,
      runId: 'other-run',
      agentId: 'agent-a',
      stepId: 'step-a',
      toolCallId: 'call-a',
      ordinal: 1,
      status: 'published',
      paths: [],
    };
    registry.restoreCompleted(
      { id: 'step-a', tool_call: { id: 'call-a', outputSelection: copiedSelection } },
      'run-1',
      'agent-a',
    );
    expect(contentParts[0]?.tool_call.outputSelection).toBeUndefined();
  });
});
