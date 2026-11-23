import { createOpenAIToolCallStream } from '@librechat/agents/openai';
import { createServerToolResults, validateChatIncludes } from './results';
import { createOpenAIStreamTracker, sendFinalChunk } from './handlers';
import { buildNonStreamingResponse } from './service';

function fixture(options: Parameters<typeof createServerToolResults>[0] = {}) {
  const collector = createServerToolResults(options);
  const calls = new Map();
  const delegate = createOpenAIToolCallStream({ toolCalls: calls });
  const projection = collector.wrap(delegate);
  const accept = async (agent = 'a', id = 'call', disposition = 'sdk') => {
    await projection.handlers.on_model_response.handle('on_model_response', {
      type: 'model_response',
      id: `accepted-${agent}-${id}`,
      agentId: agent,
      toolCalls: [{ id, name: 'lookup', args: {} }],
      toolCallDispositions: [disposition],
      invalidToolCalls: [],
    } as never);
  };
  const complete = async (
    agent = 'a',
    id = 'call',
    output = 'protected result',
    step = `step-${agent}-${id}`,
  ) => {
    await projection.handlers.on_run_step_completed.handle(
      'on_run_step_completed',
      {
        result: {
          id: step,
          type: 'tool_call',
          tool_call: {
            id,
            name: 'lookup',
            args: '{}',
            output,
            artifact: { private: 'secret' },
          },
        },
      } as never,
      { agentId: agent } as never,
    );
  };
  return { collector, calls, delegate, projection, accept, complete };
}

