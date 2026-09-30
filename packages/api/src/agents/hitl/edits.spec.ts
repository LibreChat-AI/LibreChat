import { z } from 'zod';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@librechat/agents/langchain/tools';
import { ToolNode, executeHooks } from '@librechat/agents';
import {
  Command,
  END,
  START,
  MemorySaver,
  StateGraph,
  MessagesAnnotation,
} from '@langchain/langgraph';
import type { Agents } from 'librechat-data-provider';
import type { ToolApprovalHook } from './hooks';
import { buildApprovalPreview } from '../../../../../client/src/components/Chat/approval/preview';
import { collectNativeEditFileAgentIds } from './byom';
import { buildHITLRunWiring } from './runtime';
import { normalizeEditArgs } from '../edits';

const nativeAgentIds = new Set(['native-agent']);
const effectiveInput = {
  path: 'workspace/example.ts',
  edits: [{ old_text: 'original', new_text: 'replacement', replace_all: true }],
};

function evaluate(
  wiring: NonNullable<ReturnType<typeof buildHITLRunWiring>>,
  toolInput: Parameters<ToolApprovalHook>[0]['toolInput'],
  executingAgentId = 'native-agent',
) {
  return executeHooks({
    registry: wiring.hooks,
    matchQuery: 'edit_file',
    input: {
      hook_event_name: 'PreToolUse',
      runId: 'edit-run',
      executingAgentId,
      toolName: 'edit_file',
      toolUseId: 'edit-call',
      toolInput,
    },
  });
}

describe('native edit approval normalization', () => {
  test.each([[], '[]', null, {}, 'not json', [null]].map((edits) => [edits]))(
    'denies malformed supplied edits %# before asking for approval',
    async (edits) => {
      const hook = jest.fn(async () => ({ decision: 'ask' as const }));
      const wiring = buildHITLRunWiring({ enabled: true }, {}, [], [{ hook }], nativeAgentIds)!;
      const result = await evaluate(wiring, {
        path: effectiveInput.path,
        edits,
        old_text: 'original',
        new_text: 'replacement',
      });
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('edit');
      expect(hook).not.toHaveBeenCalled();
      expect(result.updatedInput).toBeUndefined();
    },
  );

  test.each([
    { old_text: 'original', new_text: 'replacement', replace_all: 'true' },
    { edits: JSON.stringify(effectiveInput.edits) },
    { edits: effectiveInput.edits.map((edit) => JSON.stringify(edit)) },
  ])('offers the same canonical replacements execution consumes: %#', async (args) => {
    const hook = jest.fn(async () => ({}));
    const wiring = buildHITLRunWiring({ enabled: true }, {}, [], [{ hook }], nativeAgentIds)!;
    const result = await evaluate(wiring, {
      path: effectiveInput.path,
      intent: 'Updating',
      ...args,
    });
    expect(result.decision).toBe('ask');
    expect(result.updatedInput).toEqual({ ...effectiveInput, intent: 'Updating' });
    expect(hook.mock.calls[0]).toEqual([
      expect.objectContaining({ toolInput: { ...effectiveInput, intent: 'Updating' } }),
      expect.anything(),
    ]);
    expect(normalizeEditArgs(result.updatedInput!)).toEqual(effectiveInput.edits);
    expect(result.updatedInput).not.toHaveProperty('old_text');
    expect(result.updatedInput).not.toHaveProperty('replace_all');
  });

  test('normalizes hook rewrites and preserves last-writer precedence over abstaining hooks', async () => {
    const wiring = buildHITLRunWiring(
      { enabled: true },
      {},
      [],
      [
        {
          hook: async () => ({
            updatedInput: {
              path: effectiveInput.path,
              edits: JSON.stringify([{ old_text: 'rewritten', new_text: '' }]),
              old_text: 'ignored',
              new_text: 'ignored',
            },
          }),
        },
        { hook: async () => ({}) },
        { hook: async () => ({}), matcher: '^unrelated$' },
      ],
      nativeAgentIds,
    )!;
    const result = await evaluate(wiring, effectiveInput);
    expect(result.decision).toBe('ask');
    expect(result.updatedInput).toEqual({
      path: effectiveInput.path,
      edits: [{ old_text: 'rewritten', new_text: '' }],
    });
  });

  test('denies a malformed hook rewrite rather than displaying or executing a fallback', async () => {
    const wiring = buildHITLRunWiring(
      { enabled: true, mode: 'bypass' },
      {},
      [],
      [{ hook: async () => ({ updatedInput: { ...effectiveInput, edits: [] } }) }],
      nativeAgentIds,
    )!;
    expect((await evaluate(wiring, effectiveInput)).decision).toBe('deny');
  });

  test('leaves same-name external tools untouched', async () => {
    const wiring = buildHITLRunWiring({ enabled: true }, {}, [], [], nativeAgentIds)!;
    const result = await evaluate(
      wiring,
      { edits: [], arbitrary: 'external contract' },
      'external',
    );
    expect(result.decision).toBe('ask');
    expect(result.updatedInput).toBeUndefined();
  });

  test('uses live provenance for lazily initialized native agents', async () => {
    const ids = new Set<string>();
    const wiring = buildHITLRunWiring({ enabled: true }, {}, [], [], ids)!;
    ids.add('native-agent');
    expect((await evaluate(wiring, effectiveInput)).updatedInput).toEqual(effectiveInput);
  });
});

