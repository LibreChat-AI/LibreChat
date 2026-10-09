import type { AgentToolOptions } from './types/tools';
import {
  mcpServerToggleKey,
  getAgentToolSwitches,
  applyAgentToolSwitches,
  pickUserToggleOptions,
  normalizeActionToolName,
  removeCodeExecutionCaller,
} from './agentToolOptions';

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

describe('mcpServerToggleKey', () => {
  it('builds the server-level placeholder key', () => {
    expect(mcpServerToggleKey('alpha')).toBe('sys__server__sys_mcp_alpha');
  });
});

describe('getAgentToolSwitches', () => {
  it('reports only attached tools that carry a user_toggle', () => {
    expect(
      getAgentToolSwitches({
        tools: ['web_search', 'execute_code', 'search_mcp_alpha', 'sys__all__sys_mcp_beta'],
        tool_options: {
          web_search: { user_toggle: 'on' },
          execute_code: { user_toggle: 'off' },
          file_search: { user_toggle: 'on' },
          [mcpServerToggleKey('alpha')]: { user_toggle: 'off' },
          [mcpServerToggleKey('beta')]: { defer_loading: true },
          [mcpServerToggleKey('absent')]: { user_toggle: 'on' },
        },
      }),
    ).toEqual({
      builtins: { web_search: true, execute_code: false },
      mcp: { alpha: false },
    });
  });

  it('is empty without tool_options', () => {
    expect(getAgentToolSwitches({ tools: ['web_search'] })).toEqual({ builtins: {}, mcp: {} });
  });

  it('keeps a server whose name contains the MCP delimiter', () => {
    expect(
      getAgentToolSwitches({
        tools: ['search_mcp_Google_mcp_Workspace'],
        tool_options: { [mcpServerToggleKey('Google_mcp_Workspace')]: { user_toggle: 'on' } },
      }),
    ).toEqual({ builtins: {}, mcp: { Google_mcp_Workspace: true } });
  });

  it('keys a server by its configured name when its tool keys use the normalized name', () => {
    expect(
      getAgentToolSwitches({
        tools: ['search_mcp_My_Docs'],
        tool_options: { [mcpServerToggleKey('My Docs')]: { user_toggle: 'off' } },
      }),
    ).toEqual({ builtins: {}, mcp: { 'My Docs': false } });
  });
});

describe('applyAgentToolSwitches', () => {
  const agent = {
    tools: [
      'web_search',
      'execute_code',
      'file_search',
      'a_mcp_alpha',
      'b_mcp_alpha',
      'c_mcp_beta',
      'plain',
    ],
    tool_options: {
      web_search: { user_toggle: 'on' as const },
      execute_code: { user_toggle: 'off' as const },
      [mcpServerToggleKey('alpha')]: { user_toggle: 'on' as const },
    },
  };

  it('uses the defaults without a request', () => {
    expect(applyAgentToolSwitches(agent, null)).toEqual({
      tools: ['web_search', 'file_search', 'a_mcp_alpha', 'b_mcp_alpha', 'c_mcp_beta', 'plain'],
      mcp: ['alpha', 'beta'],
    });
  });

  it('honours requested booleans and server lists, dropping every tool of an off server', () => {
    expect(
      applyAgentToolSwitches(agent, { web_search: false, execute_code: true, mcp: [] }),
    ).toEqual({
      tools: ['execute_code', 'file_search', 'c_mcp_beta', 'plain'],
      mcp: ['beta'],
    });
  });

  it('ignores non-boolean values and a non-array mcp', () => {
    const requested = { web_search: 'no', mcp: 'alpha' } as unknown as Parameters<
      typeof applyAgentToolSwitches
    >[1];
    expect(applyAgentToolSwitches(agent, requested).tools).toEqual([
      'web_search',
      'file_search',
      'a_mcp_alpha',
      'b_mcp_alpha',
      'c_mcp_beta',
      'plain',
    ]);
  });

  it('never adds a locked tool or an unattached one', () => {
    const result = applyAgentToolSwitches(
      { tools: ['file_search'], tool_options: {} },
      { web_search: true, execute_code: true, mcp: ['alpha'] },
    );
    expect(result).toEqual({ tools: ['file_search'], mcp: [] });
  });

  it('tells apart a server named bar from one named foo_mcp_bar', () => {
    const tool_options = {
      [mcpServerToggleKey('bar')]: { user_toggle: 'on' as const },
      [mcpServerToggleKey('foo_mcp_bar')]: { user_toggle: 'on' as const },
    };
    const tools = ['a_mcp_bar', 'b_mcp_foo_mcp_bar'];
    expect(applyAgentToolSwitches({ tools, tool_options }, { mcp: ['bar'] }).tools).toEqual([
      'a_mcp_bar',
    ]);
    expect(applyAgentToolSwitches({ tools, tool_options }, { mcp: ['foo_mcp_bar'] }).tools).toEqual(
      ['b_mcp_foo_mcp_bar'],
    );
  });

  it('matches the chat list by configured name for a normalized server', () => {
    const agent = {
      tools: ['search_mcp_My_Docs'],
      tool_options: { [mcpServerToggleKey('My Docs')]: { user_toggle: 'off' as const } },
    };
    expect(applyAgentToolSwitches(agent, { mcp: [] }).tools).toEqual([]);
    expect(applyAgentToolSwitches(agent, { mcp: ['My Docs'] }).tools).toEqual([
      'search_mcp_My_Docs',
    ]);
  });

  it('drops the server placeholder and wildcard tokens with the server', () => {
    const result = applyAgentToolSwitches(
      {
        tools: ['sys__server__sys_mcp_alpha', 'sys__all__sys_mcp_alpha'],
        tool_options: { [mcpServerToggleKey('alpha')]: { user_toggle: 'on' } },
      },
      { mcp: [] },
    );
    expect(result.tools).toEqual([]);
  });

  it('drops raw-name placeholder and wildcard tokens of a normalized server', () => {
    const agent = {
      tools: ['sys__server__sys_mcp_My Docs', 'sys__all__sys_mcp_My Docs', 'search_mcp_My_Docs'],
      tool_options: { [mcpServerToggleKey('My Docs')]: { user_toggle: 'on' as const } },
    };
    expect(applyAgentToolSwitches(agent, { mcp: [] }).tools).toEqual([]);
    expect(
      applyAgentToolSwitches({ ...agent, tools: ['sys__all__sys_mcp_My Docs'] }, { mcp: [] }).tools,
    ).toEqual([]);
    expect(applyAgentToolSwitches(agent, { mcp: ['My Docs'] })).toEqual({
      tools: agent.tools,
      mcp: ['My_Docs'],
    });
  });
});

describe('pickUserToggleOptions', () => {
  it('keeps only user_toggle entries and nothing else from the options', () => {
    expect(
      pickUserToggleOptions({
        web_search: { user_toggle: 'off', defer_loading: true },
        search_mcp_docs: { allowed_callers: ['direct'] },
        [mcpServerToggleKey('docs')]: { user_toggle: 'on' },
      }),
    ).toEqual({
      web_search: { user_toggle: 'off' },
      [mcpServerToggleKey('docs')]: { user_toggle: 'on' },
    });
  });

  it('returns undefined without options', () => {
    expect(pickUserToggleOptions(undefined)).toBeUndefined();
  });
});
