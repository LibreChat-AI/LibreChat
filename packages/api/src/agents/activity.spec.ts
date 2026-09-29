import {
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
