import React, { useEffect } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { QueryObserverResult, UseMutationResult } from '@tanstack/react-query';
import type { Agent, AgentCreateParams } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { AgentPanelProvider, useAgentPanelContext } from '../AgentPanelContext';
import AgentSelect from '~/components/SidePanel/Agents/AgentSelect';

const mockObserve = jest.fn();
const mockActivate = jest.fn();
const mockServers: never[] = [];
const mockAgents = ['agent_a', 'agent_b', 'agent_c', 'explicit-agent'].map(
  (id) => ({ id, name: id, model: 'gpt-4', provider: 'openai' }) as Agent,
);
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAgentDefaultPermissionLevel: () => 1,
  activateCatalog: (...args: string[]) => mockActivate(...args),
  useCatalogReady: () => false,
  useGetAgentsConfig: () => ({}),
  useMCPServerManager: (options: { observeToolAuthorization: boolean }) => {
    mockObserve(options.observeToolAuthorization);
    return { availableMCPServers: mockServers, isLoading: false };
  },
}));
jest.mock('~/data-provider', () => ({
  useListAgentsQuery: () => ({ data: mockAgents }),
  useAvailableToolsQuery: () => ({}),
  useGetActionsQuery: () => ({}),
  useGetStartupConfig: () => ({}),
  useMCPToolsQuery: () => ({}),
}));
jest.mock('~/components/Agents/MineFilterToggle', () => () => null);
jest.mock('@librechat/client', () => ({
  ControlCombobox: ({
    items,
    setValue,
  }: {
    items: { label: string; value: string }[];
    setValue: (value: string) => void;
  }) => (
    <div>
      {items.map((item) => (
        <button key={item.value} onClick={() => setValue(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  ),
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
function Selection() {
  const { agent_id, setCurrentAgentId, retainAgentSession } = useAgentPanelContext();
  const methods = useForm<AgentForm>();
  const { isDirty } = methods.formState;
  useEffect(() => {
    if (isDirty) retainAgentSession();
  }, [isDirty, retainAgentSession]);
  const agent = mockAgents.find((item) => item.id === agent_id);
  return (
    <FormProvider {...methods}>
      <AgentSelect
        agentQuery={{ data: agent, isSuccess: !!agent } as QueryObserverResult<Agent>}
        selectedAgentId={agent_id ?? null}
        setCurrentAgentId={setCurrentAgentId}
        createMutation={
          { reset: jest.fn() } as unknown as UseMutationResult<Agent, Error, AgentCreateParams>
        }
        defaultStatefulCodeEnvironment="user"
      />
      <input aria-label="Agent draft" {...methods.register('name')} />
      <Consumer />
    </FormProvider>
  );
}

function Editor({
  agentId,
  ready = true,
  visible = true,
  selection = false,
}: {
  agentId?: string;
  ready?: boolean;
  visible?: boolean;
  selection?: boolean;
}) {
  return (
    <AgentPanelProvider initialAgentId={agentId} conversationReady={ready} visible={visible}>
      {selection ? <Selection /> : <Consumer />}
    </AgentPanelProvider>
  );
}

describe('agent editor session ownership', () => {
  it('does not claim selection ownership when AgentSelect hydrates automatically, but retains dirty edits', async () => {
    const { rerender } = render(<Editor agentId="agent_a" selection />);
    await waitFor(() => expect(screen.getByLabelText('Agent draft')).toHaveValue('agent_a'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    rerender(<Editor agentId="agent_b" selection />);
    await waitFor(() =>
      expect(screen.getByLabelText('Current agent')).toHaveTextContent('agent_b'),
    );
    expect(screen.getByLabelText('Agent draft')).toHaveValue('agent_b');
    fireEvent.change(screen.getByLabelText('Agent draft'), {
      target: { value: 'Dirty user edit' },
    });
    rerender(<Editor agentId="agent_c" selection visible={false} />);
    expect(screen.getByLabelText('Current agent')).toHaveTextContent('agent_b');
    expect(screen.getByLabelText('Agent draft')).toHaveValue('Dirty user edit');
    fireEvent.click(screen.getByRole('button', { name: 'agent_a' }));
    rerender(<Editor agentId="agent_c" selection />);
    expect(screen.getByLabelText('Current agent')).toHaveTextContent('agent_a');
    await waitFor(() => expect(screen.getByLabelText('Agent draft')).toHaveValue('agent_a'));
  });

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
