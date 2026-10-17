import { Constants, LocalStorageKeys, Tools, mcpServerToggleKey } from 'librechat-data-provider';
import type { Agent } from 'librechat-data-provider';
import { applyAgentToolSwitchDefaults } from '../endpoints';
import { setTimestamp } from '../timestamps';

const createAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    id: 'agent_1',
    tools: [Tools.web_search, Tools.execute_code, 'search_mcp_alpha', 'lookup_mcp_beta'],
    tool_options: {
      [Tools.web_search]: { user_toggle: 'on' },
      [Tools.execute_code]: { user_toggle: 'off' },
      [mcpServerToggleKey('alpha')]: { user_toggle: 'on' },
      [mcpServerToggleKey('beta')]: { user_toggle: 'off' },
    },
    ...overrides,
  }) as Agent;

function writeToggle(storagePrefix: string, convoId: string, value: unknown): void {
  const key = `${storagePrefix}${convoId}`;
  localStorage.setItem(key, JSON.stringify(value));
  setTimestamp(key);
}

describe('applyAgentToolSwitchDefaults', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('seeds a new chat from the creator defaults', () => {
    const result = applyAgentToolSwitchDefaults({
      agent: createAgent(),
      convoId: `${Constants.NEW_CONVO}`,
      isNewConvo: true,
    });
    expect(result).toEqual({ web_search: true, execute_code: false, mcp: ['alpha'] });
  });

  it('ignores stored overrides for a new chat', () => {
    writeToggle(LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_, 'convo-1', false);
    const result = applyAgentToolSwitchDefaults({
      agent: createAgent(),
      convoId: 'convo-1',
      isNewConvo: true,
    });
    expect(result.web_search).toBe(true);
  });

  it('layers stored overrides on top of defaults for an existing chat', () => {
    writeToggle(LocalStorageKeys.LAST_WEB_SEARCH_TOGGLE_, 'convo-1', false);
    writeToggle(LocalStorageKeys.LAST_CODE_TOGGLE_, 'convo-1', true);
    localStorage.setItem(`${LocalStorageKeys.LAST_MCP_}convo-1`, JSON.stringify(['beta']));
    const result = applyAgentToolSwitchDefaults({
      agent: createAgent(),
      convoId: 'convo-1',
      isNewConvo: false,
    });
    expect(result).toEqual({ web_search: false, execute_code: true, mcp: ['beta'] });
  });

  it('never stores keys outside the switchable set', () => {
    writeToggle(LocalStorageKeys.LAST_FILE_SEARCH_TOGGLE_, 'convo-1', true);
    localStorage.setItem(
      `${LocalStorageKeys.LAST_MCP_}convo-1`,
      JSON.stringify(['alpha', 'gamma']),
    );
    const result = applyAgentToolSwitchDefaults({
      agent: createAgent({ tools: [Tools.web_search], tool_options: undefined }),
      convoId: 'convo-1',
      isNewConvo: false,
    });
    expect(result).toEqual({});
  });
});
