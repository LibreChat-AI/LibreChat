import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useForm, useWatch, Controller, FormProvider } from 'react-hook-form';
import type { UseMutationResult, QueryObserverResult } from '@tanstack/react-query';
import type { Agent, AgentCreateParams } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AgentSelect from '../AgentSelect';

const mockListAgents = jest.fn<{ data: { id: string; name: string }[] }, unknown[]>(() => ({
  data: [],
}));

jest.mock('~/data-provider', () => ({
  useListAgentsQuery: (...args: unknown[]) => mockListAgents(...args),
  useGetStartupConfig: () => ({ data: undefined }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAgentDefaultPermissionLevel: () => 1,
}));

jest.mock('@librechat/client', () => ({
  ControlCombobox: ({
    searchActions,
    items,
  }: {
    searchActions?: React.ReactNode;
    items: { label: string; value: string }[];
  }) => (
    <div data-testid="agent-select-combobox">
      {searchActions}
      {items.map((item) => (
        <span key={item.value}>{item.label}</span>
      ))}
    </div>
  ),
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
}));

/**
 * Renders `AgentSelect` with an already-successful `agentQuery`, which drives its
 * `resetAgentForm` load effect the same way selecting an agent (or a background
 * refetch) does. `resetAgentForm` is a closure, not exported, so this is the
 * narrowest seam that observes its instructions-source/instructions-prompt mapping.
 */
function Harness({
  agent,
  onMethods,
  formReady,
  defaultValues,
  selectedAgentId = null,
  showInstructions = false,
}: {
  selectedAgentId?: string | null;
  agent: Agent;
  onMethods: (methods: UseFormReturn<AgentForm>) => void;
  formReady?: boolean;
  defaultValues?: Partial<AgentForm>;
  showInstructions?: boolean;
}) {
  const methods = useForm<AgentForm>({ defaultValues });
  const id = useWatch({ control: methods.control, name: 'id' });
  onMethods(methods);

  return (
    <FormProvider {...methods}>
      <AgentSelect
        agentQuery={{ data: agent, isSuccess: true } as unknown as QueryObserverResult<Agent>}
        /** Form-reset tests leave this null to avoid scheduling selection from an empty list. */
        selectedAgentId={selectedAgentId}
        setCurrentAgentId={jest.fn()}
        createMutation={
          { reset: jest.fn() } as unknown as UseMutationResult<Agent, Error, AgentCreateParams>
        }
        defaultStatefulCodeEnvironment="user"
        formReady={formReady}
      />
      {showInstructions && id === agent.id && (
        <Controller
          name="instructions"
          control={methods.control}
          render={({ field }) => (
            <textarea {...field} value={field.value ?? ''} aria-label="Instructions" />
          )}
        />
      )}
    </FormProvider>
  );
}

const createAgent = (overrides: Partial<Agent> = {}): Agent =>
  ({
    id: 'agent_1',
    name: 'Agent',
    provider: 'openai',
    model: 'gpt-4',
    ...overrides,
  }) as Agent;

describe('AgentSelect resetAgentForm', () => {
  it('maps a linked agent to Prompt mode with the link copied verbatim', async () => {
    const link = {
      source: 'native' as const,
      groupId: 'group_1',
      selection: { type: 'production' as const },
    };
    let methods: UseFormReturn<AgentForm> | undefined;

    render(
      <Harness
        agent={createAgent({ instructionsPrompt: link })}
        onMethods={(m) => (methods = m)}
      />,
    );

    await waitFor(() => expect(methods?.getValues('instructionsSource')).toBe('prompt'));
    expect(methods?.getValues('instructionsPrompt')).toEqual(link);
  });

  it('maps a restricted stub to Prompt mode with the stub preserved', async () => {
    const stub = { source: 'native' as const, restricted: true as const };
    let methods: UseFormReturn<AgentForm> | undefined;

    render(
      <Harness
        agent={createAgent({ instructionsPrompt: stub })}
        onMethods={(m) => (methods = m)}
      />,
    );

    await waitFor(() => expect(methods?.getValues('instructionsSource')).toBe('prompt'));
    expect(methods?.getValues('instructionsPrompt')).toEqual(stub);
  });

  it('maps an agent with no link to Inline mode with a null prompt', async () => {
    let methods: UseFormReturn<AgentForm> | undefined;

    render(
      <Harness
        agent={createAgent({ instructionsPrompt: null })}
        onMethods={(m) => (methods = m)}
      />,
    );

    await waitFor(() => expect(methods?.getValues('instructionsSource')).toBe('inline'));
    expect(methods?.getValues('instructionsPrompt')).toBeNull();
  });

  it('hydrates the editor only after the expanded response arrives', async () => {
    let methods: UseFormReturn<AgentForm> | undefined;
    const onMethods = (value: UseFormReturn<AgentForm>) => (methods = value);
    const { rerender } = render(
      <Harness agent={createAgent()} formReady={false} onMethods={onMethods} showInstructions />,
    );

    expect(methods?.getValues('name')).toBeUndefined();
    expect(screen.queryByRole('textbox', { name: 'Instructions' })).toBeNull();

    rerender(
      <Harness
        agent={createAgent({ instructions: 'Saved instructions', tools: ['mock_tool'] })}
        onMethods={onMethods}
        showInstructions
      />,
    );

    expect(await screen.findByRole('textbox', { name: 'Instructions' })).toHaveValue(
      'Saved instructions',
    );
    expect(methods?.getValues('tools')).toEqual(['mock_tool']);
  });

  it('hydrates watched fields when the editor remounts with cached expanded data', async () => {
    render(
      <Harness
        agent={createAgent({ instructions: 'Restored instructions' })}
        defaultValues={{ id: '', instructions: '' }}
        onMethods={() => undefined}
        showInstructions
      />,
    );

    expect(await screen.findByRole('textbox', { name: 'Instructions' })).toHaveValue(
      'Restored instructions',
    );
  });
});

describe('AgentSelect ownership filter', () => {
  it('renders an icon-only quiet filter with an accessible name', () => {
    render(<Harness agent={createAgent()} onMethods={() => undefined} />);
    const toggle = screen.getByRole('button', { name: 'com_agents_my_agents' });
    expect(toggle.textContent).toBe('');
    expect(toggle).toHaveAttribute('variant', 'quiet');
  });

  it('changes the icon when ownership filtering is active', () => {
    render(<Harness agent={createAgent()} onMethods={() => undefined} />);
    const toggle = screen.getByRole('button', { name: 'com_agents_my_agents' });
    fireEvent.click(toggle);
    expect(toggle.querySelector('.lucide-user-round-check')).toBeInTheDocument();
  });

  it('defaults to the original query and an unpressed filter', () => {
    render(<Harness agent={createAgent()} onMethods={() => undefined} />);
    expect(mockListAgents).toHaveBeenLastCalledWith({ requiredPermission: 1 }, expect.any(Object));
    expect(screen.getByRole('button', { name: 'com_agents_my_agents' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('requests only authored agents when the filter is enabled', () => {
    render(<Harness agent={createAgent()} onMethods={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'com_agents_my_agents' }));
    expect(mockListAgents).toHaveBeenLastCalledWith(
      { requiredPermission: 1, mine: 1 },
      expect.any(Object),
    );
  });

  it('restores the original query when the filter is disabled', () => {
    render(<Harness agent={createAgent()} onMethods={() => undefined} />);
    const toggle = screen.getByRole('button', { name: 'com_agents_my_agents' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(mockListAgents).toHaveBeenLastCalledWith({ requiredPermission: 1 }, expect.any(Object));
  });

  it('keeps the current agent available when absent from the filtered list', () => {
    render(
      <Harness
        selectedAgentId="agent_1"
        agent={createAgent({ name: 'Shared agent' })}
        onMethods={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_agents_my_agents' }));
    expect(screen.getByText('Shared agent')).toBeInTheDocument();
  });
});
