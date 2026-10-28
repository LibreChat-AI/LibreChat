import type { Agents } from 'librechat-data-provider';
import type { ChatCompletionChunkChoice, ToolCall } from './types';
import { createOpenAIToolCallStream } from './handlers';

/** Public contract fixtures, not a narrower reconstruction of the SDK fields. */
describe('tool-call field normalization', () => {
  it.each(['native-string', 'native-object', 'wire-string', 'wire-object'])(
    'normalizes %s exactly once',
    (shape) => {
      const toolCalls = new Map<number, ToolCall>();
      const deltas: ChatCompletionChunkChoice['delta'][] = [];
      const stream = createOpenAIToolCallStream({ toolCalls, emit: (delta) => deltas.push(delta) });
      const args = shape.endsWith('string') ? '{"city":"Madrid"}' : { city: 'Madrid' };
      const call: Agents.AgentToolCall = shape.startsWith('native')
        ? { id: 'a', name: 'lookup', args }
        : { id: 'a', type: 'function', function: { name: 'lookup', arguments: args } };
      stream.onRunStep({ id: 'step', stepDetails: { type: 'tool_calls', tool_calls: [call] } });
      stream.finish();
      expect(toolCalls.get(0)?.function.arguments).toBe('{"city":"Madrid"}');
      expect(
        deltas
          .flatMap((d) => d.tool_calls ?? [])
          .map((c) => c.function?.arguments ?? '')
          .join(''),
      ).toBe('{"city":"Madrid"}');
    },
  );

  it.each([false, true])(
    'assembles name substrings before the consumer freezes them (snapshot=%s)',
    (snapshot) => {
      const toolCalls = new Map<number, ToolCall>();
      const deltas: ChatCompletionChunkChoice['delta'][] = [];
      const stream = createOpenAIToolCallStream({ toolCalls, emit: (delta) => deltas.push(delta) });
      if (snapshot)
        stream.onRunStep({
          id: 'step',
          stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'a', name: 'get_', args: {} }] },
        });
      for (const chunk of [
        { id: 'a', name: 'get_', index: 0, args: '{}' },
        { name: 'weather', index: 0 },
      ]) {
        stream.onRunStepDelta({ id: 'step', delta: { type: 'tool_calls', tool_calls: [chunk] } });
      }
      stream.finish();
      expect(toolCalls.get(0)?.function.name).toBe('get_weather');
      expect(
        deltas
          .flatMap((d) => d.tool_calls ?? [])
          .filter((c) => c.id)
          .map((c) => c.function?.name),
      ).toEqual(['get_weather']);
    },
  );

  it('synthesizes stable, distinct IDs for id-less complete calls and replayed declarations', () => {
    const toolCalls = new Map<number, ToolCall>();
    const stream = createOpenAIToolCallStream({ toolCalls });
    const calls: Agents.ToolCall[] = [
      { name: 'lookup', args: {} },
      { name: 'lookup', args: { city: 'Paris' } },
    ];
    const event = { id: 'step', stepDetails: { type: 'tool_calls', tool_calls: calls } };
    stream.onRunStep(event);
    stream.onRunStep(event);
    stream.onRunStep({ ...event, id: 'later' });
    stream.finish();
    expect(toolCalls.size).toBe(4);
    expect(new Set([...toolCalls.values()].map((c) => c.id)).size).toBe(4);
    expect([...toolCalls.values()].every((c) => !!c.id)).toBe(true);
  });
  it.each(['native', 'wire'])('assembles split names and IDs with %s delta fields', (shape) => {
    const toolCalls = new Map<number, ToolCall>();
    const stream = createOpenAIToolCallStream({ toolCalls });
    for (const [id, name, args] of [
      ['call_', 'get_', '{"city":'],
      ['123', 'weather', '"Paris"}'],
    ]) {
      stream.onRunStepDelta({
        id: 'step',
        delta: {
          type: 'tool_calls',
          tool_calls: [
            shape === 'native'
              ? { index: 4, id, name, args }
              : { index: 4, id, function: { name, arguments: args } },
          ],
        },
      });
    }
    stream.finish();
    expect([...toolCalls.values()]).toEqual([
      {
        id: 'call_123',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
      },
    ]);
  });

  it.each([true, false])(
    'keeps id-less calls distinct with mixed raw data (explicit index=%s)',
    (explicit) => {
      const toolCalls = new Map<number, ToolCall>();
      const stream = createOpenAIToolCallStream({ toolCalls });
      stream.onRunStep({
        id: 'step',
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [
            { name: 'get_', args: {}, ...(explicit && { index: 5 }) },
            { name: 'lookup', args: { city: 'Paris' }, ...(explicit && { index: 8 }) },
          ],
        },
      });
      const index = explicit ? 5 : 0;
      stream.onRunStepDelta({
        id: 'step',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ index, name: 'get_', args: '{"city":"Madrid"}' }],
        },
      });
      stream.onRunStepDelta({
        id: 'step',
        delta: { type: 'tool_calls', tool_calls: [{ index, name: 'weather' }] },
      });
      stream.finish();
      expect([...toolCalls.values()].map((call) => call.function)).toEqual([
        { name: 'get_weather', arguments: '{"city":"Madrid"}' },
        { name: 'lookup', arguments: '{"city":"Paris"}' },
      ]);
      expect(new Set([...toolCalls.values()].map((call) => call.id)).size).toBe(2);
    },
  );

  it('correlates an id-less declaration with a later identified chunk rather than adding a call', () => {
    const toolCalls = new Map<number, ToolCall>();
    const stream = createOpenAIToolCallStream({ toolCalls });
    stream.onRunStep({
      id: 'step',
      stepDetails: { type: 'tool_calls', tool_calls: [{ name: 'lookup', args: {} }] },
    });
    stream.onRunStepDelta({
      id: 'step',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'provider', name: 'lookup', index: 9, args: '{}' }],
      },
    });
    stream.finish();
    expect(toolCalls.size).toBe(1);
    expect(toolCalls.get(0)?.id).toBe('provider');
  });

  it('assembles name fragments before and after a full snapshot without appending the snapshot', () => {
    const toolCalls = new Map<number, ToolCall>();
    const stream = createOpenAIToolCallStream({ toolCalls });
    stream.onRunStepDelta({
      id: 'step',
      delta: { type: 'tool_calls', tool_calls: [{ id: 'a', index: 0, name: 'get_', args: '{}' }] },
    });
    stream.onRunStep({
      id: 'step',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'a', name: 'get_weather', args: {} }] },
    });
    stream.onRunStepDelta({
      id: 'step',
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, name: 'weather' }] },
    });
    stream.finish();
    expect(toolCalls.get(0)?.function.name).toBe('get_weather');
  });

  it('seals before invoking an emitter that reenters finish or throws', () => {
    const toolCalls = new Map<number, ToolCall>();
    const emit = jest.fn(() => {
      stream.finish();
      throw new Error('transport failed');
    });
    const stream = createOpenAIToolCallStream({ toolCalls, emit });
    stream.onRunStep({
      id: 'step',
      stepDetails: { type: 'tool_calls', tool_calls: [{ name: 'lookup', args: {} }] },
    });
    expect(() => stream.finish()).toThrow('transport failed');
    expect(() => stream.finish()).not.toThrow();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('does not emit any tool identity if another call is malformed', () => {
    const toolCalls = new Map<number, ToolCall>();
    const emit = jest.fn();
    const stream = createOpenAIToolCallStream({ toolCalls, emit });
    stream.onRunStep({
      id: 'step',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [
          { name: 'lookup', args: {} },
          { name: 'lookup', args: 'NOT_JSON' },
        ],
      },
    });
    expect(() => stream.finish()).toThrow('Invalid tool call arguments');
    expect(emit).not.toHaveBeenCalled();
    expect(toolCalls.size).toBe(0);
  });
  it('matches late id-less snapshot arrays to already indexed raw calls', () => {
    const toolCalls = new Map<number, ToolCall>();
    const stream = createOpenAIToolCallStream({ toolCalls });
    for (const index of [0, 1])
      stream.onRunStepDelta({
        id: 'step',
        delta: {
          type: 'tool_calls',
          tool_calls: [{ index, name: 'lookup', args: JSON.stringify({ index }) }],
        },
      });
    stream.onRunStep({
      id: 'step',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [
          { name: 'lookup', args: { index: 0 } },
          { name: 'lookup', args: { index: 1 } },
        ],
      },
    });
    stream.finish();
    expect(toolCalls.size).toBe(2);
    expect([...toolCalls.values()].map((call) => call.function.arguments)).toEqual([
      '{"index":0}',
      '{"index":1}',
    ]);
  });

  it('separates fully identified raw calls when no provider index is supplied', () => {
    const toolCalls = new Map<number, ToolCall>();
    const stream = createOpenAIToolCallStream({ toolCalls });
    for (const id of ['a', 'b'])
      stream.onRunStepDelta({
        id: 'step',
        delta: { type: 'tool_calls', tool_calls: [{ id, name: 'lookup', args: '{}' }] },
      });
    stream.finish();
    expect([...toolCalls.values()].map((call) => call.id)).toEqual(['a', 'b']);
  });

  it('does not guess that identical name fragments are replayed data', () => {
    const toolCalls = new Map<number, ToolCall>();
    const stream = createOpenAIToolCallStream({ toolCalls });
    for (const name of ['a', 'a'])
      stream.onRunStepDelta({
        id: 'step',
        delta: { type: 'tool_calls', tool_calls: [{ index: 0, name }] },
      });
    stream.onRunStepDelta({
      id: 'step',
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: '{}' }] },
    });
    stream.finish();
    expect(toolCalls.get(0)?.function.name).toBe('aa');
  });
  it.each([true, false])(
    'does not alias parallel shared ID prefixes (snapshots=%s)',
    (snapshots) => {
      const toolCalls = new Map<number, ToolCall>();
      const stream = createOpenAIToolCallStream({ toolCalls });
      if (snapshots)
        stream.onRunStep({
          id: 'step',
          stepDetails: {
            type: 'tool_calls',
            tool_calls: [
              { id: 'call_0', name: 'get_weather', args: {} },
              { id: 'call_1', name: 'get_weather', args: {} },
            ],
          },
        });
      for (const index of [0, 1])
        stream.onRunStepDelta({
          id: 'step',
          delta: {
            type: 'tool_calls',
            tool_calls: [{ index, id: 'call_', name: 'get_', args: '{"i":' }],
          },
        });
      for (const index of [1, 0])
        stream.onRunStepDelta({
          id: 'step',
          delta: {
            type: 'tool_calls',
            tool_calls: [{ index, id: String(index), name: 'weather', args: `${index}}` }],
          },
        });
      stream.finish();
      expect([...toolCalls.values()]).toEqual(
        [0, 1].map((i) => ({
          id: `call_${i}`,
          type: 'function',
          function: { name: 'get_weather', arguments: JSON.stringify({ i }) },
        })),
      );
    },
  );
});
