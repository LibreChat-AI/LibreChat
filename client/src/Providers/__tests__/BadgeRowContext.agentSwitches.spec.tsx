import React from 'react';
import { RecoilRoot } from 'recoil';
import { render } from '@testing-library/react';
import type { AgentToolSwitches } from 'librechat-data-provider';
import BadgeRowProvider, { useBadgeRowContext } from '../BadgeRowContext';

const mockUseMCPServerManager = jest.fn();

const server = (serverName: string, chatMenu?: boolean) => ({
  serverName,
  config: { type: 'sse', url: 'http://mcp', chatMenu },
});

jest.mock('~/hooks', () => ({
  useMCPServerManager: (args: unknown) => mockUseMCPServerManager(args),
  useSearchApiKeyForm: () => ({}),
  useGetAgentsConfig: () => ({ agentsConfig: undefined }),
  useToolToggle: () => ({}),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
}));

let context: ReturnType<typeof useBadgeRowContext>;
const Consumer = () => {
  context = useBadgeRowContext();
  return null;
};

const renderProvider = (agentToolSwitches?: AgentToolSwitches) =>
  render(
    <RecoilRoot>
      <BadgeRowProvider conversationId="convo_1" agentToolSwitches={agentToolSwitches}>
        <Consumer />
      </BadgeRowProvider>
    </RecoilRoot>,
  );

describe('BadgeRowProvider agent switches', () => {
  beforeEach(() => {
    mockUseMCPServerManager.mockReset();
    const hidden = server('hidden', false);
    const visible = server('visible');
    const other = server('other');
    mockUseMCPServerManager.mockReturnValue({
      availableMCPServers: [hidden, visible, other],
      selectableServers: [visible, other],
    });
  });

  it("offers the agent's switchable servers, including one hidden from the chat menu", () => {
    renderProvider({ builtins: {}, mcp: { hidden: true, visible: false } });

    expect(mockUseMCPServerManager).toHaveBeenCalledWith(
      expect.objectContaining({ agentServers: ['hidden', 'visible'] }),
    );
    const names = (list: Array<{ serverName: string }>) => list.map((s) => s.serverName);
    expect(names(context!.mcpServerManager.selectableServers)).toEqual(['hidden', 'visible']);
    expect(names(context!.mcpServerManager.availableMCPServers)).toEqual(['hidden', 'visible']);
  });

  it('leaves the manager untouched outside a saved agent chat', () => {
    renderProvider();

    expect(mockUseMCPServerManager).toHaveBeenCalledWith(
      expect.objectContaining({ agentServers: undefined }),
    );
    expect(context!.mcpServerManager.selectableServers).toHaveLength(2);
  });
});
