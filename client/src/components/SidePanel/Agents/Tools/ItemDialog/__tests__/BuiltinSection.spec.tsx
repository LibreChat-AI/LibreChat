import '@testing-library/jest-dom/extend-expect';
import { MemoryScope } from 'librechat-data-provider';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';
import BuiltinSection from '../sections/BuiltinSection';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: {} }),
  useGetAgentsConfig: () => ({
    agentsConfig: {
      capabilities: ['stateful_code_sessions'],
      statefulCodeSessions: {
        environments: [{ id: 'byom', name: 'My machine', type: 'attached', default: true }],
      },
    },
  }),
  useAgentCapabilities: () => ({ backgroundToolsEnabled: false }),
}));
jest.mock('~/data-provider', () => ({
  useVerifyAgentToolAuth: () => ({ data: undefined }),
  useCodeEnvironmentStatusQueries: () => [],
}));
jest.mock('../../../Search/Action', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../../../FileContext', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../../../FileSearch', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../../../Code/Files', () => ({ __esModule: true, default: () => <div /> }));

function ScopeProbe() {
  const value = useWatch<AgentForm>({ name: 'memory_scope' });
  return <span data-testid="scope">{String(value)}</span>;
}

function renderSection(builtinId: string, defaultValues: Partial<AgentForm> = {}) {
  function Wrapper({ children }: { children: ReactNode }) {
    const methods = useForm<AgentForm>({ defaultValues: defaultValues as AgentForm });
    return (
      <FormProvider {...methods}>
        {children}
        <ScopeProbe />
      </FormProvider>
    );
  }

  return render(
    <BuiltinSection
      builtinId={builtinId as never}
      agentId="a1"
      contextFiles={[]}
      knowledgeFiles={[]}
      codeFiles={[]}
      description="com_agents_memory_info"
    />,
    { wrapper: Wrapper },
  );
}

const scopeCheckbox = () => screen.getByRole('checkbox', { name: 'com_agents_memory_scope' });

describe('BuiltinSection memory scope', () => {
  test('renders the scope control unchecked when memory is on the shared pool', () => {
    renderSection('memory', { memory: true, memory_scope: MemoryScope.user });
    expect(scopeCheckbox()).not.toBeChecked();
    expect(screen.getByText('com_agents_memory_scope_info')).toBeInTheDocument();
  });

  test('defaults to the shared pool when the agent has no saved scope', () => {
    renderSection('memory', { memory: true });
    expect(scopeCheckbox()).not.toBeChecked();
  });

  test('renders checked for an agent already partitioned to its own memories', () => {
    renderSection('memory', { memory: true, memory_scope: MemoryScope.agent });
    expect(scopeCheckbox()).toBeChecked();
  });

  test('toggling writes the scope back to the form in both directions', () => {
    renderSection('memory', { memory: true, memory_scope: MemoryScope.user });

    fireEvent.click(scopeCheckbox());
    expect(screen.getByTestId('scope')).toHaveTextContent(MemoryScope.agent);
    expect(scopeCheckbox()).toBeChecked();

    fireEvent.click(scopeCheckbox());
    expect(screen.getByTestId('scope')).toHaveTextContent(MemoryScope.user);
    expect(scopeCheckbox()).not.toBeChecked();
  });

  test('other builtins do not render the scope control', () => {
    renderSection('execute_code', { memory: true, memory_scope: MemoryScope.agent });
    expect(screen.queryByRole('checkbox', { name: 'com_agents_memory_scope' })).toBeNull();
  });
});

describe('BuiltinSection Run Code settings', () => {
  test('exposes stateful code configuration with the Run Code tool', () => {
    renderSection('execute_code', {
      execute_code: true,
      stateful_code_sessions: true,
      stateful_code_environment: 'user',
    });

    expect(screen.getByRole('switch', { name: 'com_ui_stateful_sessions' })).toBeChecked();
    expect(screen.getByTestId('code-environment-id')).toBeInTheDocument();
    expect(screen.getByTestId('stateful-code-environment')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_agent_git_name')).toBeInTheDocument();
    expect(screen.getByLabelText('com_ui_agent_git_email')).toBeInTheDocument();
  });
});
