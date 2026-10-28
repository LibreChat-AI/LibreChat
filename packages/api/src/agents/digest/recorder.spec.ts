import type { SubagentUpdateEvent } from '@librechat/agents';
import { ACTIVITY_TREE_LIMITS, countLeaves, findActiveLeaf } from './tree';
import { ActivityRecorder } from './recorder';

type Phase = SubagentUpdateEvent['phase'];

function event(
  phase: Phase,
  data: unknown,
  overrides: Partial<SubagentUpdateEvent> = {},
): SubagentUpdateEvent {
  return {
    runId: 'root-run',
    parentRunId: 'parent-run',
    subagentRunId: 'child-run',
    parentToolCallId: 'parent-call',
    subagentType: 'reviewer',
    subagentKind: 'agent',
    subagentAgentId: 'agent-reviewer',
    phase,
    data,
    timestamp: '2026-10-04T12:00:00.000Z',
    ...overrides,
  };
}

const toolStep = (stepId: string, calls: Array<{ id: string; name: string; args?: unknown }>) =>
  event('run_step', { id: stepId, stepDetails: { type: 'tool_calls', tool_calls: calls } });

const completed = (id: string, name: string, output: string, extra: Record<string, unknown> = {}) =>
  event('run_step_completed', {
    result: { type: 'tool_call', tool_call: { id, name, output, ...extra } },
  });

const text = (stepId: string, value: string) =>
  event('message_delta', { id: stepId, delta: { content: [{ type: 'text', text: value }] } });

