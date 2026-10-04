import type { SubagentActivityItem } from 'librechat-data-provider';
import type { SubagentTaskSnapshot } from '@librechat/agents';
import type { ActivitySnapshot, ActivityTree } from './tree';
import {
  ACTIVITY_TREE_LIMITS,
  boundActivityTree,
  snapshotActivity,
  boundActivitySummary,
  summarizeActivityTree,
  activityTreeFromProjection,
} from './tree';
import { boundedClaim } from '../subagentTaskRouting';
import { ActivityRecorder } from './recorder';
import { renderDigest } from './view';

function recordedTree(): ActivityTree {
  const recorder = new ActivityRecorder(0);
  recorder.record(
    {
      runId: 'root',
      subagentRunId: 'child',
      subagentType: 'reviewer',
      subagentAgentId: 'agent',
      phase: 'run_step',
      data: {
        id: 'step',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call', name: 'bash_tool', args: { intent: 'Run the tests' } }],
        },
      },
      timestamp: '2026-10-04T12:00:00.000Z',
    },
    10,
  );
  return recorder.snapshot();
}

const snapshot = (extra: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
  taskId: 'task-1',
  threadId: 'thread-1',
  subagentType: 'reviewer',
  status: 'running',
  createdAt: 0,
  updatedAt: 10,
  resultAvailable: false,
  resultClaimed: false,
  pendingControls: 0,
  ...extra,
});

describe('boundActivityTree', () => {
  it('accepts a recorded tree unchanged after a JSON round trip', () => {
    const tree = recordedTree();
    expect(boundActivityTree(JSON.parse(JSON.stringify(tree)))).toEqual(tree);
  });

  it('re-sanitizes peer-supplied names and labels', () => {
    const tree = recordedTree();
    const leaf = tree.root.turns[0].children[0];
    leaf.name = `evil\u0007${'n'.repeat(200)}`;
    leaf.label = 'Label \\ui{x}\u2066 tail';
    const bounded = boundActivityTree(tree);
    const boundedLeaf = bounded?.root.turns[0].children[0];
    expect(boundedLeaf?.name?.length).toBe(ACTIVITY_TREE_LIMITS.nameChars);
    expect(boundedLeaf?.name?.startsWith('evil n')).toBe(true);
    expect(boundedLeaf?.label).toBe('Label tail');
  });

  it('refuses malformed, oversized, or over-deep trees instead of renumbering them', () => {
    const tree = recordedTree();
    expect(boundActivityTree({ ...tree, version: 2 })).toBeUndefined();
    expect(
      boundActivityTree({
        ...tree,
        root: {
          turns: [{ startedAt: 0, children: [{ kind: 'tool', status: 'weird', startedAt: 0 }] }],
        },
      }),
    ).toBeUndefined();
    const tooMany = {
      ...tree,
      root: {
        turns: Array.from({ length: ACTIVITY_TREE_LIMITS.rootTurns + 1 }, () => ({
          startedAt: 0,
          children: [],
        })),
      },
    };
    expect(boundActivityTree(tooMany)).toBeUndefined();
    const crowded = {
      ...tree,
      root: {
        turns: Array.from({ length: 12 }, () => ({
          startedAt: 0,
          children: Array.from({ length: 30 }, () => ({
            kind: 'tool',
            status: 'ok',
            startedAt: 0,
          })),
        })),
      },
    };
    expect(boundActivityTree(crowded)).toBeUndefined();

    let deepLeaf: Record<string, unknown> = { kind: 'tool', status: 'ok', startedAt: 0 };
    for (let depth = 0; depth < 5; depth++) {
      deepLeaf = {
        kind: 'tool',
        status: 'ok',
        startedAt: 0,
        run: { turns: [{ startedAt: 0, children: [deepLeaf] }] },
      };
    }
    const deep = boundActivityTree({
      version: 1,
      updatedAt: 0,
      root: { turns: [{ startedAt: 0, children: [deepLeaf] }] },
    });
    const level2 = deep?.root.turns[0].children[0].run?.turns[0].children[0];
    expect(level2?.run?.turns[0].children[0].run).toBeUndefined();
  });

  it('travels through the routed claim bounds and drops undecodable decorations', () => {
    const tree = recordedTree();
    const routed = JSON.parse(
      JSON.stringify(boundedClaim({ status: 'running', task: snapshot({ activity: tree }) })),
    ) as { task: SubagentTaskSnapshot };
    expect(snapshotActivity(routed.task)).toEqual(tree);

    const tampered = boundedClaim({
      status: 'running',
      task: snapshot({ activity: { version: 1 } as unknown as ActivityTree }),
    });
    expect('task' in tampered && 'activity' in tampered.task).toBe(false);
  });

  it('bounds list summaries to counts and one in-flight leaf', () => {
    const summary = summarizeActivityTree(recordedTree());
    expect(summary).toEqual({
      turns: 1,
      tools: 1,
      errors: 0,
      updatedAt: 10,
      active: {
        path: '1.1',
        leaf: expect.objectContaining({ name: 'bash_tool', label: 'Run the tests' }),
      },
    });
    expect(boundActivitySummary(JSON.parse(JSON.stringify(summary)))).toEqual({
      ...summary,
      active: {
        path: '1.1',
        leaf: {
          kind: 'tool',
          name: 'bash_tool',
          label: 'Run the tests',
          status: 'running',
          startedAt: 10,
        },
      },
    });
    expect(
      boundActivitySummary({ ...summary, active: { path: '../x', leaf: summary.active?.leaf } }),
    ).not.toHaveProperty('active');
  });
});

