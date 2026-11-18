import { getProductTrackingConfig, serverProductFactSchema } from 'librechat-data-provider';
import { createAssistantProductTracking, trackAssistantRun } from './assistants';

const setup = (enabled = true) => {
  const productTracker = jest.fn();
  const tracking = createAssistantProductTracking(
    {
      productTracker,
      productTracking: {
        ...getProductTrackingConfig(),
        enabled,
      },
    },
    {
      conversationId: 'conversation',
      agentId: 'assistant',
    },
  );
  return { productTracker, tracking };
};

test('deduplicates provider terminal events and late aggregate usage without fabricating model calls', () => {
  const { productTracker, tracking } = setup();
  tracking.run({ id: 'run', status: 'in_progress' });
  tracking.run({ id: 'run', status: 'completed', created_at: 1, completed_at: 3 });
  tracking.run({
    id: 'run',
    status: 'completed',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  tracking.run({
    id: 'run',
    status: 'completed',
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  expect(productTracker.mock.calls.map(([fact]) => fact.name)).toEqual([
    'librechat.chat.agent.invoked',
    'librechat.chat.response.finished',
    'librechat.chat.agent.finished',
    'librechat.chat.model.usage.recorded',
  ]);
  expect(productTracker.mock.calls[1][0]).toMatchObject({ outcome: 'completed', durationMs: 2000 });
  expect(
    productTracker.mock.calls.every(([fact]) => serverProductFactSchema.safeParse(fact).success),
  ).toBe(true);
  expect(productTracker.mock.calls[3][0]).toMatchObject({
    callId: 'run',
    runId: 'run',
    usage_scope: 'run',
    input_tokens: 10,
    output_tokens: 5,
  });
});

test.each(['cancelled', 'failed', 'expired', 'incomplete'] as const)(
  'uses confirmed provider status %s',
  (status) => {
    const { productTracker, tracking } = setup();
    tracking.run({ id: 'run', status });
    expect(
      productTracker.mock.calls.find(
        ([fact]) => fact.name === 'librechat.chat.response.finished',
      )?.[0].outcome,
    ).toBe(status === 'cancelled' ? 'cancelled' : 'failed');
    expect(
      productTracker.mock.calls.some(
        ([fact]) => fact.name === 'librechat.chat.model.usage.recorded',
      ),
    ).toBe(false);
  },
);

test('does not infer completion or cancellation from in-progress or cancelling states', () => {
  const { productTracker, tracking } = setup();
  tracking.run({ id: 'run', status: 'in_progress' });
  tracking.run({ id: 'run', status: 'cancelling' });
  expect(productTracker).toHaveBeenCalledTimes(1);
});

test('keeps tool arguments and output out of compact repeated step events', () => {
  const { productTracker, tracking } = setup();
  const step = {
    id: 'step',
    run_id: 'run',
    status: 'in_progress' as const,
    step_details: {
      type: 'tool_calls' as const,
      tool_calls: [
        {
          id: 'call',
          type: 'function' as const,
          function: {
            name: 'lookup_private@example.test',
            arguments: 'private input',
            output: 'private output',
          },
        },
      ],
    },
  };
  tracking.step(step);
  tracking.step(step);
  tracking.step({ ...step, status: 'completed' });
  tracking.step({ ...step, status: 'completed' });
  expect(productTracker).toHaveBeenCalledTimes(2);
  expect(productTracker.mock.calls[1][0]).toMatchObject({
    name: 'librechat.chat.tool.finished',
    toolCallId: 'call',
    toolCategory: 'custom',
    outcome: 'completed',
  });
  expect(JSON.stringify(productTracker.mock.calls)).not.toContain('private');
});

test('stays inert when disabled or no tracker was supplied', () => {
  const { productTracker, tracking } = setup(false);
  tracking.run({ id: 'run', status: 'completed' });
  trackAssistantRun(undefined, { id: 'run', status: 'completed' });
  expect(productTracker).not.toHaveBeenCalled();
});

test('uses provider tool types but never names an arbitrary Assistants function', () => {
  const { productTracker, tracking } = setup();
  tracking.run({
    id: 'run',
    status: 'requires_action',
    required_action: {
      type: 'submit_tool_outputs',
      submit_tool_outputs: {
        tool_calls: [
          {
            id: 'required-call',
            type: 'function',
            function: { name: 'lookup_private@example.test', arguments: 'private input' },
          },
        ],
      },
    },
  });
  tracking.step({
    id: 'step',
    run_id: 'run',
    status: 'completed',
    step_details: {
      type: 'tool_calls',
      tool_calls: [
        {
          id: 'code-call',
          type: 'code_interpreter',
          code_interpreter: { input: 'private code', outputs: [] },
        },
        { id: 'search-call', type: 'file_search', file_search: {} },
        {
          id: 'function-call',
          type: 'function',
          function: { name: 'file_search', arguments: 'private input', output: 'private output' },
        },
      ],
    },
  });
  const tools = productTracker.mock.calls
    .map(([fact]) => fact)
    .filter((fact) => fact.name === 'librechat.chat.tool.invoked');
  expect(tools).toEqual([
    expect.objectContaining({ toolCallId: 'required-call', toolCategory: 'custom' }),
    expect.objectContaining({
      toolCallId: 'code-call',
      toolCategory: 'builtin',
      toolName: 'code_interpreter',
    }),
    expect.objectContaining({
      toolCallId: 'search-call',
      toolCategory: 'builtin',
      toolName: 'file_search',
    }),
    expect.objectContaining({ toolCallId: 'function-call', toolCategory: 'custom' }),
  ]);
  expect(tools[0]).not.toHaveProperty('toolName');
  expect(tools[3]).not.toHaveProperty('toolName');
  for (const [fact] of productTracker.mock.calls) {
    expect(serverProductFactSchema.safeParse(fact).success).toBe(true);
  }
  expect(JSON.stringify(productTracker.mock.calls)).not.toContain('private');
});
