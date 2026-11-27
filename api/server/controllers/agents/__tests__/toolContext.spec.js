const {
  AIMessage,
  HumanMessage,
  ToolMessage,
  FunctionMessage,
} = require('@langchain/core/messages');
const { syncBudgetDerivedFields } = require('@librechat/agents');

function snapshot(messageTokens = 1000, calibrationRatio = 1) {
  return {
    calibrationRatio,
    contextBudget: 1100,
    effectiveInstructionTokens: 100,
    remainingContextTokens: 1000 - messageTokens,
    breakdown: { messageTokens },
  };
}

function result(id, name) {
  return new ToolMessage({ content: 'result', tool_call_id: id, name });
}

describe('agents tool context accounting', () => {
  test('counts retained results and tool-only invocations without double counting raw calls', () => {
    const usage = snapshot();
    const messages = [
      new HumanMessage('question'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'a', name: 'read_file', args: {} }],
        additional_kwargs: {
          tool_calls: [
            { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        },
      }),
      result('a'),
      new AIMessage('answer'),
    ];
    syncBudgetDerivedFields(usage, messages, () => 10);
    expect(usage.breakdown.toolMessageTokens).toBe(20);
    expect(usage.breakdown.toolMessageTokenCounts).toEqual({ read_file: 10 });
  });

  test('keeps visible text and media assistant content outside the tool share', () => {
    const content = [
      'explaining',
      ['explaining'],
      [{ type: 'image_url', image_url: { url: 'https://example.com/image.png' } }],
    ];
    for (const mixed of content) {
      const usage = snapshot();
      const messages = [
        new AIMessage({ content: mixed, tool_calls: [{ id: 'a', name: 'read_file', args: {} }] }),
        result('a'),
      ];
      syncBudgetDerivedFields(usage, messages, () => 10);
      expect(usage.breakdown.toolMessageTokens).toBe(10);
      expect(usage.breakdown.toolMessageTokenCounts).toEqual({ read_file: 10 });
    }
  });

  test('counts tool-only reasoning and inline provider results without attributing invocation overhead', () => {
    const usage = snapshot();
    syncBudgetDerivedFields(
      usage,
      [
        new AIMessage({
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'tool_use', id: 'a', name: 'file_search', input: {} },
            { type: 'web_search_tool_result', tool_use_id: 'a', content: [] },
          ],
        }),
        result('a', 'file_search'),
      ],
      () => 10,
    );
    expect(usage.breakdown.toolMessageTokens).toBe(20);
    expect(usage.breakdown.toolMessageTokenCounts).toEqual({ file_search: 10 });
  });

  test('attributes raw calls, legacy functions, and unknown results without guessing an unrelated name', () => {
    const usage = snapshot();
    syncBudgetDerivedFields(
      usage,
      [
        new AIMessage({
          content: '',
          additional_kwargs: {
            tool_calls: [
              { id: 'raw', type: 'function', function: { name: 'raw_tool', arguments: '{}' } },
            ],
          },
        }),
        result('raw'),
        new AIMessage({
          content: '',
          additional_kwargs: { function_call: { name: 'legacy_tool', arguments: '{}' } },
        }),
        new FunctionMessage({ content: 'legacy result', name: '' }),
        result('missing', 'explicit_tool'),
        result('missing'),
      ],
      () => 10,
    );
    expect(usage.breakdown.toolMessageTokens).toBe(60);
    expect(usage.breakdown.toolMessageTokenCounts).toEqual({
      raw_tool: 10,
      legacy_tool: 10,
      explicit_tool: 10,
      unknown_tool: 10,
    });
  });

  test('preserves prototype-sensitive tool names through JSON serialization', () => {
    const usage = snapshot();
    syncBudgetDerivedFields(
      usage,
      [result('a', '__proto__'), result('b', 'constructor'), result('c', 'toString')],
      () => 10,
    );
    const counts = JSON.parse(JSON.stringify(usage)).breakdown.toolMessageTokenCounts;
    expect(Object.hasOwn(counts, '__proto__')).toBe(true);
    expect(counts.__proto__).toBe(10);
    expect(counts.constructor).toBe(10);
    expect(counts.toString).toBe(10);
  });

  test('apportions fractional calibration and budget clamping without exceeding the tool total', () => {
    for (const ratio of [0.5, 1, 1.5, 5]) {
      for (const available of [0, 1, 2, 10]) {
        const usage = snapshot(available, ratio);
        syncBudgetDerivedFields(
          usage,
          [result('a', 'a'), result('b', 'b'), result('c', 'c')],
          () => 1,
        );
        const { toolMessageTokens, toolMessageTokenCounts } = usage.breakdown;
        expect(toolMessageTokens).toBe(Math.min(available, Math.round(3 * ratio)));
        const counts = Object.values(toolMessageTokenCounts ?? {});
        expect(counts.every((count) => Number.isSafeInteger(count) && count >= 0)).toBe(true);
        expect(counts.reduce((sum, count) => sum + count, 0)).toBe(toolMessageTokens);
      }
    }
  });

  test('distinguishes a known empty share from an unavailable counter', () => {
    const known = snapshot();
    syncBudgetDerivedFields(known, [new HumanMessage('hello')], () => 10);
    expect(known.breakdown.toolMessageTokens).toBe(0);
    expect(known.breakdown.toolMessageTokenCounts).toBeUndefined();
    const unavailable = snapshot();
    syncBudgetDerivedFields(unavailable, [result('a')]);
    expect(unavailable.breakdown.toolMessageTokens).toBeUndefined();
  });

  test('drops an unavailable tool share without failing the model call', () => {
    for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const usage = snapshot();
      usage.breakdown.toolMessageTokens = 20;
      usage.breakdown.toolMessageTokenCounts = { read_file: 10 };
      syncBudgetDerivedFields(usage, [result('a')], () => value);
      expect(usage.breakdown.toolMessageTokens).toBeUndefined();
      expect(usage.breakdown.toolMessageTokenCounts).toBeUndefined();
      expect(usage.breakdown.messageTokens).toBe(1000);
    }
  });

  test('accepts approximate fractional token counters', () => {
    const usage = snapshot();
    syncBudgetDerivedFields(usage, [result('a', 'file_search')], () => 1.5);
    expect(usage.breakdown.toolMessageTokens).toBe(2);
    expect(usage.breakdown.toolMessageTokenCounts).toEqual({ file_search: 2 });
  });
});