describe('activityTreeFromProjection', () => {
  it('splits turns at replies after tool results and keeps only intents and sizes', () => {
    const items: SubagentActivityItem[] = [
      { type: 'reasoning', text: 'private chain of thought' },
      { type: 'writing', text: 'I will inspect the routing code.' },
      {
        type: 'tool',
        toolCallId: 'a',
        name: 'read_file',
        input: JSON.stringify({ intent: 'Reading routing', path: '/srv/.env' }),
        output: 'API_KEY=secret',
        status: 'completed',
      },
      {
        type: 'tool',
        toolCallId: 'b',
        name: 'bash_tool',
        input: '{"command":"ls"}',
        status: 'failed',
      },
      { type: 'writing', text: 'Final answer with private details.' },
    ];
    const tree = activityTreeFromProjection(items, { startedAt: 100, settledAt: 900 });
    expect(tree?.root.turns.map((turn) => turn.children.map((leaf) => leaf.kind))).toEqual([
      ['text', 'tool', 'tool'],
      ['text'],
    ]);
    expect(tree?.root.turns[0].children[1]).toEqual({
      kind: 'tool',
      name: 'read_file',
      label: 'Reading routing',
      status: 'ok',
      startedAt: 100,
      endedAt: 900,
      chars: 14,
    });
    expect(tree?.root.turns[0].children[2].status).toBe('error');
    const serialized = JSON.stringify(tree);
    for (const secret of ['secret', 'private', '.env', 'inspect', 'command']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('re-checks completed calls for failures and marks the tree as rebuilt', () => {
    const items: SubagentActivityItem[] = [
      {
        type: 'tool',
        toolCallId: 'a',
        name: 'bash_tool',
        output: 'Error: tool call failed: exit 2',
        status: 'completed',
      },
      {
        type: 'tool',
        toolCallId: 'b',
        name: 'edit_file',
        status: 'completed',
        inputValidationError: true,
      },
      { type: 'tool', toolCallId: 'c', name: 'read_file', output: 'fine', status: 'completed' },
    ];
    const tree = activityTreeFromProjection(items, { startedAt: 0, settledAt: 1, truncated: true });
    expect(tree?.root.turns[0].children.map((leaf) => leaf.status)).toEqual([
      'error',
      'error',
      'ok',
    ]);
    expect(tree?.rebuilt).toEqual({ partial: true });
    const digest = renderDigest(tree!, { now: 2, running: false });
    expect(digest).toMatchObject({ errors: 2, truncated: true });
    expect(digest.note).toContain('Rebuilt from the saved activity summary');
    expect(digest.note).toContain('kept only the newest activity');
  });

  it('returns nothing for a projection without steps', () => {
    expect(
      activityTreeFromProjection([{ type: 'reasoning' }], { startedAt: 0, settledAt: 1 }),
    ).toBeUndefined();
  });
});
