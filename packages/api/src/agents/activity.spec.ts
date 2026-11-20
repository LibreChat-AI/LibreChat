import { createContentAggregator, GraphEvents } from '@librechat/agents';
import type { SubagentUpdateEvent } from '@librechat/agents';
import {
  SubagentPublicRecorder,
  projectPersistedMessageActivity,
  projectPersistedMessageActivityJson,
  projectSubagentActivity,
  SUBAGENT_ACTIVITY_LIMITS,
} from './activity';

describe('durable subagent activity projection', () => {
  it('drops negative or non-finite persisted child timings', () => {
    const result = projectPersistedMessageActivity([
      {
        type: 'tool',
        toolCallId: 'call-child',
        name: 'query',
        runStepStatus: 'completed',
        toolPreparationStartedAt: -1,
        toolDispatchedAt: Infinity,
        toolPreparationDurationMs: -400,
        toolExecutionDurationMs: NaN,
      },
    ]);
    expect(result.activity[0]).toEqual({
      type: 'tool',
      toolCallId: 'call-child',
      name: 'query',
      status: 'completed',
    });
  });

  it('preserves split tool timing through a bounded persisted child view', () => {
    const result = projectPersistedMessageActivity([
      {
        type: 'tool',
        toolCallId: 'call-child',
        name: 'query',
        runStepStatus: 'completed',
        toolPreparationStartedAt: 100,
        toolDispatchedAt: 500,
        toolPreparationDurationMs: 400,
        toolExecutionDurationMs: 40,
      },
    ]);
    expect(result.activity[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-child',
      toolPreparationStartedAt: 100,
      toolDispatchedAt: 500,
      toolPreparationDurationMs: 400,
      toolExecutionDurationMs: 40,
    });
  });
  it('projects ordinary persisted chat content into the shared activity vocabulary', () => {
    const projection = projectPersistedMessageActivity([
      { type: 'reasoning' },
      {
        type: 'activity_label',
        label: 'Selected a legal move',
        labelType: 'phase',
        toolCallIds: ['move-1'],
        labelTruncated: true,
      },
      {
        type: 'tool',
        toolCallId: 'move-1',
        name: 'submit_move',
        input: '{"uci":"e2e4"}',
        output: '{"accepted":true}',
        progress: 1,
        inputValidationError: true,
        inputTruncated: true,
        outputTruncated: true,
      },
      { type: 'writing', text: 'Move submitted.' },
    ]);

    expect(projection).toEqual({
      activity: [
        { type: 'reasoning' },
        {
          type: 'activity_label',
          label: 'Selected a legal move',
          labelType: 'phase',
          toolCallIds: ['move-1'],
          labelTruncated: true,
        },
        {
          type: 'tool',
          toolCallId: 'move-1',
          name: 'submit_move',
          input: '{"uci":"e2e4"}',
          output: '{"accepted":true}',
          status: 'completed',
          inputValidationError: true,
          inputTruncated: true,
          outputTruncated: true,
        },
        { type: 'writing', text: 'Move submitted.' },
      ],
      truncated: false,
    });
  });

  it('validates a settlement-time public activity projection without private transcript parsing', () => {
    const projection = projectPersistedMessageActivityJson(
      JSON.stringify([{ type: 'reasoning' }, { type: 'writing', text: 'Public result.' }]),
    );

    expect(projection).toEqual({
      activity: [{ type: 'reasoning' }, { type: 'writing', text: 'Public result.' }],
      truncated: false,
    });
    expect(projectPersistedMessageActivityJson('{')).toEqual({
      activity: [],
      truncated: true,
    });
  });

  it('keeps visible text, reasoning text, and tool lifecycle while dropping private metadata', () => {
    const projection = projectSubagentActivity(
      JSON.stringify([
        {
          type: 'ai',
          data: {
            content: [
              { type: 'reasoning', reasoning: 'private chain of thought' },
              { type: 'text', text: 'I will check.' },
            ],
            tool_calls: [{ id: 'call-1', name: 'search', args: { query: 'release' } }],
            response_metadata: { providerRequestId: 'private-request' },
          },
        },
        {
          type: 'tool',
          data: {
            tool_call_id: 'call-1',
            name: 'search',
            content: 'Found it.',
            status: 'success',
            artifact: { secret: 'never expose' },
          },
        },
      ]),
    );

    expect(projection).toEqual({
      activity: [
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'writing', text: 'I will check.' },
        {
          type: 'tool',
          toolCallId: 'call-1',
          name: 'search',
          input: '{"query":"release"}',
          output: 'Found it.',
          status: 'completed',
        },
      ],
      truncated: false,
    });
    expect(JSON.stringify(projection)).not.toContain('private-request');
    expect(JSON.stringify(projection)).not.toContain('never expose');
  });

  it('bounds oversized reasoning text and marks the truncation', () => {
    const projection = projectSubagentActivity(
      JSON.stringify([
        {
          type: 'ai',
          data: {
            content: [
              {
                type: 'reasoning',
                reasoning: 'r'.repeat(SUBAGENT_ACTIVITY_LIMITS.textBytes + 1024),
              },
            ],
          },
        },
      ]),
    );

    const [item] = projection.activity;
    expect(item).toEqual(expect.objectContaining({ type: 'reasoning', textTruncated: true }));
    expect(Buffer.byteLength((item as { text?: string }).text ?? '', 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_ACTIVITY_LIMITS.textBytes,
    );
  });

  it('fails closed on invalid input and bounds adversarial activity', () => {
    expect(projectSubagentActivity('{')).toEqual({ activity: [], truncated: true });

    const projection = projectSubagentActivity(
      JSON.stringify(
        Array.from({ length: 500 }, (_, index) => ({
          type: 'ai',
          data: {
            content: '🧵'.repeat(SUBAGENT_ACTIVITY_LIMITS.textBytes),
            tool_calls: [
              {
                id: `call-${index}`,
                name: 'tool',
                args: { value: 'x'.repeat(SUBAGENT_ACTIVITY_LIMITS.toolInputBytes * 2) },
              },
            ],
          },
        })),
      ),
    );

    expect(projection.truncated).toBe(true);
    expect(projection.activity.length).toBeLessThanOrEqual(SUBAGENT_ACTIVITY_LIMITS.items);
    expect(Buffer.byteLength(JSON.stringify(projection.activity), 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_ACTIVITY_LIMITS.bytes,
    );
    expect(projection.activity[projection.activity.length - 1]).toEqual(
      expect.objectContaining({ type: 'tool', toolCallId: 'call-499' }),
    );
  });

  it.each([
    ['error', 'failed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
    ['success', 'completed'],
  ] as const)('maps a %s tool result to the %s public lifecycle', (stored, expected) => {
    const projection = projectSubagentActivity(
      JSON.stringify([
        { type: 'ai', data: { tool_calls: [{ id: 'call', name: 'search', args: {} }] } },
        { type: 'tool', data: { tool_call_id: 'call', name: 'search', status: stored } },
      ]),
    );

    expect(projection.activity[0]).toEqual(expect.objectContaining({ status: expected }));
  });

  it('shows only the selected invocation segment from a replacement transcript', () => {
    const projection = projectSubagentActivity(
      JSON.stringify([
        { type: 'human', data: { content: 'Earlier request.' } },
        { type: 'ai', data: { content: 'Earlier private activity.' } },
        { type: 'human', data: { content: 'Selected request.' } },
        { type: 'ai', data: { content: 'Selected activity.' } },
      ]),
      'replace',
      'Selected request.',
    );

    expect(projection.activity).toEqual([{ type: 'writing', text: 'Selected activity.' }]);
    expect(JSON.stringify(projection)).not.toContain('Earlier private activity.');
    expect(
      projectSubagentActivity('[{"type":"ai","data":{"content":"old"}}]', 'replace', 'new'),
    ).toEqual({ activity: [], truncated: true });
    expect(
      projectSubagentActivity(
        '[{"type":"human","data":{"content":"different"}}]',
        'replace',
        'selected',
      ),
    ).toEqual({ activity: [], truncated: true });
    expect(
      projectSubagentActivity('[{"type":"human","data":{"content":"selected"}}]', 'replace'),
    ).toEqual({ activity: [], truncated: true });
  });

  it('correlates repeated provider tool IDs by occurrence without merging their results', () => {
    const projection = projectSubagentActivity(
      JSON.stringify([
        { type: 'ai', data: { tool_calls: [{ id: 'call', name: 'first', args: {} }] } },
        { type: 'ai', data: { tool_calls: [{ id: 'call', name: 'second', args: {} }] } },
        { type: 'tool', data: { tool_call_id: 'call', content: 'first result' } },
        { type: 'tool', data: { tool_call_id: 'call', content: 'second result' } },
      ]),
    );

    expect(projection.activity).toEqual([
      expect.objectContaining({
        toolCallId: 'call',
        name: 'first',
        output: 'first result',
        status: 'completed',
      }),
      expect.objectContaining({
        toolCallId: 'call#2',
        name: 'second',
        output: 'second result',
        status: 'completed',
      }),
    ]);
  });

  it('correlates a large repeated-ID queue in FIFO order within the item cap', () => {
    const count = SUBAGENT_ACTIVITY_LIMITS.items * 3;
    const projection = projectSubagentActivity(
      JSON.stringify([
        ...Array.from({ length: count }, (_, index) => ({
          type: 'ai',
          data: { tool_calls: [{ id: 'call', name: `tool-${index}`, args: {} }] },
        })),
        ...Array.from({ length: count }, (_, index) => ({
          type: 'tool',
          data: { tool_call_id: 'call', content: `result-${index}` },
        })),
      ]),
    );

    expect(projection.activity).toHaveLength(SUBAGENT_ACTIVITY_LIMITS.items);
    expect(projection.activity[0]).toEqual(
      expect.objectContaining({
        toolCallId: 'call#201',
        name: 'tool-200',
        output: 'result-200',
      }),
    );
    expect(projection.activity[projection.activity.length - 1]).toEqual(
      expect.objectContaining({
        toolCallId: 'call#300',
        name: 'tool-299',
        output: 'result-299',
      }),
    );
  });

  it('allocates suffixes globally when long provider IDs share a truncated namespace', () => {
    const prefix = 'x'.repeat(510);
    const first = `${prefix}aa`;
    const second = `${prefix}bb`;
    const projection = projectSubagentActivity(
      JSON.stringify([
        {
          type: 'ai',
          data: {
            tool_calls: [
              { id: first, name: 'first-a' },
              { id: first, name: 'first-b' },
              { id: second, name: 'second-a' },
              { id: second, name: 'second-b' },
            ],
          },
        },
      ]),
    );

    const ids = projection.activity.flatMap((item) =>
      item.type === 'tool' ? [item.toolCallId] : [],
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([first, `${prefix}#2`, second, `${prefix}#3`]);
  });

  it('retains a late tool completion even when its declaration predates the item tail', () => {
    const projection = projectSubagentActivity(
      JSON.stringify([
        { type: 'ai', data: { tool_calls: [{ id: 'early', name: 'search', args: {} }] } },
        ...Array.from({ length: SUBAGENT_ACTIVITY_LIMITS.items + 10 }, (_, index) => ({
          type: 'ai',
          data: { content: `update-${index}` },
        })),
        { type: 'tool', data: { tool_call_id: 'early', content: 'late result' } },
      ]),
    );

    expect(projection.truncated).toBe(true);
    expect(projection.activity[projection.activity.length - 1]).toEqual(
      expect.objectContaining({
        type: 'tool',
        toolCallId: 'early',
        output: 'late result',
        status: 'completed',
      }),
    );
  });

  it('keeps an escape-heavy terminal result within the serialized byte cap', () => {
    const projection = projectSubagentActivity(
      JSON.stringify([
        { type: 'ai', data: { tool_calls: [{ id: 'terminal', name: 'compute', args: {} }] } },
        {
          type: 'tool',
          data: {
            tool_call_id: 'terminal',
            content: '\u0000'.repeat(SUBAGENT_ACTIVITY_LIMITS.toolOutputBytes),
          },
        },
      ]),
    );

    expect(projection.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(projection.activity), 'utf8')).toBeLessThanOrEqual(
      SUBAGENT_ACTIVITY_LIMITS.bytes,
    );
    expect(projection.activity).toEqual([
      expect.objectContaining({
        type: 'tool',
        toolCallId: 'terminal',
        status: 'completed',
        outputTruncated: true,
      }),
    ]);
  });
});

describe('applied child guidance projection', () => {
  const stored = (type: string, content: string, additional_kwargs = {}) => ({
    type,
    data: { content, additional_kwargs },
  });

  it('keeps trusted SDK-injected steer humans between assistant content after reload', () => {
    const messages = [
      stored('human', 'Old task'),
      stored('ai', 'Old answer'),
      stored('human', 'Current task'),
      stored('ai', 'Before'),
      stored('human', 'Apply guidance', { injected: true, source: 'steer', role: 'user' }),
      stored('ai', 'After'),
    ];
    const projection = projectSubagentActivity(JSON.stringify(messages), 'replace', 'Current task');
    expect(projection).toEqual({
      activity: [
        { type: 'writing', text: 'Before' },
        { type: 'steer', steer: 'Apply guidance' },
        { type: 'writing', text: 'After' },
      ],
      truncated: false,
    });
    expect(projectPersistedMessageActivityJson(JSON.stringify(projection.activity))).toEqual(
      projection,
    );
  });

  it('does not expose raw prompts or untrusted injected humans as applied guidance', () => {
    const messages = [
      stored('human', 'Prompt'),
      stored('human', 'Unmarked', { source: 'steer' }),
      stored('human', 'Synthetic', { injected: true, source: 'tool' }),
      stored('human', 'Generic', { injected: true }),
      stored('ai', 'Answer'),
    ];
    expect(projectSubagentActivity(JSON.stringify(messages)).activity).toEqual([
      { type: 'writing', text: 'Answer' },
    ]);
  });

  it('bounds escaped and multibyte guidance without weakening the projection budget', () => {
    const result = projectSubagentActivity(
      JSON.stringify([
        stored('human', '\u0001😀'.repeat(40000), { injected: true, source: 'steer' }),
      ]),
    );
    expect(result.activity[0]).toMatchObject({ type: 'steer', textTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(result.activity))).toBeLessThanOrEqual(
      SUBAGENT_ACTIVITY_LIMITS.bytes,
    );
  });
});

it('stamps trusted injected guidance only when authoritative apply order is complete', () => {
  const messages = JSON.stringify([
    { type: 'ai', data: { content: 'Before' } },
    {
      type: 'human',
      data: { content: 'Same text', additional_kwargs: { injected: true, source: 'steer' } },
    },
    {
      type: 'human',
      data: { content: 'Same text', additional_kwargs: { injected: true, source: 'steer' } },
    },
    { type: 'ai', data: { content: 'After' } },
  ]);
  const controls = [
    { steerId: 'control-1', clientSteerId: 'invocation-1', createdAt: 10 },
    { steerId: 'control-2', clientSteerId: 'invocation-2', createdAt: 10 },
  ];
  expect(projectSubagentActivity(messages, 'append', undefined, controls).activity).toEqual([
    { type: 'writing', text: 'Before' },
    { type: 'steer', steer: 'Same text', ...controls[0] },
    { type: 'steer', steer: 'Same text', ...controls[1] },
    { type: 'writing', text: 'After' },
  ]);
  expect(
    projectSubagentActivity(messages, 'append', undefined, controls.slice(1)).activity[1],
  ).toEqual({ type: 'steer', steer: 'Same text' });
});

describe('bounded public observations', () => {
  const progress = (phase: SubagentUpdateEvent['phase'], data: unknown): SubagentUpdateEvent => ({
    phase,
    data,
    runId: 'root',
    parentRunId: 'parent',
    subagentRunId: 'child',
    subagentType: 'worker',
    subagentAgentId: 'agent',
    timestamp: '2026-10-23T00:00:00.000Z',
  });

  it.each([
    { type: 'think', think: 'Public reasoning.' },
    { type: 'reasoning', reasoning: 'Public reasoning.' },
    { type: 'thinking', thinking: 'Public reasoning.' },
    { type: 'text', text: 'Public reasoning.' },
  ])('retains visible reasoning from the $type wire shape', (block) => {
    const recorder = new SubagentPublicRecorder();
    recorder.record(
      progress('run_step', {
        id: 'reasoning',
        stepDetails: { type: 'message_creation', message_creation: { message_id: 'reasoning' } },
      }),
    );
    recorder.record(progress('reasoning_delta', { id: 'reasoning', delta: { content: [block] } }));
    expect(recorder.snapshot()).toEqual({
      activity: [{ type: 'reasoning', text: 'Public reasoning.' }],
      truncated: false,
    });
  });

  it.each([
    { label: 'empty object placeholder', args: {}, fragments: ['{"query":', '"x"}'] },
    {
      label: 'nonempty object announcement',
      args: { initial: true },
      fragments: ['{"query":', '"x"}'],
    },
    { label: 'empty initial string', args: '', fragments: ['{"query":', '"x"}'] },
    { label: 'initial string prefix', args: '{"query":', fragments: ['"x"}'] },
    { label: 'literal object-shaped string', args: '{}', fragments: ['{"query":"x"}'] },
    { label: 'empty first fragment', args: {}, fragments: ['', '{"query":"x"}'] },
    { label: 'object without fragments', args: { query: 'x' }, fragments: [] },
    { label: 'object delta replacing text', args: '{"query":', fragments: [{ query: 'x' }] },
    { label: 'name-only first delta', args: {}, fragments: [undefined, '{"query":"x"}'] },
  ])('matches the locked SDK arguments through $label', ({ args, fragments }) => {
    const recorder = new SubagentPublicRecorder();
    const sdk = createContentAggregator();
    const data = {
      id: 'tool-step',
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call', name: 'lookup', args, type: 'tool_call' }],
      },
    };
    recorder.record(progress('run_step', data));
    sdk.aggregateContent({
      event: GraphEvents.ON_RUN_STEP,
      data: data as Parameters<typeof sdk.aggregateContent>[0]['data'],
    });
    const compare = () => {
      const part = sdk.contentParts[0];
      const expected = part != null && 'tool_call' in part ? part.tool_call?.args : undefined;
      const input = typeof expected === 'string' ? expected : JSON.stringify(expected);
      const snapshot = recorder.snapshot();
      expect(snapshot).toMatchObject({
        activity: [{ type: 'tool', ...(input ? { input } : {}) }],
        truncated: false,
      });
      const tool = snapshot.activity[0];
      expect(tool.type === 'tool' ? (tool.input ?? '') : undefined).toBe(input ?? '');
      const stored = projectPersistedMessageActivity(snapshot.activity);
      const restoredTool = stored.activity[0];
      expect(restoredTool.type === 'tool' ? (restoredTool.input ?? '') : undefined).toBe(
        input ?? '',
      );
      expect(stored.truncated).toBe(false);
    };
    compare();
    for (const args of fragments) {
      const data = {
        id: 'tool-step',
        delta: { type: 'tool_calls', tool_calls: [{ id: 'call', index: 0, name: 'lookup', args }] },
      };
      recorder.record(progress('run_step_delta', data));
      sdk.aggregateContent({
        event: GraphEvents.ON_RUN_STEP_DELTA,
        data: data as Parameters<typeof sdk.aggregateContent>[0]['data'],
      });
      compare();
    }
    const dataCompleted = {
      result: {
        id: 'tool-step',
        index: 0,
        tool_call: { id: 'call', name: 'lookup', args: { query: 'final' }, output: 'Done' },
      },
    };
    recorder.record(progress('run_step_completed', dataCompleted));
    sdk.aggregateContent({
      event: GraphEvents.ON_RUN_STEP_COMPLETED,
      data: dataCompleted as Parameters<typeof sdk.aggregateContent>[0]['data'],
    });
    compare();
    expect(recorder.snapshot().activity[0]).toMatchObject({
      input: '{"query":"final"}',
      output: 'Done',
      status: 'completed',
    });
    const settled = recorder.snapshot();
    recorder.record(
      progress('run_step_delta', {
        id: 'tool-step',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ id: 'call', index: 0, name: 'lookup', args: 'late fragment' }],
        },
      }),
    );
    expect(recorder.snapshot()).toEqual(settled);
  });

  it.each([
    { initial: [] },
    { initial: [{ id: 'first', name: 'first_tool', args: {}, type: 'tool_call' }] },
  ])('retains a parallel call first introduced by a delta after $initial', ({ initial }) => {
    const recorder = new SubagentPublicRecorder();
    const sdk = createContentAggregator();
    const announce = {
      id: 'step',
      index: 0,
      stepDetails: { type: 'tool_calls', tool_calls: initial },
    };
    recorder.record(progress('run_step', announce));
    sdk.aggregateContent({
      event: GraphEvents.ON_RUN_STEP,
      data: announce as Parameters<typeof sdk.aggregateContent>[0]['data'],
    });
    const index = initial.length;
    const delta = (call: object) => {
      const data = { id: 'step', delta: { type: 'tool_calls', tool_calls: [call] } };
      recorder.record(progress('run_step_delta', data));
      sdk.aggregateContent({
        event: GraphEvents.ON_RUN_STEP_DELTA,
        data: data as Parameters<typeof sdk.aggregateContent>[0]['data'],
      });
    };
    delta({ id: 'late', index, name: 'late_tool', args: '{"query":' });
    delta({ index, name: 'late_tool', args: '"x"}' });
    const snapshot = recorder.snapshot();
    const expected = sdk.contentParts
      .filter((part) => part != null && part.type === 'tool_call' && 'tool_call' in part)
      .map((part) => {
        if (part == null || !('tool_call' in part)) throw new Error('Expected tool content');
        const call = part.tool_call!;
        return {
          type: 'tool',
          toolCallId: call.id,
          name: call.name,
          input: typeof call.args === 'string' ? call.args : JSON.stringify(call.args),
          status: 'running',
        };
      });
    expect(snapshot).toEqual({ activity: expected, truncated: false });
    expect(projectPersistedMessageActivity(snapshot.activity).activity).toEqual(snapshot.activity);
  });

  it('binds a delta-first provider ID to its unbound slot without duplicating its prefix', () => {
    const recorder = new SubagentPublicRecorder();
    recorder.record(
      progress('run_step', {
        id: 'step',
        index: 0,
        stepDetails: { type: 'tool_calls', tool_calls: [] },
      }),
    );
    recorder.record(
      progress('run_step_delta', {
        id: 'step',
        delta: { tool_calls: [{ index: 0, name: 'lookup', args: '{"query":' }] },
      }),
    );
    recorder.record(
      progress('run_step_delta', {
        id: 'step',
        delta: { tool_calls: [{ id: 'provider', index: 0, name: 'lookup', args: '"x"}' }] },
      }),
    );
    recorder.record(
      progress('run_step_completed', {
        result: { id: 'step', tool_call: { id: 'provider', name: 'lookup', output: 'Done' } },
      }),
    );
    expect(recorder.snapshot()).toEqual({
      activity: [
        {
          type: 'tool',
          toolCallId: 'provider',
          name: 'lookup',
          input: '{"query":"x"}',
          output: 'Done',
          status: 'completed',
        },
      ],
      truncated: false,
    });
  });

  it('does not reassign an earlier chunk slot when an additional delta call has only an ID', () => {
    const recorder = new SubagentPublicRecorder();
    recorder.record(
      progress('run_step', {
        id: 'step',
        index: 0,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'first', name: 'first_tool', args: {} }],
        },
      }),
    );
    recorder.record(
      progress('run_step_delta', {
        id: 'step',
        delta: { tool_calls: [{ id: 'late', name: 'late_tool', args: 'late-input' }] },
      }),
    );
    recorder.record(
      progress('run_step_delta', {
        id: 'step',
        delta: { tool_calls: [{ index: 0, name: 'first_tool', args: 'first-input' }] },
      }),
    );
    expect(recorder.snapshot()).toEqual({
      activity: [
        {
          type: 'tool',
          toolCallId: 'first',
          name: 'first_tool',
          input: 'first-input',
          status: 'running',
        },
        {
          type: 'tool',
          toolCallId: 'late',
          name: 'late_tool',
          input: 'late-input',
          status: 'running',
        },
      ],
      truncated: false,
    });
  });

  it('routes an idless fragment to the sole delta-first call in its own step', () => {
    const recorder = new SubagentPublicRecorder();
    recorder.record(
      progress('run_step', {
        id: 'step',
        index: 0,
        stepDetails: { type: 'tool_calls', tool_calls: [] },
      }),
    );
    recorder.record(
      progress('run_step_delta', {
        id: 'step',
        delta: { tool_calls: [{ id: 'only', name: 'lookup', args: '{"query":' }] },
      }),
    );
    recorder.record(
      progress('run_step_delta', {
        id: 'step',
        delta: { tool_calls: [{ name: 'lookup', args: '"x"}' }] },
      }),
    );
    expect(recorder.snapshot()).toEqual({
      activity: [
        {
          type: 'tool',
          toolCallId: 'only',
          name: 'lookup',
          input: '{"query":"x"}',
          status: 'running',
        },
      ],
      truncated: false,
    });
  });

  it('retains late parallel calls within the existing public item and byte bounds', () => {
    const recorder = new SubagentPublicRecorder();
    recorder.record(
      progress('run_step', {
        id: 'step',
        index: 0,
        stepDetails: { type: 'tool_calls', tool_calls: [] },
      }),
    );
    for (let index = 0; index < 150; index++)
      recorder.record(
        progress('run_step_delta', {
          id: 'step',
          delta: {
            type: 'tool_calls',
            tool_calls: [{ id: `late-${index}`, index, name: 'lookup', args: 'x'.repeat(400) }],
          },
        }),
      );
    const snapshot = recorder.snapshot();
    expect(snapshot.activity.length).toBeLessThanOrEqual(SUBAGENT_ACTIVITY_LIMITS.items);
    expect(Buffer.byteLength(JSON.stringify(snapshot.activity))).toBeLessThanOrEqual(
      SUBAGENT_ACTIVITY_LIMITS.bytes,
    );
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.activity[snapshot.activity.length - 1]).toMatchObject({
      toolCallId: 'late-149',
      input: 'x'.repeat(400),
    });
  });

  it('isolates repeated provider call IDs by step and ignores duplicate announcements', () => {
    const recorder = new SubagentPublicRecorder();
    const step = (id: string) =>
      progress('run_step', {
        id,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'same', name: 'lookup', args: '', type: 'tool_call' }],
        },
      });
    recorder.record(step('first'));
    recorder.record(step('second'));
    recorder.record(step('first'));
    recorder.record(
      progress('run_step_delta', {
        id: 'second',
        delta: { tool_calls: [{ index: 0, args: 'second input' }] },
      }),
    );
    recorder.record(
      progress('run_step', {
        id: 'text',
        stepDetails: {
          type: 'message_creation',
          message_creation: { message_id: 'text', phase: 'commentary' },
        },
      }),
    );
    recorder.record(progress('run_step_closed', { id: 'text', status: 'completed' }));
    expect(recorder.snapshot().truncated).toBe(false);
    expect(recorder.snapshot().activity).toEqual([
      { type: 'tool', toolCallId: 'same', name: 'lookup', status: 'running' },
      {
        type: 'tool',
        toolCallId: 'same#2',
        name: 'lookup',
        input: 'second input',
        status: 'running',
      },
    ]);
    recorder.record(
      progress('run_step_completed', {
        result: { id: 'first', tool_call: { id: 'same', output: 'first output' } },
      }),
    );
    recorder.record(progress('run_step_closed', { id: 'second', status: 'cancelled' }));
    recorder.record(
      progress('message_delta', {
        id: 'text',
        delta: { content: [{ type: 'text', text: 'Commentary' }] },
      }),
    );
    const snapshot = recorder.snapshot();
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.activity).toEqual([
      {
        type: 'tool',
        toolCallId: 'same',
        name: 'lookup',
        output: 'first output',
        status: 'completed',
      },
      {
        type: 'tool',
        toolCallId: 'same#2',
        name: 'lookup',
        input: 'second input',
        status: 'cancelled',
      },
      { type: 'writing', text: 'Commentary', phase: 'commentary' },
    ]);
    expect(projectPersistedMessageActivity(snapshot.activity).activity).toEqual(snapshot.activity);
  });

  it('contains observation errors and marks the retained history incomplete', () => {
    const recorder = new SubagentPublicRecorder();
    const data = {
      get id(): string {
        throw new Error('observer failure');
      },
    };
    expect(() => recorder.record(progress('run_step', data))).not.toThrow();
    expect(recorder.snapshot()).toEqual({ activity: [], truncated: true });
  });
});
