import { toolRoundNames } from './rounds';

describe('toolRoundNames', () => {
  it('reads the names of the calls a round ran, in order, and nothing else', () => {
    expect(
      toolRoundNames(
        '[{"name":"bash_tool","args":{"command":"cat secret"}},{"name":"search_code_mcp_github","args":{}}]',
      ),
    ).toEqual(['bash_tool', 'search_code_mcp_github']);
    expect(toolRoundNames([{ name: 'web_search', args: { query: 'q' } }])).toEqual(['web_search']);
  });

  it('reads nothing from input that is not a list of calls', () => {
    expect(toolRoundNames('{"messages":[{"role":"system","content":"prompt"}]}')).toBeUndefined();
    expect(toolRoundNames('[{"name":"ok"},{"role":"user","content":"hi"}]')).toBeUndefined();
    expect(toolRoundNames('[{"name":""}]')).toBeUndefined();
    expect(toolRoundNames('[{"name":7}]')).toBeUndefined();
    expect(toolRoundNames('[null]')).toBeUndefined();
    expect(toolRoundNames('[]')).toBeUndefined();
    expect(toolRoundNames('[{"name":')).toBeUndefined();
    expect(toolRoundNames(undefined)).toBeUndefined();
  });

  it('returns exact names or none: a round past the bounds is left unnamed, never shortened', () => {
    const calls = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ name: `tool_${index}` }));
    expect(toolRoundNames(calls(256))).toHaveLength(256);
    expect(toolRoundNames(calls(257))).toBeUndefined();
    expect(toolRoundNames([{ name: 'n'.repeat(256) }])).toEqual(['n'.repeat(256)]);
    expect(toolRoundNames([{ name: 'n'.repeat(257) }])).toBeUndefined();
  });
});
