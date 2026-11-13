import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentPanelProvider, useAgentPanelContext } from '../AgentPanelContext';

const mockObserve = jest.fn();
const mockActivate = jest.fn();
const mockServers: never[] = [];
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  activateCatalog: (...args: string[]) => mockActivate(...args),
  useCatalogReady: () => false,
  useGetAgentsConfig: () => ({}),
  useMCPServerManager: (options: { observeToolAuthorization: boolean }) => {
    mockObserve(options.observeToolAuthorization);
    return { availableMCPServers: mockServers, isLoading: false };
  },
}));
jest.mock('~/data-provider', () => ({
  useAvailableToolsQuery: () => ({}),
  useGetActionsQuery: () => ({}),
  useGetStartupConfig: () => ({}),
  useMCPToolsQuery: () => ({}),
}));
jest.mock('~/hooks/MCP/useMCPRefresh', () => ({ useMCPRefresh: () => {} }));
jest.mock('~/hooks/Nav/useRevealChat', () => ({ __esModule: true, default: () => jest.fn() }));

const labels = { select: 'Select agent', create: 'New agent', keep: 'Keep section' };

function Consumer() {
  const { agent_id, activePanel, setCurrentAgentId, setActivePanel } = useAgentPanelContext();
  return (
    <>
      <output aria-label="Current agent">{agent_id ?? 'empty'}</output>
      <output aria-label="Current section">{activePanel}</output>
      <button onClick={() => setCurrentAgentId('explicit-agent')}>{labels.select}</button>
      <button onClick={() => setCurrentAgentId(undefined)}>{labels.create}</button>
      <button onClick={() => setActivePanel((panel) => panel)}>{labels.keep}</button>
    </>
  );
}
function Editor({
  agentId,
  ready = true,
  visible = true,
}: {
  agentId?: string;
  ready?: boolean;
  visible?: boolean;
}) {
  return (
    <AgentPanelProvider initialAgentId={agentId} conversationReady={ready} visible={visible}>
      <Consumer />
    </AgentPanelProvider>
  );
}

describe('agent editor session ownership', () => {
  it('follows hydrated conversation selection until the editor explicitly selects an agent', async () => {
    const { rerender } = render(<Editor ready={false} />);
    expect(screen.getByLabelText('Current agent')).toHaveTextContent('empty');
    rerender(<Editor agentId="agent_a" />);
    await waitFor(() =>
      expect(screen.getByLabelText('Current agent')).toHaveTextContent('agent_a'),
    );
    rerender(<Editor agentId="agent_b" />);
    await waitFor(() =>
      expect(screen.getByLabelText('Current agent')).toHaveTextContent('agent_b'),
    );
    fireEvent.click(screen.getByText('Select agent'));
    rerender(<Editor agentId="agent_c" visible={false} />);
    expect(screen.getByLabelText('Current agent')).toHaveTextContent('explicit-agent');
    expect(mockObserve).toHaveBeenLastCalledWith(false);
    rerender(<Editor agentId="agent_d" />);
    expect(screen.getByLabelText('Current agent')).toHaveTextContent('explicit-agent');
    expect(mockObserve).toHaveBeenLastCalledWith(true);
  });

  it('does not overwrite an explicit new agent when the conversation hydrates', () => {
    const { rerender } = render(<Editor ready={false} />);
    fireEvent.click(screen.getByText('New agent'));
    rerender(<Editor agentId="agent_chat" />);
    expect(screen.getByLabelText('Current agent')).toHaveTextContent('empty');
  });

  it('does not release catalogs for an invisible editor', () => {
    render(<Editor agentId="agent_chat" visible={false} />);
    expect(mockActivate).not.toHaveBeenCalled();
    expect(mockObserve).toHaveBeenLastCalledWith(false);
  });
});
