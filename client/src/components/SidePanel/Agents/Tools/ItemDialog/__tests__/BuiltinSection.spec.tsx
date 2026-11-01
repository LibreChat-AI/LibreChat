import '@testing-library/jest-dom/extend-expect';
import { useForm, FormProvider, useWatch } from 'react-hook-form';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryScope, ArtifactModes } from 'librechat-data-provider';
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

describe('BuiltinSection artifacts mode docs link', () => {
  const docsLink = () => screen.queryByRole('link', { name: 'com_ui_artifacts_mode_custom_docs' });

  test('links Custom mode to the custom instructions docs in a new tab', () => {
    renderSection('artifacts', { artifacts: ArtifactModes.CUSTOM });

    const link = docsLink();
    expect(link).toHaveAttribute(
      'href',
      'https://www.librechat.ai/docs/features/artifacts#custom-instructions',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveTextContent('com_ui_learn_more');
    expect(screen.getByText(/com_ui_artifacts_mode_custom_info/)).toContainElement(link);
  });

  test.each([ArtifactModes.DEFAULT, ArtifactModes.SHADCNUI])(
    'shows no docs link for the %s mode',
    (mode) => {
      renderSection('artifacts', { artifacts: mode });
      expect(docsLink()).toBeNull();
    },
  );

  test('shows the link after switching to Custom', () => {
    renderSection('artifacts', { artifacts: ArtifactModes.DEFAULT });
    expect(docsLink()).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'com_ui_artifacts_mode_custom' }));
    expect(docsLink()).toBeInTheDocument();
  });
});