describe('server tool result projection', () => {
  it('validates an explicit extension selector', () => {
    for (const value of [
      undefined,
      [],
      ['server_tool_results'],
      ['server_tool_results', 'server_tool_results'],
    ])
      expect(validateChatIncludes(value)).toBeUndefined();
    for (const value of [null, true, 'server_tool_results', [3], ['unknown']])
      expect(validateChatIncludes(value)).toEqual(expect.any(String));
  });

  it('correlates SDK completions, deduplicates and never changes client execution requests', async () => {
    const f = fixture();
    await f.accept();
    await f.accept('a', 'client', 'client');
    await f.accept('a', 'provider', 'provider');
    await f.complete('a', 'client');
    await f.complete('a', 'provider');
    await f.complete('a', 'unknown');
    await f.complete();
    await f.complete();
    await f.accept();
    await f.complete();
    expect(f.collector.response()).toEqual({
      tool_results: [
        { call_id: 'call', name: 'lookup', arguments: '{}', output: 'protected result' },
      ],
    });
    expect(JSON.stringify(f.collector.response())).not.toContain('secret');
    // The final accepted internal-only turn supersedes pending client requests as usual.
    expect(f.calls.size).toBe(0);
  });

  it('keeps parallel calls and identical IDs from different agents separate', async () => {
    const f = fixture();
    await f.accept('a', 'same');
    await f.accept('b', 'same');
    await Promise.all([f.complete('b', 'same', 'B'), f.complete('a', 'same', 'A')]);
    expect(f.collector.response().tool_results.map((result) => result.output)).toEqual(['B', 'A']);
  });

  it('refuses ambiguous ownerless completions and unaccepted identities', async () => {
    const f = fixture();
    await f.accept('a', 'same');
    await f.accept('b', 'same');
    await f.projection.handlers.on_run_step_completed.handle('on_run_step_completed', {
      result: {
        id: 'step',
        type: 'tool_call',
        tool_call: { id: 'same', name: 'lookup', args: '{}', output: 'private sibling' },
      },
    });
    await f.complete('foreign', 'same', 'foreign result');
    expect(f.collector.response()).toEqual({ tool_results: [], tool_results_incomplete: true });
  });

  it('never reattributes an ownerless duplicate after its sibling completed', async () => {
    const f = fixture();
    await f.accept('a', 'same');
    await f.accept('b', 'same');
    await f.complete('a', 'same', 'A', 'step-a');
    await f.projection.handlers.on_run_step_completed.handle('on_run_step_completed', {
      result: {
        id: 'step-a',
        type: 'tool_call',
        tool_call: { id: 'same', name: 'lookup', args: '{}', output: 'A' },
      },
    });
    await f.complete('b', 'same', 'B');
    expect(f.collector.response().tool_results.map((result) => result.output)).toEqual(['A', 'B']);
    expect(f.collector.incomplete).toBe(true);
  });

  it.each(['provider', 'client'])(
    'never attributes an ownerless %s sibling to a server execution',
    async (disposition) => {
      const f = fixture();
      await f.accept('a', 'same', 'sdk');
      await f.accept('b', 'same', disposition);
      await f.projection.handlers.on_run_step_completed.handle('on_run_step_completed', {
        result: {
          id: 'step-b',
          type: 'tool_call',
          tool_call: { id: 'same', name: 'lookup', args: '{}', output: 'private B' },
        },
      });
      await f.complete('a', 'same', 'A');
      expect(f.collector.response().tool_results.map((result) => result.output)).toEqual(['A']);
      expect(f.collector.incomplete).toBe(true);
    },
  );

  it('deduplicates model acceptance within its execution owner', async () => {
    const f = fixture();
    for (const agentId of ['a', 'b']) {
      await f.projection.handlers.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: 'same-acceptance',
        agentId,
        toolCalls: [{ id: 'same', name: 'lookup', args: {} }],
        toolCallDispositions: ['sdk'],
        invalidToolCalls: [],
      });
    }
    await f.complete('a', 'same', 'A');
    await f.complete('b', 'same', 'B');
    expect(f.collector.response().tool_results.map((result) => result.output)).toEqual(['A', 'B']);
  });

  it('fences an oversized completed output without serializing artifacts or failing the graph', async () => {
    const f = fixture({ maxBytes: 100 });
    await f.accept();
    await f.complete('a', 'call', 'x'.repeat(200));
    await f.complete('a', 'call', 'late');
    expect(() => f.projection.finish()).not.toThrow();
    expect(f.collector.response()).toEqual({ tool_results: [], tool_results_incomplete: true });
  });

  it('emits complete indexed records once and fences results on cancellation', async () => {
    const controller = new AbortController();
    const emit = jest.fn();
    const f = fixture({ signal: controller.signal, emit });
    await f.accept();
    await f.complete();
    controller.abort();
    await f.complete('a', 'late');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0].tool_results[0]).toEqual(
      expect.objectContaining({ index: 0, output: 'protected result' }),
    );
    expect(f.collector.response().tool_results).toEqual([]);
  });

  it.each([{ maxCalls: 1 }, { maxBytes: 32 }])(
    'marks overflow without failing execution (%j)',
    async (limits) => {
      const emit = jest.fn();
      const f = fixture({ ...limits, emit });
      await f.accept('a', 'one');
      await f.complete('a', 'one', 'first');
      await f.accept('a', 'two');
      await f.complete('a', 'two', 'second');
      expect(() => f.projection.finish()).not.toThrow();
      expect(f.collector.response().tool_results_incomplete).toBe(true);
      expect(f.collector.response().tool_results.length).toBeLessThan(2);
    },
  );

  it('reports the same overflow flag in terminal SSE and JSON without changing stop', async () => {
    const f = fixture({ maxCalls: 1 });
    await f.accept('a', 'one');
    await f.complete('a', 'one');
    await f.accept('a', 'two');
    const tracker = createOpenAIStreamTracker();
    tracker.serverToolResults = f.collector;
    tracker.finishToolCalls = f.projection.finish;
    const frames: string[] = [];
    const context = { requestId: 'test', created: 1, model: 'fixture' };
    sendFinalChunk({
      tracker,
      context,
      writer: {
        write: (frame) => {
          frames.push(frame);
        },
      },
    });
    const terminal = JSON.parse(frames[frames.length - 2].slice(6));
    expect(terminal.choices[0].delta).toEqual({ tool_results_incomplete: true });
    expect(terminal.choices[0].finish_reason).toBe('stop');
    const response = buildNonStreamingResponse(
      context,
      'done',
      '',
      new Map(),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      true,
      f.collector.response(),
    );
    expect(response.choices[0].message.tool_results_incomplete).toBe(true);
    expect(response.choices[0].message.tool_results).toHaveLength(1);
    expect(response.choices[0].finish_reason).toBe('stop');
  });

  it('retains successful output through the SDK lifecycle cleanup', async () => {
    const f = fixture();
    await f.accept();
    await f.complete();
    f.projection.finish();
    f.projection.abort();
    expect(f.collector.response().tool_results).toHaveLength(1);
  });

  it('discards unpublished results when cancellation has no following event', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    await f.accept();
    await f.complete();
    controller.abort();
    expect(() => f.projection.finish()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    f.projection.abort();
    expect(f.collector.response()).toEqual({ tool_results: [] });
  });

  it('does not seal success when the delegate cancels during finish', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    jest.spyOn(f.delegate, 'finish').mockImplementation(() => controller.abort());
    await f.accept();
    await f.complete();
    expect(() => f.projection.finish()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    f.projection.abort();
    expect(f.collector.response()).toEqual({ tool_results: [] });
  });

  it('does not finalize after the result sink cancels reentrantly', async () => {
    const controller = new AbortController();
    const emit = jest.fn(() => controller.abort());
    const f = fixture({ signal: controller.signal, emit });
    const finish = jest.spyOn(f.delegate, 'finish');
    await f.accept();
    await f.complete();
    expect(() => f.projection.finish()).toThrow(expect.objectContaining({ name: 'AbortError' }));
    f.projection.abort();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(finish).not.toHaveBeenCalled();
    expect(f.collector.response()).toEqual({ tool_results: [] });
  });

  it('seals a successful finish once before normal finally cleanup', async () => {
    const controller = new AbortController();
    const f = fixture({ signal: controller.signal });
    const finish = jest.spyOn(f.delegate, 'finish');
    await f.accept();
    await f.complete();
    f.projection.finish();
    f.projection.finish();
    controller.abort();
    f.projection.abort();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(f.collector.response().tool_results).toHaveLength(1);
  });

  it('discards buffered results and ignores late events after abort', async () => {
    const f = fixture();
    await f.accept();
    await f.complete();
    f.projection.abort();
    await f.complete();
    expect(f.collector.response()).toEqual({ tool_results: [] });
  });
});
