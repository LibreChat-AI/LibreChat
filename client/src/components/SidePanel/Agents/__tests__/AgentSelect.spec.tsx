import React from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import { render, waitFor } from '@testing-library/react';
import type { UseMutationResult, QueryObserverResult } from '@tanstack/react-query';
import type { Agent, AgentCreateParams } from 'librechat-data-provider';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AgentSelect from '../AgentSelect';

jest.mock('~/data-provider', () => ({
  useListAgentsQuery: () => ({ data: [] }),
  useGetStartupConfig: () => ({ data: undefined }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAgentDefaultPermissionLevel: () => 1,
}));

jest.mock('@librechat/client', () => ({
  ControlCombobox: () => <div data-testid="agent-select-combobox" />,
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
  instructionsPromptReady,
  defaultValues,
}: {
  agent: Agent;
  onMethods: (methods: UseFormReturn<AgentForm>) => void;
  instructionsPromptReady?: boolean;
  defaultValues?: Partial<AgentForm>;
}) {
  const methods = useForm<AgentForm>({ defaultValues });
  onMethods(methods);

  return (
    <FormProvider {...methods}>
      <AgentSelect
        agentQuery={{ data: agent, isSuccess: true } as unknown as QueryObserverResult<Agent>}
        /** `null`, not `agent.id`: a non-null value with no matching row in the (empty,
         * mocked) agent list schedules `onSelect`'s "not found" timer, which would reset
         * the whole form back to defaults out from under this test. The load effect this
         * test targets keys off `agentQuery.data` alone. */
        selectedAgentId={null}
        setCurrentAgentId={jest.fn()}
        createMutation={
          { reset: jest.fn() } as unknown as UseMutationResult<Agent, Error, AgentCreateParams>
        }
        defaultStatefulCodeEnvironment="user"
        instructionsPromptReady={instructionsPromptReady}
      />
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

  it('keeps the form instructions-source/prompt untouched when the data is the basic projection', async () => {
    let methods: UseFormReturn<AgentForm> | undefined;

    render(
      <Harness
        /** No `instructionsPrompt` key at all, as the basic agent projection sends it. */
        agent={createAgent()}
        instructionsPromptReady={false}
        defaultValues={{
          instructionsSource: 'prompt',
          instructionsPrompt: {
            source: 'native',
            groupId: 'group_1',
            selection: { type: 'production' },
          },
        }}
        onMethods={(m) => (methods = m)}
      />,
    );

    await waitFor(() => expect(methods?.getValues('name')).toBe('Agent'));
    expect(methods?.getValues('instructionsSource')).toBe('prompt');
    expect(methods?.getValues('instructionsPrompt')).toEqual({
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'production' },
    });
  });
});
