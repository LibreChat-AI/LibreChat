import type { AgentToolOptions } from './types/tools';
import { normalizeActionToolName, removeCodeExecutionCaller } from './agentToolOptions';

describe('normalizeActionToolName', () => {
  it('normalizes only the encoded action domain', () => {
    expect(normalizeActionToolName('get_foo---bar_action_swapi---tech')).toBe(
      'get_foo---bar_action_swapi_tech',
    );
  });

  it('leaves non-action tool names unchanged', () => {
    expect(normalizeActionToolName('search_mcp_docs---server')).toBe('search_mcp_docs---server');
    expect(normalizeActionToolName('get_action_data---x_mcp_srv')).toBe(
      'get_action_data---x_mcp_srv',
    );
  });
});

describe('removeCodeExecutionCaller', () => {
  it('removes a programmatic-only entry that has no other options', () => {
    expect(
      removeCodeExecutionCaller({
        search: { allowed_callers: ['code_execution'] },
      }),
    ).toEqual({});
  });

  it('preserves direct calling and unrelated options', () => {
    expect(
      removeCodeExecutionCaller({
        search: {
          allowed_callers: ['direct', 'code_execution'],
          defer_loading: true,
        },
      }),
    ).toEqual({
      search: {
        allowed_callers: ['direct'],
        defer_loading: true,
      },
    });
  });

  it('does not mutate its input', () => {
    const input: AgentToolOptions = {
      search: { allowed_callers: ['code_execution'], run_in_background: true },
    };

    removeCodeExecutionCaller(input);

    expect(input.search.allowed_callers).toEqual(['code_execution']);
  });
});