describe('ActivityRecorder', () => {
  it('folds turns from step events and keeps only names, labels, statuses, and sizes', () => {
    const recorder = new ActivityRecorder(1_000);
    recorder.record(event('start', undefined), 1_000);
    recorder.record(text('msg-1', 'SECRET reply text that must stay private.'), 1_100);
    recorder.record(
      toolStep('step-1', [
        {
          id: 'call-1',
          name: 'bash_tool',
          args: { intent: 'Running the jest suite', command: 'TOKEN=sk-live-123 npm test' },
        },
        { id: 'call-2', name: 'read_file', args: JSON.stringify({ path: '/etc/secret.env' }) },
      ]),
      1_200,
    );
    recorder.record(completed('call-1', 'bash_tool', 'PASS 12 tests'), 1_700);
    recorder.record(
      completed('call-2', 'read_file', 'Error: tool call failed: ENOENT /etc/secret.env'),
      1_800,
    );
    recorder.record(toolStep('step-2', [{ id: 'call-3', name: 'search_workspace' }]), 2_000);

    const tree = recorder.snapshot();
    expect(tree.root.turns).toHaveLength(2);
    expect(tree.root.turns[0].children).toEqual([
      expect.objectContaining({ kind: 'text', status: 'ok', chars: 41 }),
      expect.objectContaining({
        kind: 'tool',
        name: 'bash_tool',
        label: 'Running the jest suite',
        status: 'ok',
        startedAt: 1_200,
        endedAt: 1_700,
        chars: 13,
      }),
      expect.objectContaining({ kind: 'tool', name: 'read_file', status: 'error' }),
    ]);
    expect(tree.root.turns[1].children).toEqual([
      expect.objectContaining({ name: 'search_workspace', status: 'running' }),
    ]);
    expect(findActiveLeaf(tree.root)?.path).toBe('2.1');
    const serialized = JSON.stringify(tree);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('sk-live');
    expect(serialized).not.toContain('secret.env');
    expect(serialized).not.toContain('PASS 12');
  });

  it('keeps tool calls streamed as separate steps of one response in one turn', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(toolStep('step-a', [{ id: 'a', name: 'read_file' }]), 10);
    recorder.record(toolStep('step-b', [{ id: 'b', name: 'read_file' }]), 11);
    recorder.record(
      event('tool_calls_dispatched', {
        dispatched_at: 12,
        toolCalls: [
          { id: 'a', name: 'read_file' },
          { id: 'b', name: 'read_file' },
        ],
      }),
      12,
    );
    recorder.record(completed('a', 'read_file', 'one'), 20);
    recorder.record(completed('b', 'read_file', 'two'), 21);
    recorder.record(text('msg-2', 'Done.'), 30);

    const tree = recorder.snapshot();
    expect(tree.root.turns.map((turn) => turn.children.length)).toEqual([2, 1]);
  });

  it('prefers the tool-authored outcome and reads complete args from execution requests', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(toolStep('step-1', [{ id: 'call', name: 'edit_file', args: '' }]), 1);
    recorder.record(
      event('run_step', {
        toolCalls: [{ id: 'call', name: 'edit_file', args: { intent: 'Editing background.ts' } }],
      }),
      2,
    );
    expect(recorder.snapshot().root.turns[0].children[0].label).toBe('Editing background.ts');
    recorder.record(
      completed('call', 'edit_file', 'Updated 1 file', { outcome: 'Edited background.ts' }),
      3,
    );
    expect(recorder.snapshot().root.turns[0].children[0]).toMatchObject({
      label: 'Edited background.ts',
      status: 'ok',
    });
  });

  it('sanitizes labels to one bounded line without rendering markers', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(
      toolStep('step', [
        {
          id: 'call',
          name: 'bash\u0000_tool',
          args: { intent: `Line one\nline two \\ui{abc} \u202e${'x'.repeat(400)}` },
        },
      ]),
      1,
    );
    const leaf = recorder.snapshot().root.turns[0].children[0];
    expect(leaf.name).toBe('bash _tool');
    expect(leaf.label?.startsWith('Line one line two ')).toBe(true);
    expect(leaf.label).not.toContain('\\ui{');
    expect(leaf.label).not.toContain('\u202e');
    expect(leaf.label?.length).toBe(ACTIVITY_TREE_LIMITS.labelChars);
    expect(leaf.label?.endsWith('…')).toBe(true);
  });

  it('reads intent only as the injected first-property label, never a business field', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(
      toolStep('step', [
        { id: 'a', name: 'dialogflow_detect', args: { query: 'refund', intent: 'billing.refund' } },
        { id: 'b', name: 'web_search', args: '{"intent":"Searching the changelog","q":"x"}' },
      ]),
      1,
    );
    const [business, labeled] = recorder.snapshot().root.turns[0].children;
    expect(business.label).toBeUndefined();
    expect(labeled.label).toBe('Searching the changelog');
  });

  it('marks calls of a failed or cancelled step and settles open nodes with the task', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(toolStep('step-1', [{ id: 'a', name: 'bash_tool' }]), 1);
    recorder.record(event('run_step_closed', { id: 'step-1', status: 'failed' }), 2);
    expect(recorder.snapshot().root.turns[0].children[0].status).toBe('error');

    recorder.record(toolStep('step-2', [{ id: 'b', name: 'bash_tool' }]), 3);
    recorder.record(text('msg', 'partial'), 4);
    recorder.settle('cancelled', 5);
    const tree = recorder.snapshot();
    expect(tree.root.turns[1].children.map((leaf) => leaf.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(findActiveLeaf(tree.root)).toBeUndefined();
  });

  it('measures single-part message deltas as well as part arrays', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(
      event('message_delta', { id: 'msg', delta: { content: { type: 'text', text: 'Hello' } } }),
      1,
    );
    recorder.record(text('msg', ' there'), 2);
    expect(recorder.snapshot().root.turns[0].children).toEqual([
      expect.objectContaining({ kind: 'text', status: 'running', chars: 11 }),
    ]);
  });

  it('records a failed reply step and a schema-rejected call as errors', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(text('msg-1', 'partial answer'), 1);
    recorder.record(event('run_step_closed', { id: 'msg-1', status: 'failed' }), 2);
    recorder.record(toolStep('step', [{ id: 'call', name: 'edit_file' }]), 3);
    recorder.record(
      event('run_step_completed', {
        result: {
          type: 'tool_call',
          tool_call: { id: 'call', name: 'edit_file', inputValidationError: true },
        },
      }),
      4,
    );
    const tree = recorder.snapshot();
    expect(tree.root.turns.flatMap((turn) => turn.children.map((leaf) => leaf.status))).toEqual([
      'error',
      'error',
    ]);
  });

  it('counts an overflowed call once across all of its events', () => {
    const recorder = new ActivityRecorder(0);
    const calls = Array.from({ length: ACTIVITY_TREE_LIMITS.turnChildren + 8 }, (_, index) => ({
      id: `call-${index}`,
      name: 'read_file',
      args: { intent: `Read ${index}` },
    }));
    recorder.record(toolStep('step', calls), 1);
    recorder.record(event('run_step', { toolCalls: calls }), 2);
    recorder.record(event('tool_calls_dispatched', { dispatched_at: 3, toolCalls: calls }), 3);
    for (const call of calls) {
      recorder.record(completed(call.id, call.name, 'ok'), 4);
    }
    const [turn] = recorder.snapshot().root.turns;
    expect(turn.children).toHaveLength(ACTIVITY_TREE_LIMITS.turnChildren);
    expect(turn.overflow).toBe(8);
    expect(turn.children.every((leaf) => leaf.status === 'ok')).toBe(true);
  });

  it('nests a subagent the child starts under its calling tool, within the depth bound', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(toolStep('step', [{ id: 'spawn', name: 'subagent' }]), 1);
    const nested = { subagentRunId: 'grandchild-run', parentToolCallId: 'spawn', depth: 2 };
    recorder.record(
      event(
        'run_step',
        {
          id: 'g-step',
          stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'g-call', name: 'web_search' }] },
        },
        nested,
      ),
      2,
    );
    const deeper = { subagentRunId: 'great-run', parentToolCallId: 'g-call', depth: 3 };
    recorder.record(
      event(
        'run_step',
        {
          id: 'gg-step',
          stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'gg-call', name: 'bash_tool' }] },
        },
        deeper,
      ),
      3,
    );
    const tooDeep = { subagentRunId: 'too-deep', parentToolCallId: 'gg-call', depth: 4 };
    recorder.record(
      event(
        'message_delta',
        { id: 'x', delta: { content: [{ type: 'text', text: 'hi' }] } },
        tooDeep,
      ),
      4,
    );

    const tree = recorder.snapshot();
    const spawn = tree.root.turns[0].children[0];
    expect(spawn.run?.turns[0].children[0]).toMatchObject({
      name: 'web_search',
      status: 'running',
    });
    const grand = spawn.run?.turns[0].children[0];
    expect(grand?.run?.turns[0].children[0]).toMatchObject({ name: 'bash_tool' });
    expect(grand?.run?.turns[0].children[0].run).toBeUndefined();
    expect(tree.root.turns).toHaveLength(1);
    expect(findActiveLeaf(tree.root)?.path).toBe('1.1.1.1.1.1');

    recorder.record(completed('spawn', 'subagent', 'Nested result'), 5);
    expect(findActiveLeaf(recorder.snapshot().root)).toBeUndefined();
  });

  it('attaches a nested run to the call of its own parent run when call ids repeat', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(toolStep('root-step', [{ id: 'call_2', name: 'subagent' }]), 1);
    const grandchild = {
      subagentRunId: 'grandchild-run',
      parentRunId: 'child-run',
      parentToolCallId: 'call_2',
    };
    recorder.record(
      event(
        'run_step',
        {
          id: 'g-step',
          stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'call_2', name: 'subagent' }] },
        },
        grandchild,
      ),
      2,
    );
    const greatGrandchild = {
      subagentRunId: 'great-run',
      parentRunId: 'grandchild-run',
      parentToolCallId: 'call_2',
    };
    recorder.record(
      event(
        'message_delta',
        { id: 'x', delta: { content: [{ type: 'text', text: 'hi' }] } },
        greatGrandchild,
      ),
      3,
    );
    const spawn = recorder.snapshot().root.turns[0].children[0];
    expect(spawn.run?.turns[0].children).toHaveLength(1);
    const nestedSpawn = spawn.run?.turns[0].children[0];
    expect(nestedSpawn?.run?.turns[0].children).toEqual([
      expect.objectContaining({ kind: 'text', chars: 2 }),
    ]);
  });

  it('never double-counts overflow however many calls one turn announces', () => {
    const recorder = new ActivityRecorder(0);
    const calls = Array.from({ length: 700 }, (_, index) => ({
      id: `c${index}`,
      name: 'read_file',
    }));
    recorder.record(toolStep('step', calls), 1);
    for (const call of calls) {
      recorder.record(event('run_step', { toolCalls: [call] }), 2);
      recorder.record(completed(call.id, call.name, 'ok'), 3);
    }
    const [turn] = recorder.snapshot().root.turns;
    expect(turn.children.length + (turn.overflow ?? 0)).toBe(700);
  });

  it('folds evicted turns into counts and keeps the tree within its bounds', () => {
    const recorder = new ActivityRecorder(0);
    const turns = ACTIVITY_TREE_LIMITS.rootTurns + 10;
    for (let index = 0; index < turns; index++) {
      const name = index % 3 === 0 ? 'read_file' : 'bash_tool';
      recorder.record(toolStep(`step-${index}`, [{ id: `call-${index}`, name }]), index * 10);
      recorder.record(
        completed(`call-${index}`, name, index === 0 ? 'Error processing tool: boom' : 'ok'),
        index * 10 + 5,
      );
    }
    const tree = recorder.snapshot();
    expect(tree.root.turns).toHaveLength(ACTIVITY_TREE_LIMITS.rootTurns);
    expect(tree.root.evicted).toMatchObject({ turns: 10, errors: 1, startedAt: 0, endedAt: 95 });
    expect(Object.fromEntries(tree.root.evicted?.tools ?? [])).toEqual({
      read_file: 4,
      bash_tool: 6,
    });
  });

  it('caps the retained leaves across the whole tree', () => {
    const recorder = new ActivityRecorder(0);
    for (let turn = 0; turn < 40; turn++) {
      const calls = Array.from({ length: ACTIVITY_TREE_LIMITS.turnChildren + 4 }, (_, index) => ({
        id: `t${turn}-c${index}`,
        name: 'read_file',
      }));
      recorder.record(toolStep(`step-${turn}`, calls), turn);
      for (const call of calls) {
        recorder.record(completed(call.id, 'read_file', 'ok'), turn);
      }
    }
    const tree = recorder.snapshot();
    expect(countLeaves(tree.root)).toBeLessThanOrEqual(ACTIVITY_TREE_LIMITS.leaves);
    expect(tree.root.turns[tree.root.turns.length - 1]?.overflow).toBe(4);
    expect(tree.root.evicted?.turns).toBeGreaterThan(0);
  });

  it('ignores events without a run identity and never throws on malformed data', () => {
    const recorder = new ActivityRecorder(0);
    recorder.record(event('run_step', 'not-an-object'), 1);
    recorder.record(event('run_step_completed', { result: { tool_call: { name: 'x' } } }), 2);
    recorder.record(event('message_delta', { delta: { content: 'nope' } }), 3);
    recorder.record(event('run_step', {}, { subagentRunId: '' }), 4);
    expect(recorder.snapshot().root.turns).toEqual([]);
  });
});
