import { TOOL_DISPATCHER_NAME, resolveDisplayToolCall } from './toolDispatch';

describe('resolveDisplayToolCall', () => {
  it('shows the tool a completed dispatcher call ran', () => {
    const call = {
      id: 'call_1',
      name: TOOL_DISPATCHER_NAME,
      args: '{"name":"query_mcp_beta","arguments":"{\\"q\\":\\"bolts\\"}"}',
      output: 'in stock',
      dispatched: { name: 'query_mcp_beta', args: '{"q":"bolts"}' },
    };
    expect(resolveDisplayToolCall(call)).toEqual({
      ...call,
      name: 'query_mcp_beta',
      args: '{"q":"bolts"}',
    });
  });

  it('reads the target from the dispatcher arguments before the call completes', () => {
    expect(
      resolveDisplayToolCall({
        name: TOOL_DISPATCHER_NAME,
        args: { name: 'web_search', arguments: { query: 'news' } },
      }),
    ).toEqual({ name: 'web_search', args: '{"query":"news"}' });
    expect(
      resolveDisplayToolCall({
        name: TOOL_DISPATCHER_NAME,
        args: '{"name":"query_mcp_beta","arguments":"{\\"q\\":1}"}',
      }),
    ).toEqual({ name: 'query_mcp_beta', args: '{"q":1}' });
  });

  it('keeps the dispatcher while its arguments still stream or name no tool', () => {
    const streaming = { name: TOOL_DISPATCHER_NAME, args: '{"name":"query_mc' };
    expect(resolveDisplayToolCall(streaming)).toBe(streaming);
    const unnamed = { name: TOOL_DISPATCHER_NAME, args: '{"arguments":"{}"}' };
    expect(resolveDisplayToolCall(unnamed)).toBe(unnamed);
  });

  it('leaves any other call as it is', () => {
    const call = { name: 'web_search', args: '{"query":"news"}' };
    expect(resolveDisplayToolCall(call)).toBe(call);
  });
});
