import { RedisJobStore } from '../implementations/RedisJobStore';

/** Exercise the actual reconstruction method against a durable chunk snapshot, not a live host cache. */
describe('RedisJobStore tool timing reconstruction', () => {
  it('restores preparation, SDK handoff, result time, and the upstream close stamp', async () => {
    const chunks = [
      {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          index: 0,
          runId: 'response-1',
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [{ id: 'call-1', name: 'lookup', args: '{}' }],
          },
        },
      },
      {
        event: 'on_run_step_delta',
        data: {
          id: 'step-1',
          observed_at: 1_000,
          delta: { type: 'tool_calls', tool_calls: [{ id: 'call-1', index: 0, args: '{' }] },
        },
      },
      {
        event: 'on_tool_preparation',
        data: {
          id: 'step-1',
          toolCallId: 'call-1',
          index: 0,
          observed_at: 1_000,
        },
      },
      {
        event: 'on_tool_calls_dispatched',
        data: {
          dispatched_at: 248_000,
          toolCalls: [{ id: 'call-1', name: 'lookup', stepId: 'step-1' }],
        },
      },
      {
        event: 'on_run_step_completed',
        data: {
          result: {
            id: 'step-1',
            index: 0,
            type: 'tool_call',
            completed_at: 248_340,
            tool_call: { id: 'call-1', name: 'lookup', args: '{}', output: 'done', progress: 1 },
          },
        },
      },
      {
        event: 'on_run_step_closed',
        data: {
          id: 'step-1',
          type: 'tool_calls',
          index: 0,
          status: 'completed',
          created_at: 1_000,
          closed_at: 248_340,
        },
      },
    ];
    const store = Object.create(RedisJobStore.prototype) as RedisJobStore;
    const snapshot = jest.fn(async () => ({ chunks, durableEventCount: chunks.length }));
    Object.defineProperty(store, 'getChunkSnapshot', { value: snapshot });
    const result = await store.getContentParts('tool-run', undefined, { durableOnly: true });
    expect(snapshot).toHaveBeenCalledWith('tool-run', undefined, true);
    expect(result).toMatchObject({
      reconstructedEventCount: chunks.length,
      durableEventCount: chunks.length,
      content: [
        {
          type: 'tool_call',
          tool_call: {
            id: 'call-1',
            runStepStatus: 'completed',
            runStepClosedAt: 248_340,
            runStepDurationMs: 247_340,
            toolPreparationDurationMs: 247_000,
            toolExecutionDurationMs: 340,
          },
        },
      ],
    });
  });
});