describe('collectNativeEditFileAgentIds', () => {
  test('walks children and registries, but excludes per-agent name conflicts', () => {
    expect(
      collectNativeEditFileAgentIds([
        {
          id: 'native-agent',
          toolDefinitions: [{ name: 'edit_file', toolType: 'builtin' }],
          lazySubagentConfigs: [
            {
              id: 'child',
              toolRegistry: new Map([['edit_file', { name: 'edit_file', toolType: 'builtin' }]]),
            },
          ],
        },
        {
          id: 'external',
          toolDefinitions: [{ name: 'edit_file', toolType: 'mcp' }],
        },
        {
          id: 'conflict',
          toolDefinitions: [{ name: 'edit_file', toolType: 'builtin' }],
          toolRegistry: new Map([['edit_file', { name: 'edit_file', toolType: 'mcp' }]]),
        },
      ]),
    ).toEqual(new Set(['native-agent', 'child']));
  });
});

describe('native edit approval interrupt and resume', () => {
  test('displays and executes the same canonical replacements after a real pause', async () => {
    const captured: (typeof effectiveInput)[] = [];
    const editTool = tool(
      async (args) => {
        captured.push(args);
        return 'updated';
      },
      {
        name: 'edit_file',
        description: 'Native edit regression fixture',
        schema: z.object({
          path: z.string(),
          edits: z.array(
            z.object({
              old_text: z.string(),
              new_text: z.string(),
              replace_all: z.boolean(),
            }),
          ),
        }),
      },
    );
    const wiring = buildHITLRunWiring({ enabled: true }, {}, [], [], nativeAgentIds)!;
    const node = new ToolNode<typeof MessagesAnnotation.State>({
      tools: [editTool],
      hookRegistry: wiring.hooks,
      humanInTheLoop: wiring.humanInTheLoop,
      executingAgentId: 'native-agent',
    });
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('tools', node)
      .addEdge(START, 'tools')
      .addEdge('tools', END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'edit-thread', run_id: 'edit-run' } };
    await graph.invoke(
      {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [
              {
                id: 'edit-call',
                name: 'edit_file',
                args: {
                  path: effectiveInput.path,
                  edits: JSON.stringify(effectiveInput.edits),
                  old_text: 'not approved',
                  new_text: 'not approved',
                },
              },
            ],
          }),
        ],
      },
      config,
    );
    const snapshot = await graph.getState(config);
    const payload = snapshot.tasks[0].interrupts[0].value as Agents.ToolApprovalInterruptPayload;
    expect(payload.type).toBe('tool_approval');
    expect(payload.action_requests[0].arguments).toEqual(effectiveInput);
    expect(captured).toEqual([]);
    const preview = buildApprovalPreview({
      ...payload.action_requests[0],
      source: 'librechat_code',
    });
    expect(JSON.parse(preview.body)).toEqual(effectiveInput.edits);
    await graph.invoke(new Command({ resume: { 'edit-call': { type: 'approve' } } }), config);
    expect(captured).toEqual([effectiveInput]);
    expect(JSON.parse(preview.body)).toEqual(captured[0].edits);
  });
});
