import { AxiosError } from 'axios';
import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { AxiosResponse } from 'axios';
import type { CodeWorkspaceResult } from '~/hooks';
import { codeEnvironmentReconciliationsAtom } from '~/store/codeEnvironmentReconciliation';
import { useConversationCodeEnvironmentRecovery } from '~/data-provider';
import CodeWorkspaceMenu from '../CodeWorkspaceMenu';

const mockShowToast = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, unknown>) => {
    if (key === 'com_ui_code_workspace_required_for')
      return `Choose a workspace for ${values?.[0]} on ${values?.[1]}.`;
    if (key === 'com_ui_code_workspace_graph_requirement')
      return 'Every coding agent in this chat needs a workspace, including subagents.';
    if (key === 'com_ui_code_workspace_used_by') return `Used by ${values?.[0]}`;
    if (key === 'com_ui_code_workspace_agent_status')
      return `${values?.[0]} needs ${values?.[1]}: ${values?.[2]}`;
    return key;
  },
}));

jest.mock('@librechat/client', () => {
  const { CheckboxGlyph, TooltipAnchor } = jest.requireActual('@librechat/client');
  return {
    CheckboxGlyph,
    composerControlClasses: () => 'composer-control',
    useToastContext: () => ({ showToast: mockShowToast }),
    TooltipAnchor,
  };
});

const conversation = {
  conversationId: 'new',
  endpoint: 'agents',
  agent_id: 'agent-1',
  title: 'Code',
} as TConversation;
const environment = {
  id: 'personal-vm',
  name: 'Personal VM',
  type: 'attached' as const,
  baseURL: 'https://code.example.com',
};

function workspace(overrides: Partial<CodeWorkspaceResult> = {}): CodeWorkspaceResult {
  const selected = { environmentId: environment.id, workspaceId: 'project-a' };
  return {
    required: true,
    supportsEnvironmentDecisions: true,
    locked: false,
    mode: 'attached',
    state: 'ready',
    canSubmit: true,
    visible: true,
    environments: [
      {
        environment,
        state: 'ready',
        workspaces: [{ id: 'project-a', name: 'Project A' }],
        selected,
      },
    ],
    selections: [selected],
    resolveSelections: () => [selected],
    resolveSubmission: () => ({ codeEnvironmentMode: 'attached', codeWorkspaces: [selected] }),
    rememberSelection: jest.fn(),
    ...overrides,
  };
}

function renderMenu(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (element: React.ReactElement) => (
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>
  );
  const result = render(wrap(ui));
  return {
    ...result,
    rerenderMenu: (element: React.ReactElement) => result.rerender(wrap(element)),
  };
}

describe('CodeWorkspaceMenu', () => {
  test('separates machine, folder, and reported branch without committing defaults', async () => {
    const graph = workspace({ machineOptions: [environment] });
    graph.environments[0].workspaces[0].environment = {
      fingerprint: 'a'.repeat(64),
      repo: 'example/app',
      ref: 'dev',
      actions: [],
    };
    const setter = jest.fn();
    renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />);
    expect(screen.getByTestId('code-machine')).toHaveTextContent('Personal VM');
    expect(screen.getByTestId('code-workspace')).toHaveTextContent('Project A');
    expect(screen.getByTestId('code-workspace')).not.toHaveTextContent('Personal VM');
    expect(screen.getByTestId('code-branch')).toHaveTextContent('dev');
    expect(screen.getByTestId('code-branch').closest('button')).toBeNull();
    await userEvent.click(screen.getByTestId('code-machine'));
    expect(screen.queryByRole('menuitemradio', { name: /Project A/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Personal VM' }));
    expect(await screen.findByRole('menuitemradio', { name: /Project A/ })).toBeVisible();
    expect(setter).not.toHaveBeenCalled();
  });

  test('cancels machine discovery with Escape without committing a decision', async () => {
    const setter = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu setConversation={setter} workspace={workspace()} disabled={false} />,
    );
    const machineButton = screen.getByTestId('code-machine');
    machineButton.focus();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() =>
      expect(screen.getByRole('menu')).toContainElement(document.activeElement as HTMLElement),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(machineButton).toBeEnabled();
    expect(setter).not.toHaveBeenCalled();
  });

  test('opens the workspace menu with keyboard focus and cancels without committing', async () => {
    const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
    const read = jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockResolvedValue({
      environmentId: alternate.id,
      status: 'ready',
      operations: ['read_file'],
      workspaces: [{ id: 'runtime', name: 'Runtime Project' }],
    });
    const setter = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setter}
        workspace={workspace({ machineOptions: [environment, alternate] })}
        disabled={false}
      />,
    );
    const machineButton = screen.getByTestId('code-machine');
    machineButton.focus();
    await userEvent.keyboard('{ArrowDown}');
    const candidate = await screen.findByRole('menuitem', { name: alternate.name });
    await waitFor(() =>
      expect(candidate.closest('[role="menu"]')).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(candidate).toHaveFocus());
    await userEvent.keyboard('{Enter}');
    const folder = await screen.findByRole('menuitemradio', { name: /Runtime Project/ });
    await waitFor(() =>
      expect(folder.closest('[role="menu"]')).toContainElement(
        document.activeElement as HTMLElement,
      ),
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('code-workspace')).toBeEnabled();
    expect(setter).not.toHaveBeenCalled();
    read.mockRestore();
  });

  test.each(['ArrowDown', 'ArrowUp'])(
    'reopens current folders with %s after cancelling another machine',
    async (key) => {
      const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
      const read = jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockResolvedValue({
        environmentId: alternate.id,
        status: 'ready',
        operations: ['read_file'],
        workspaces: [{ id: 'runtime', name: 'Runtime Project' }],
      });
      const graph = workspace({ machineOptions: [environment, alternate] });
      graph.environments[0].environment = {
        ...environment,
        configSchema: { workspaces: { allowCheckoutSelection: true } },
      };
      graph.environments[0].workspaces[0].workspaceInstances = ['git_worktree'];
      const selected = {
        environmentId: environment.id,
        workspaceId: 'project-a',
        checkout: 'source' as const,
      };
      graph.environments[0].selected = selected;
      const setter = jest.fn();
      renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />);
      await userEvent.click(screen.getByTestId('code-machine'));
      await userEvent.click(screen.getByRole('menuitem', { name: alternate.name }));
      const alternateFolder = await screen.findByRole('menuitemradio', { name: /Runtime Project/ });
      await waitFor(() =>
        expect(alternateFolder.closest('[role="menu"]')).toContainElement(
          document.activeElement as HTMLElement,
        ),
      );
      await userEvent.keyboard('{Escape}');
      await waitFor(() =>
        expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument(),
      );
      const folderButton = screen.getByTestId('code-workspace');
      folderButton.focus();
      await userEvent.keyboard(`{${key}}`);
      expect(await screen.findByRole('menuitemradio', { name: /Project A/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(
        screen.getByRole('menuitemradio', { name: /com_ui_code_checkout_source/ }),
      ).toHaveAttribute('aria-checked', 'true');
      expect(
        screen.queryByRole('menuitemradio', { name: /Runtime Project/ }),
      ).not.toBeInTheDocument();
      expect(setter).not.toHaveBeenCalled();
      expect(graph.rememberSelection).not.toHaveBeenCalled();
      expect(graph.environments[0].selected).toEqual(selected);
      read.mockRestore();
    },
  );

  test.each(['source', 'isolated', undefined] as const)(
    'shows and updates the inline worktree control for %s without losing ownership',
    async (checkout) => {
      const graph = workspace();
      graph.environments[0].environment = {
        ...environment,
        configSchema: { workspaces: { allowCheckoutSelection: true } },
      };
      graph.environments[0].workspaces[0].workspaceInstances = ['git_worktree'];
      const selected = {
        environmentId: environment.id,
        workspaceId: 'project-a',
        agentIds: ['lia'],
        checkout,
      };
      graph.environments[0].selected = selected;
      const setter = jest.fn();
      renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />);
      const control = screen.getByRole('checkbox', { name: 'com_ui_code_worktree' });
      expect(control).toHaveAttribute(
        'aria-checked',
        checkout == null ? 'mixed' : String(checkout === 'isolated'),
      );
      expect(setter).not.toHaveBeenCalled();
      await userEvent.click(control);
      expect(setter.mock.calls[0][0](conversation).codeWorkspaces).toEqual([
        { ...selected, checkout: checkout === 'isolated' ? 'source' : 'isolated' },
      ]);
    },
  );

  test('reports machine, branch, and worktree mode on a restored sealed chat', () => {
    const graph = workspace({ locked: true, transition: undefined });
    graph.environments[0].workspaces[0].environment = {
      fingerprint: 'a'.repeat(64),
      ref: 'dev',
      actions: [],
    };
    graph.environments[0].workspaces[0].workspaceInstances = ['git_worktree'];
    graph.environments[0].selected = {
      environmentId: environment.id,
      workspaceId: 'project-a',
      checkout: 'isolated',
    };
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
    );
    expect(screen.getByTestId('code-machine-status')).toHaveTextContent('Personal VM');
    expect(screen.getByTestId('code-branch')).toHaveTextContent('dev');
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });

  test.each(['source', 'isolated'] as const)(
    'keeps recorded %s visible when worker isolation support disappears',
    async (checkout) => {
      const graph = workspace({ locked: true, transition: undefined });
      graph.environments[0].environment = {
        ...environment,
        configSchema: { workspaces: { allowCheckoutSelection: true } },
      };
      graph.environments[0].workspaces[0].workspaceInstances = ['git_worktree'];
      const selected = { environmentId: environment.id, workspaceId: 'project-a', checkout };
      graph.environments[0].selected = selected;
      const setter = jest.fn();
      const { rerenderMenu } = renderMenu(
        <CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />,
      );
      graph.environments[0].workspaces[0].workspaceInstances = undefined;
      graph.environments[0].state = checkout === 'isolated' ? 'unsupported' : 'ready';
      graph.state = graph.environments[0].state;
      graph.canSubmit = checkout !== 'isolated';
      rerenderMenu(
        <CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />,
      );
      const control = screen.getByRole('checkbox', { name: 'com_ui_code_worktree' });
      expect(control).toHaveAttribute('aria-checked', String(checkout === 'isolated'));
      expect(control).toBeDisabled();
      await userEvent.click(control);
      expect(setter).not.toHaveBeenCalled();
      expect(graph.rememberSelection).not.toHaveBeenCalled();
      expect(graph.environments[0].selected).toEqual(selected);
    },
  );

  test.each([
    { enabled: false, capable: true },
    { enabled: true, capable: false },
  ])(
    'reports an unsupported draft checkout without permitting an unavailable override: %j',
    async ({ enabled, capable }) => {
      const graph = workspace({ state: 'unsupported', canSubmit: false });
      graph.environments[0].environment = {
        ...environment,
        configSchema: { workspaces: { allowCheckoutSelection: enabled } },
      };
      graph.environments[0].workspaces[0].workspaceInstances = capable
        ? ['git_worktree']
        : undefined;
      graph.environments[0].selected = {
        environmentId: environment.id,
        workspaceId: 'project-a',
        checkout: 'isolated',
      };
      const setter = jest.fn();
      renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />);
      const control = screen.getByRole('checkbox', { name: 'com_ui_code_worktree' });
      expect(control).toHaveAttribute('aria-checked', 'true');
      expect(control).toBeDisabled();
      await userEvent.click(control);
      expect(setter).not.toHaveBeenCalled();
      expect(graph.rememberSelection).not.toHaveBeenCalled();
    },
  );

  test('keeps automatic worktree policy visible but read-only when overrides are disabled', () => {
    const graph = workspace();
    graph.environments[0].workspaces[0].workspaceInstances = ['git_worktree'];
    const setter = jest.fn();
    renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-checked', 'mixed');
    expect(screen.getByRole('checkbox')).toHaveTextContent('com_ui_code_checkout_automatic');
    expect(setter).not.toHaveBeenCalled();
  });

  test.each([true, false])(
    'shows linked-worktree capability only when policy allows it: %s',
    (enabled) => {
      const graph = workspace();
      graph.environments[0].environment = {
        ...environment,
        configSchema: { workspaces: { linkedWorktrees: enabled, allowCheckoutSelection: false } },
      };
      graph.environments[0].workspaces[0].workspaceScopes = ['git_linked_worktree'];
      renderMenu(
        <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
      );
      expect(screen.queryByText('com_ui_code_linked_worktrees') != null).toBe(enabled);
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    },
  );

  describe.each([false, true])('checkout context with locked=%s', (locked) => {
    test.each([
      { checkout: 'source', capable: true, linked: undefined, allowed: true, expected: true },
      { checkout: 'source', capable: true, linked: true, allowed: true, expected: true },
      { checkout: 'source', capable: true, linked: false, allowed: true, expected: false },
      { checkout: 'isolated', capable: true, linked: undefined, allowed: true, expected: false },
      { checkout: 'isolated', capable: true, linked: true, allowed: true, expected: false },
      { checkout: undefined, capable: true, linked: undefined, allowed: false, expected: false },
      { checkout: undefined, capable: true, linked: true, allowed: true, expected: false },
      { checkout: undefined, capable: false, linked: undefined, allowed: false, expected: true },
      { checkout: undefined, capable: false, linked: true, allowed: false, expected: true },
      { checkout: undefined, capable: false, linked: false, allowed: true, expected: false },
      { checkout: 'source', capable: false, linked: undefined, allowed: true, expected: true },
      { checkout: 'source', capable: true, linked: true, allowed: false, expected: false },
      { checkout: 'isolated', capable: false, linked: true, allowed: true, expected: false },
    ] as const)(
      'reports available linked lanes without changing the checkout: %j',
      ({ checkout, capable, linked, allowed, expected }) => {
        const graph = workspace({ locked });
        graph.environments[0].environment = {
          ...environment,
          configSchema: {
            workspaces: { linkedWorktrees: linked, allowCheckoutSelection: allowed },
          },
        };
        graph.environments[0].workspaces[0].workspaceInstances = capable
          ? ['git_worktree']
          : undefined;
        graph.environments[0].workspaces[0].workspaceScopes = ['git_linked_worktree'];
        const selected = {
          environmentId: environment.id,
          workspaceId: 'project-a',
          checkout,
          agentIds: ['lia'],
        };
        graph.environments[0].selected = selected;
        const setter = jest.fn();
        renderMenu(
          <CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />,
        );
        expect(screen.queryByText('com_ui_code_linked_worktrees') != null).toBe(expected);
        const control = screen.queryByRole('checkbox', { name: 'com_ui_code_worktree' });
        if (capable || checkout != null) {
          expect(control).toHaveAttribute(
            'aria-checked',
            checkout == null ? 'mixed' : String(checkout === 'isolated'),
          );
        } else {
          expect(control).toBeNull();
        }
        expect(setter).not.toHaveBeenCalled();
        expect(graph.rememberSelection).not.toHaveBeenCalled();
        expect(graph.environments[0].selected).toEqual(selected);
      },
    );
  });

  test('hides Git context when continuing without an attached workspace', () => {
    const graph = workspace({ mode: 'without_attached', state: 'without_attached' });
    graph.environments[0].workspaces[0].workspaceInstances = ['git_worktree'];
    graph.environments[0].workspaces[0].environment = {
      fingerprint: 'a'.repeat(64),
      ref: 'dev',
      actions: [],
    };
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
    );
    expect(screen.queryByTestId('code-branch')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  test('disables the inline worktree choice during generation', async () => {
    const graph = workspace();
    graph.environments[0].environment = {
      ...environment,
      configSchema: { workspaces: { allowCheckoutSelection: true } },
    };
    graph.environments[0].workspaces[0].workspaceInstances = ['git_worktree'];
    const setter = jest.fn();
    renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={true} />);
    expect(screen.getByTestId('code-machine')).toBeDisabled();
    expect(screen.getByTestId('code-workspace')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(setter).not.toHaveBeenCalled();
  });

  test.each(['source', 'isolated'] as const)(
    'keeps explicit %s when choosing another repository on the same machine',
    async (checkout) => {
      const graph = workspace();
      graph.environments[0].selected = {
        environmentId: environment.id,
        workspaceId: 'project-a',
        checkout,
      };
      graph.environments[0].workspaces.push({ id: 'project-b', name: 'Project B' });
      const setConversation = jest.fn();
      renderMenu(
        <CodeWorkspaceMenu setConversation={setConversation} workspace={graph} disabled={false} />,
      );
      await userEvent.click(screen.getByTestId('code-workspace'));
      await userEvent.click(screen.getByRole('menuitemradio', { name: /Project B/ }));
      expect(setConversation.mock.calls[0][0](conversation)).toMatchObject({
        codeWorkspaces: [{ environmentId: environment.id, workspaceId: 'project-b', checkout }],
      });
    },
  );

  test('reports checkout modes for every environment on a restored sealed chat', () => {
    const graph = workspace({ locked: true, transition: undefined });
    graph.environments = ['source', 'isolated'].map((checkout, index) => ({
      environment: { ...environment, id: `vm-${index}`, name: `Machine ${index}` },
      state: 'ready' as const,
      workspaces: [{ id: 'repo', name: `Repository ${index}` }],
      selected: {
        environmentId: `vm-${index}`,
        workspaceId: 'repo',
        checkout: checkout as 'source' | 'isolated',
      },
    }));
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
    );
    expect(
      screen.getByText('Machine 0 · Repository 0 · com_ui_code_checkout_source'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Machine 1 · Repository 1 · com_ui_code_checkout_isolated'),
    ).toBeInTheDocument();
  });

  test.each(['source', 'isolated'] as const)(
    'materializes an explicit %s choice from a legacy automatic selection',
    async (checkout) => {
      const selected = { environmentId: environment.id, workspaceId: 'project-a' };
      const graph = workspace({
        environments: [
          {
            environment: {
              ...environment,
              configSchema: { workspaces: { allowCheckoutSelection: true } },
            },
            state: 'ready',
            workspaces: [{ id: 'project-a', workspaceInstances: ['git_worktree'] }],
            selected,
          },
        ],
      });
      const setConversation = jest.fn();
      renderMenu(
        <CodeWorkspaceMenu setConversation={setConversation} workspace={graph} disabled={false} />,
      );
      await userEvent.click(screen.getByTestId('code-workspace'));
      const isolated = screen.getByRole('menuitemradio', {
        name: /com_ui_code_checkout_isolated/,
      });
      const source = screen.getByRole('menuitemradio', { name: /com_ui_code_checkout_source/ });
      expect(isolated).toHaveAttribute('aria-checked', 'false');
      expect(source).toHaveAttribute('aria-checked', 'false');
      await userEvent.click(checkout === 'isolated' ? isolated : source);
      expect(setConversation.mock.calls[0][0](conversation)).toMatchObject({
        codeWorkspaces: [{ ...selected, checkout }],
      });
    },
  );

  test.each(['source', 'isolated'] as const)(
    'saves an explicit %s checkout choice before sending',
    async (checkout) => {
      const selected = { environmentId: environment.id, workspaceId: 'project-a' };
      const graph = workspace({
        environments: [
          {
            environment: {
              ...environment,
              configSchema: { workspaces: { allowCheckoutSelection: true } },
            },
            state: 'ready',
            workspaces: [{ id: 'project-a', workspaceInstances: ['git_worktree'] }],
            selected: { ...selected, checkout: checkout === 'source' ? 'isolated' : 'source' },
          },
        ],
      });
      const setConversation = jest.fn();
      renderMenu(
        <CodeWorkspaceMenu setConversation={setConversation} workspace={graph} disabled={false} />,
      );
      await userEvent.click(screen.getByTestId('code-workspace'));
      await userEvent.click(
        screen.getByRole('menuitemradio', {
          name: new RegExp(
            checkout === 'source' ? 'com_ui_code_checkout_source' : 'com_ui_code_checkout_isolated',
          ),
        }),
      );
      expect(setConversation.mock.calls[0][0](conversation)).toMatchObject({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [{ ...selected, checkout }],
      });
    },
  );

  test.each([
    { enabled: false, capable: true },
    { enabled: true, capable: false },
  ])('gates each checkout choice by policy and capability: %j', async ({ enabled, capable }) => {
    const graph = workspace();
    graph.environments[0].environment = {
      ...environment,
      configSchema: { workspaces: { allowCheckoutSelection: enabled } },
    };
    graph.environments[0].workspaces = [
      {
        id: 'project-a',
        ...(capable ? { workspaceInstances: ['git_worktree'] as ['git_worktree'] } : {}),
      },
    ];
    const setConversation = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu setConversation={setConversation} workspace={graph} disabled={false} />,
    );
    await userEvent.click(screen.getByTestId('code-workspace'));
    if (!enabled) {
      expect(screen.queryByText('com_ui_code_checkout_mode')).not.toBeInTheDocument();
    } else {
      expect(
        screen.queryByRole('menuitemradio', { name: /com_ui_code_checkout_isolated/ }),
      ).not.toBeInTheDocument();
      await userEvent.click(
        screen.getByRole('menuitemradio', { name: /com_ui_code_checkout_source/ }),
      );
      expect(setConversation.mock.calls[0][0](conversation)).toMatchObject({
        codeWorkspaces: [
          { environmentId: environment.id, workspaceId: 'project-a', checkout: 'source' },
        ],
      });
    }
  });

  test.each([false, true])(
    'keeps changing workspace requirements out of the composer layout (locked: %s)',
    (locked) => {
      const requiredBy = [
        { id: 'lia', name: 'Lia' },
        { id: 'reviewer', name: 'PR Reviewer' },
      ];
      const graph = workspace({ locked });
      const setter = jest.fn();
      const { rerenderMenu } = renderMenu(
        <CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />,
      );
      for (const state of ['loading', 'choose', 'unavailable', 'missing'] as const) {
        const pending = workspace({
          locked,
          state,
          canSubmit: false,
          environments: [{ environment, state, workspaces: [], requiredBy }],
        });
        rerenderMenu(
          <CodeWorkspaceMenu setConversation={setter} workspace={pending} disabled={false} />,
        );
        const button = screen.getByTestId(
          locked ? 'code-workspace-locked-status' : 'code-workspace',
        );
        const requirements = document.getElementById(button.getAttribute('aria-describedby')!);
        expect(requirements).toHaveClass('sr-only');
        expect(requirements).toHaveAttribute('role', 'status');
        expect(requirements).toHaveAttribute('aria-live', 'polite');
        expect(requirements).toHaveTextContent('Lia');
        expect(requirements).toHaveTextContent('PR Reviewer');
        expect(button.parentElement).not.toHaveClass('flex-col');
      }
      rerenderMenu(
        <CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />,
      );
      expect(screen.queryByText(/Every coding agent/)).not.toBeInTheDocument();
      expect(setter).not.toHaveBeenCalled();
    },
  );

  test('shows pending workspace requirements in the menu without a second live region', async () => {
    const graph = workspace({ state: 'loading', canSubmit: false });
    graph.environments[0] = {
      environment,
      state: 'loading',
      workspaces: [],
      requiredBy: [
        { id: 'lia', name: 'Lia' },
        { id: 'reviewer', name: 'PR Reviewer' },
      ],
    };
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
    );
    await userEvent.click(screen.getByTestId('code-workspace'));
    const detail = within(screen.getByRole('menu')).getByText(
      'Every coding agent in this chat needs a workspace, including subagents.',
    );
    expect(detail).toBeVisible();
    expect(detail.parentElement).not.toHaveClass('sr-only');
    expect(detail.parentElement).not.toHaveAttribute('aria-live');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  test('keeps multi-machine checkout summaries in the menu instead of extra composer rows', async () => {
    const graph = workspace();
    graph.environments[0].selected!.checkout = 'source';
    graph.environments.push({
      environment: { ...environment, id: 'reviewer-vm', name: 'Reviewer VM' },
      state: 'ready',
      workspaces: [{ id: 'review', name: 'Review' }],
      selected: { environmentId: 'reviewer-vm', workspaceId: 'review', checkout: 'isolated' },
    });
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
    );
    const summary = 'Reviewer VM · Review · com_ui_code_checkout_isolated';
    expect(screen.getByText(summary).parentElement).toHaveClass('sr-only');
    await userEvent.click(screen.getByTestId('code-workspace'));
    const detail = within(screen.getByRole('menu')).getByText(summary);
    expect(detail).toBeVisible();
    expect(detail.parentElement).not.toHaveClass('sr-only');
  });

  test('explains the missing reviewer workspace while the selected primary workspace is ready', async () => {
    const reviewerMachine = { ...environment, id: 'reviewer-vm', name: 'Danny Skynet Trusted VM' };
    const graph = workspace({ state: 'choose', canSubmit: false });
    graph.environments[0].requiredBy = [{ id: 'lia', name: 'Lia' }];
    graph.environments.push({
      environment: reviewerMachine,
      state: 'choose',
      workspaces: [{ id: 'review', name: 'Review' }],
      requiredBy: [{ id: 'reviewer', name: 'PR Reviewer' }],
    });
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Choose a workspace for PR Reviewer on Danny Skynet Trusted VM.',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Every coding agent in this chat needs a workspace, including subagents.',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('for Lia');
    await userEvent.click(screen.getByTestId('code-workspace'));
    expect(screen.getByText('Used by Lia')).toBeVisible();
    expect(screen.getByText('Used by PR Reviewer')).toBeVisible();
  });

  test('does not call an unavailable reviewer machine an unselected workspace', () => {
    const graph = workspace({ state: 'unavailable', canSubmit: false });
    graph.environments[0] = {
      ...graph.environments[0],
      state: 'unavailable',
      selected: undefined,
      requiredBy: [{ id: 'reviewer', name: 'PR Reviewer' }],
    };
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'PR Reviewer needs Personal VM: com_ui_code_workspace_unavailable',
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('Choose a workspace');
  });

  test('keeps a fixed graph machine when replacing an overlapping primary choice', async () => {
    const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
    const setter = jest.fn();
    const selection = { environmentId: alternate.id, workspaceId: 'runtime' };
    const graph = workspace({
      machineOptionGroups: [[environment.id, alternate.id]],
      fixedMachineIds: [alternate.id],
    });
    graph.environments.push({
      environment: alternate,
      state: 'ready',
      workspaces: [{ id: 'runtime', name: 'Runtime' }],
      selected: selection,
    });
    renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />);
    await userEvent.click(screen.getByTestId('code-workspace'));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Project A/ }));
    expect(
      setter.mock.calls[0][0]({ ...conversation, codeWorkspaces: [selection] }).codeWorkspaces,
    ).toEqual([{ environmentId: environment.id, workspaceId: 'project-a' }, selection]);
  });
  test('loads only a chosen allowed machine and replaces the draft selection', async () => {
    const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
    const read = jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockResolvedValue({
      environmentId: alternate.id,
      status: 'ready',
      operations: ['read_file'],
      workspaces: [{ id: 'runtime', name: 'Runtime Project' }],
    });
    const setter = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setter}
        workspace={workspace({
          machineOptions: [environment, alternate],
          machineOptionGroups: [[environment.id, alternate.id]],
        })}
        disabled={false}
      />,
    );
    expect(read).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('code-machine'));
    expect(read).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Runtime VM' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Runtime Project/ }));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(alternate.id);
    const next = setter.mock.calls[0][0]({
      ...conversation,
      codeWorkspaces: [{ environmentId: environment.id, workspaceId: 'project-a' }],
    });
    expect(next.codeWorkspaces).toEqual([{ environmentId: alternate.id, workspaceId: 'runtime' }]);
    read.mockRestore();
  });

  test('records primary ownership on B while retaining the fixed reviewer on A', async () => {
    const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
    const read = jest.spyOn(dataService, 'getCodeEnvironmentStatus').mockResolvedValue({
      environmentId: alternate.id,
      status: 'ready',
      operations: ['read_file'],
      workspaces: [{ id: 'runtime', name: 'Runtime Project' }],
    });
    const setter = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setter}
        workspace={workspace({
          machineOptions: [environment, alternate],
          machineOptionGroups: [[environment.id, alternate.id]],
          machineChoiceOwners: [{ agentId: 'lia', environmentIds: [environment.id, alternate.id] }],
          fixedMachineIds: [environment.id],
        })}
        disabled={false}
      />,
    );
    await userEvent.click(screen.getByTestId('code-machine'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Runtime VM' }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: /Runtime Project/ }));
    expect(
      setter.mock.calls[0][0]({
        ...conversation,
        codeWorkspaces: [
          { environmentId: environment.id, workspaceId: 'project-a', agentIds: ['lia'] },
        ],
      }).codeWorkspaces,
    ).toEqual([
      { environmentId: environment.id, workspaceId: 'project-a' },
      { environmentId: alternate.id, workspaceId: 'runtime', agentIds: ['lia'] },
    ]);
    read.mockRestore();
  });

  test('editing a child workspace preserves the primary agent machine choice', async () => {
    const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
    const child = { ...environment, id: 'child-vm', name: 'Child VM' };
    const setter = jest.fn();
    const rootSelection = { environmentId: environment.id, workspaceId: 'project-a' };
    const childSelection = { environmentId: child.id, workspaceId: 'old' };
    const graph = workspace({
      machineOptions: [environment, alternate],
      machineOptionGroups: [[environment.id, alternate.id]],
      selections: [rootSelection, childSelection],
    });
    graph.environments.push({
      environment: child,
      state: 'ready',
      selected: childSelection,
      workspaces: [
        { id: 'old', name: 'Old' },
        { id: 'new', name: 'Child Project' },
      ],
    });
    renderMenu(<CodeWorkspaceMenu setConversation={setter} workspace={graph} disabled={false} />);
    await userEvent.click(screen.getByTestId('code-workspace'));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Child Project/ }));
    const next = setter.mock.calls[0][0]({
      ...conversation,
      codeWorkspaces: [rootSelection, childSelection],
    });
    expect(next.codeWorkspaces).toEqual([
      { environmentId: child.id, workspaceId: 'new' },
      rootSelection,
    ]);
  });

  test('offers a sole allowed alternative when the original default is no longer accessible', async () => {
    const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={jest.fn()}
        workspace={workspace({
          state: 'unavailable',
          environments: [],
          machineOptions: [alternate],
        })}
        disabled={false}
      />,
    );
    await userEvent.click(screen.getByTestId('code-machine'));
    expect(screen.getByRole('menuitem', { name: 'Runtime VM' })).toBeVisible();
  });

  test('offers retry for an offline alternative without losing the current workspace', async () => {
    const alternate = { ...environment, id: 'runtime-vm', name: 'Runtime VM' };
    const read = jest
      .spyOn(dataService, 'getCodeEnvironmentStatus')
      .mockResolvedValueOnce({ environmentId: alternate.id, status: 'offline' })
      .mockResolvedValue({
        environmentId: alternate.id,
        status: 'ready',
        operations: ['read_file'],
        workspaces: [{ id: 'runtime', name: 'Runtime Project' }],
      });
    const setter = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setter}
        workspace={workspace({ machineOptions: [environment, alternate] })}
        disabled={false}
      />,
    );
    await userEvent.click(screen.getByTestId('code-machine'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Runtime VM' }));
    const retry = await screen.findByRole('menuitem', {
      name: 'com_ui_code_workspace_unavailable',
    });
    expect(setter).not.toHaveBeenCalled();
    await userEvent.click(retry);
    expect(await screen.findByRole('menuitemradio', { name: /Runtime Project/ })).toBeVisible();
    expect(read).toHaveBeenCalledTimes(2);
    read.mockRestore();
  });
  test('explains a failed reconciliation and retries without permitting workspace changes', async () => {
    const store = createStore();
    const request = {
      conversationId: 'existing',
      attempted: {
        codeEnvironmentMode: 'attached' as const,
        codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
      },
    };
    store.set(
      codeEnvironmentReconciliationsAtom,
      new Map([['existing', { request, status: 'error', token: Symbol() }]]),
    );
    let resolveRead!: (value: TConversation) => void;
    const read = jest.spyOn(dataService, 'getConversationById').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    const setter = jest.fn();
    function RecoveryMenu() {
      const recovery = useConversationCodeEnvironmentRecovery('existing');
      return (
        <CodeWorkspaceMenu
          setConversation={setter}
          workspace={workspace({ visible: recovery != null, recovery })}
          disabled={false}
        />
      );
    }
    renderMenu(
      <Provider store={store}>
        <RecoveryMenu />
      </Provider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_code_workspace_reconcile_failed');
    expect(screen.queryByTestId('code-workspace')).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'com_ui_code_workspace_reconcile_retry' }),
    );
    await waitFor(() => expect(read).toHaveBeenCalledWith('existing'));
    expect(
      screen.getByRole('button', { name: 'com_ui_code_workspace_reconcile_retry' }),
    ).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_code_workspace_reconciling');
    resolveRead({
      ...conversation,
      conversationId: 'existing',
      codeEnvironmentMode: 'without_attached',
    });
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(setter).toHaveBeenCalledTimes(1);
    read.mockRestore();
  });

  test('shows loading rather than the inferred no-workspace fallback on first load', () => {
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={jest.fn()}
        workspace={workspace({
          mode: 'without_attached',
          state: 'loading',
          selections: undefined,
          environments: [{ environment, state: 'loading', workspaces: [] }],
        })}
        disabled={false}
      />,
    );
    expect(screen.getByTestId('code-workspace')).toHaveTextContent('com_ui_code_workspace_loading');
  });

  test('can retry a locked unavailable workspace without changing its saved decision', async () => {
    const invalidate = jest.spyOn(QueryClient.prototype, 'invalidateQueries');
    const setConversation = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setConversation}
        workspace={workspace({ locked: true, state: 'unavailable', canSubmit: false })}
        disabled={false}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /com_ui_retry/ }));
    expect(invalidate).toHaveBeenCalled();
    expect(setConversation).not.toHaveBeenCalled();
  });

  test('shows the instruction file and truncation reported by the worker', async () => {
    const state = workspace();
    state.environments[0].workspaces[0].instructions = [
      { path: 'AGENTS.md', bytes: 32768, sha256: 'a'.repeat(64), truncated: true },
    ];
    renderMenu(
      <CodeWorkspaceMenu setConversation={jest.fn()} workspace={state} disabled={false} />,
    );
    await userEvent.click(screen.getByTestId('code-workspace'));
    expect(
      await screen.findByText('AGENTS.md · 32.0 KB · com_ui_repository_instructions_truncated'),
    ).toBeInTheDocument();
  });
  test.each([
    ['example/app', 'example/app · dev'],
    [undefined, 'dev'],
  ])('shows project metadata without changing selection (%s)', async (repo, label) => {
    const state = workspace();
    state.environments[0].workspaces[0].environment = {
      fingerprint: 'a'.repeat(64),
      repo,
      ref: 'dev',
      actions: ['typecheck'],
    };
    const setConversation = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu setConversation={setConversation} workspace={state} disabled={false} />,
    );
    await userEvent.click(screen.getByTestId('code-workspace'));
    expect((await screen.findAllByText(label!)).length).toBeGreaterThan(0);
    expect(setConversation).not.toHaveBeenCalled();
  });
  test('shows a suggested workspace without committing the conversation decision', () => {
    const setConversation = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setConversation}
        workspace={workspace()}
        disabled={false}
      />,
    );

    expect(setConversation).not.toHaveBeenCalled();
    expect(screen.getByTestId('code-workspace')).toHaveTextContent('Project A');
  });

  test('allows working without an attached workspace even while the worker is unavailable', async () => {
    const setConversation = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setConversation}
        workspace={workspace({
          mode: undefined,
          state: 'unavailable',
          selections: undefined,
          environments: [
            {
              environment,
              state: 'unavailable',
              workspaces: [],
              selected: undefined,
            },
          ],
        })}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByTestId('code-workspace'));
    await userEvent.click(await screen.findByText('com_ui_code_workspace_without_attached'));

    const update = setConversation.mock.calls[0][0];
    expect(update(conversation)).toEqual({
      ...conversation,
      codeEnvironmentMode: 'without_attached',
      codeWorkspaces: undefined,
    });
  });

  test('does not offer selection-less decisions before the API advertises support', async () => {
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={jest.fn()}
        workspace={workspace({ supportsEnvironmentDecisions: false })}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByTestId('code-workspace'));

    expect(
      screen.queryByRole('menuitemradio', { name: /com_ui_code_workspace_without_attached/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Project A/ })).toBeInTheDocument();
  });

  test('commits an explicit attached-workspace choice only when the user selects it', async () => {
    const setConversation = jest.fn();
    const rememberSelection = jest.fn();
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={setConversation}
        workspace={workspace({ mode: undefined, state: 'choose', rememberSelection })}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByTestId('code-workspace'));
    await userEvent.click((await screen.findAllByText('Project A'))[1]);

    expect(rememberSelection).toHaveBeenCalledWith({
      environmentId: 'personal-vm',
      workspaceId: 'project-a',
    });
    const update = setConversation.mock.calls[0][0];
    expect(update(conversation)).toEqual({
      ...conversation,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
    });
  });

  test('does not mark a suggested workspace selected in no-attached mode', async () => {
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={jest.fn()}
        workspace={workspace({ mode: 'without_attached', state: 'without_attached' })}
        disabled={false}
      />,
    );

    await userEvent.click(screen.getByTestId('code-workspace'));

    expect(
      screen.getByRole('menuitemradio', { name: /com_ui_code_workspace_without_attached/ }),
    ).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: /Project A/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  test('hides the chooser after the conversation decision is locked', () => {
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={jest.fn()}
        workspace={workspace({ locked: true, visible: false })}
        disabled={false}
      />,
    );

    expect(screen.queryByTestId('code-workspace')).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-workspace-locked-status')).not.toBeInTheDocument();
  });

  test('shows recovery status when a locked workspace is unavailable', () => {
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={jest.fn()}
        workspace={workspace({
          locked: true,
          canSubmit: false,
          state: 'unavailable',
          selections: undefined,
          environments: [
            { environment, state: 'unavailable', workspaces: [], selected: undefined },
          ],
        })}
        disabled={false}
      />,
    );

    expect(screen.getByTestId('code-workspace-locked-status')).toHaveAccessibleName(
      'com_ui_code_workspace_unavailable. com_ui_code_workspace_locked_recovery. com_ui_retry',
    );
  });

  test('explains a chat that recorded running without a workspace and cannot attach one', () => {
    renderMenu(
      <CodeWorkspaceMenu
        setConversation={jest.fn()}
        workspace={workspace({
          locked: true,
          mode: 'without_attached',
          state: 'without_attached',
          selections: undefined,
        })}
        disabled={false}
      />,
    );

    expect(screen.getByTestId('code-workspace-locked-status')).toHaveAccessibleName(
      'com_ui_code_workspace_without_attached. com_ui_code_workspace_without_attached_info. com_ui_retry',
    );
  });

  describe('a saved chat that has been running without a workspace', () => {
    const attached = { environmentId: environment.id, workspaceId: 'project-a' };
    const sealed = { ...conversation, conversationId: 'existing' } as TConversation;
    const attachable = (rememberSelection = jest.fn()) =>
      workspace({
        locked: true,
        mode: 'without_attached',
        state: 'without_attached',
        selections: undefined,
        rememberSelection,
        environments: [
          {
            environment,
            state: 'choose',
            workspaces: [{ id: 'project-a', name: 'Project A' }],
            selected: undefined,
          },
        ],
        transition: {
          kind: 'attach',
          conversationId: 'existing',
          from: [],
          previous: [],
          retained: [],
          detachable: false,
          targets: [
            {
              environment,
              state: 'choose',
              workspaces: [{ id: 'project-a', name: 'Project A' }],
              selected: undefined,
            },
          ],
        },
      });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('attaches a workspace while still naming where the chat runs', async () => {
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockResolvedValue({
        conversationId: 'existing',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [attached],
      });
      const setConversation = jest.fn();
      const rememberSelection = jest.fn();
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={setConversation}
          workspace={attachable(rememberSelection)}
          disabled={false}
        />,
      );

      /** The control keeps reading "no attached workspace"; attaching one is what it offers. */
      const chip = screen.getByTestId('code-workspace');
      expect(chip).toHaveTextContent('com_ui_code_workspace_without_attached');
      await userEvent.click(chip);
      expect(screen.getByText('com_ui_code_workspace_attach_info')).toBeInTheDocument();
      expect(
        screen.queryByRole('menuitem', { name: /com_ui_code_workspace_detach/ }),
      ).not.toBeInTheDocument();
      await userEvent.click(
        await screen.findByRole('menuitem', { name: /com_ui_code_workspace_attach/ }),
      );

      await waitFor(() => expect(moveSpy).toHaveBeenCalledTimes(1));
      expect(moveSpy).toHaveBeenCalledWith({
        conversationId: 'existing',
        from: [],
        to: [attached],
      });
      expect(rememberSelection).toHaveBeenCalledWith(attached);
      const update = setConversation.mock.calls[0][0];
      expect(update(sealed)).toEqual({
        ...sealed,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [attached],
      });
    });
  });

  describe('a chat leaving its sealed workspace decision', () => {
    const mac = { environmentId: 'mac', workspaceId: 'primary' };
    const sealed = { ...conversation, conversationId: 'existing' } as TConversation;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test.each<[string, CodeWorkspaceResult['state'], CodeWorkspaceResult['environments']]>([
      [
        'offline',
        'unavailable',
        [{ environment, state: 'unavailable', workspaces: [], selected: undefined }],
      ],
      ['no-longer-used', 'not_required', []],
      [
        'healthy',
        'ready',
        [
          {
            environment: { ...environment, id: 'mac' },
            state: 'ready',
            workspaces: [{ id: 'primary' }],
            selected: mac,
          },
        ],
      ],
    ])('continues without the %s workspace', async (scenario, state, environments) => {
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockResolvedValue({
        conversationId: 'existing',
        codeEnvironmentMode: 'without_attached',
      });
      const setConversation = jest.fn();
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={setConversation}
          workspace={workspace({
            locked: true,
            required: scenario !== 'no-longer-used',
            canSubmit: scenario !== 'offline',
            state,
            selections: undefined,
            environments,
            transition: {
              kind: scenario === 'healthy' ? 'detach' : 'move',
              conversationId: 'existing',
              from: [mac],
              previous: scenario === 'no-longer-used' ? [{ id: 'mac', name: 'Danny Mac' }] : [],
              retained: scenario === 'healthy' ? [mac] : [],
              targets: [],
              detachable: true,
            },
          })}
          disabled={false}
        />,
      );

      await userEvent.click(screen.getByTestId('code-workspace'));
      /** Detach is explicit; it must not offer a redundant move to the same workspace. */
      expect(
        screen.queryByRole('menuitem', { name: /com_ui_code_workspace_move/ }),
      ).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('code-workspace-detach'));

      await waitFor(() => expect(moveSpy).toHaveBeenCalledTimes(1));
      expect(moveSpy).toHaveBeenCalledWith({ conversationId: 'existing', from: [mac], to: [] });
      const update = setConversation.mock.calls[0][0];
      expect(update(sealed)).toEqual({
        ...sealed,
        codeEnvironmentMode: 'without_attached',
        codeWorkspaces: undefined,
      });
    });
  });

  describe('a chat sealed to a machine its agent no longer uses', () => {
    const mac = { environmentId: 'mac', workspaceId: 'primary' };
    const moved = { environmentId: environment.id, workspaceId: 'project-a' };
    const sealed = { ...conversation, conversationId: 'existing' } as TConversation;
    const teamVm = {
      id: 'team-vm',
      name: 'Team VM',
      type: 'attached' as const,
      baseURL: 'https://team.example.com',
    };

    type Target = NonNullable<CodeWorkspaceResult['transition']>['targets'][number];
    const target = (
      targetEnvironment: Target['environment'],
      workspaces: Target['workspaces'],
    ): Target => ({
      environment: targetEnvironment,
      state: 'choose',
      workspaces,
      selected: undefined,
    });

    const relocatable = (targets: Target[], rememberSelection = jest.fn()) =>
      workspace({
        locked: true,
        canSubmit: false,
        state: 'relocatable',
        selections: undefined,
        rememberSelection,
        environments: targets,
        transition: {
          kind: 'move',
          conversationId: 'existing',
          from: [mac],
          previous: [{ id: 'mac', name: 'Danny Mac' }],
          retained: [],
          targets,
          detachable: true,
        },
      });

    const confirmItem = () => screen.findByRole('menuitem', { name: /com_ui_code_workspace_move/ });

    beforeEach(() => {
      mockShowToast.mockReset();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test.each(['source', 'isolated'] as const)(
      'chooses an explicit %s checkout during attachment',
      async (checkout) => {
        const selectedTarget = target(
          { ...environment, configSchema: { workspaces: { allowCheckoutSelection: true } } },
          [{ id: 'project-a', workspaceInstances: ['git_worktree'] }],
        );
        const graph = relocatable([selectedTarget]);
        graph.transition = { ...graph.transition!, kind: 'attach', from: [], previous: [] };
        const moveSpy = jest
          .spyOn(dataService, 'moveConversationCodeEnvironment')
          .mockResolvedValue({
            conversationId: 'existing',
            codeEnvironmentMode: 'attached',
            codeWorkspaces: [{ ...moved, checkout }],
          });
        renderMenu(
          <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
        );
        await userEvent.click(screen.getByTestId('code-workspace'));
        await userEvent.click(
          screen.getByRole('menuitemradio', {
            name: new RegExp(
              checkout === 'source'
                ? 'com_ui_code_checkout_source'
                : 'com_ui_code_checkout_isolated',
            ),
          }),
        );
        await userEvent.click(
          screen.getByRole('menuitem', { name: /com_ui_code_workspace_attach/ }),
        );
        await waitFor(() =>
          expect(moveSpy).toHaveBeenCalledWith({
            conversationId: 'existing',
            from: [],
            to: [{ ...moved, checkout }],
          }),
        );
      },
    );

    test.each(['unsupported isolation', 'mixed predecessors'] as const)(
      'requires an explicit source choice for %s',
      async (scenario) => {
        const graph = relocatable([
          target(
            { ...environment, configSchema: { workspaces: { allowCheckoutSelection: true } } },
            [{ id: 'project-a' }],
          ),
        ]);
        graph.transition = {
          ...graph.transition!,
          from:
            scenario === 'unsupported isolation'
              ? [{ ...mac, checkout: 'isolated' }]
              : [
                  { ...mac, checkout: 'isolated' },
                  { environmentId: 'other-vm', workspaceId: 'repo', checkout: 'source' },
                ],
        };
        const moveSpy = jest
          .spyOn(dataService, 'moveConversationCodeEnvironment')
          .mockResolvedValue({
            conversationId: 'existing',
            codeEnvironmentMode: 'attached',
            codeWorkspaces: [{ ...moved, checkout: 'source' }],
          });
        renderMenu(
          <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
        );
        await userEvent.click(screen.getByTestId('code-workspace-move'));
        expect(await confirmItem()).toHaveAttribute('aria-disabled', 'true');
        expect(moveSpy).not.toHaveBeenCalled();
        await userEvent.click(
          screen.getByRole('menuitemradio', { name: /com_ui_code_checkout_source/ }),
        );
        await userEvent.click(await confirmItem());
        await waitFor(() =>
          expect(moveSpy).toHaveBeenCalledWith(
            expect.objectContaining({ to: [{ ...moved, checkout: 'source' }] }),
          ),
        );
      },
    );

    test('preserves registered checkout when recovering onto a replacement workspace', async () => {
      const graph = relocatable([
        target({ ...environment, configSchema: { workspaces: { allowCheckoutSelection: true } } }, [
          { id: 'project-a', workspaceInstances: ['git_worktree'] },
        ]),
      ]);
      const old = {
        environmentId: environment.id,
        workspaceId: 'deleted',
        checkout: 'source' as const,
      };
      graph.transition = { ...graph.transition!, from: [old] };
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockResolvedValue({
        conversationId: 'existing',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [{ ...moved, checkout: 'source' }],
      });
      renderMenu(
        <CodeWorkspaceMenu setConversation={jest.fn()} workspace={graph} disabled={false} />,
      );
      await userEvent.click(screen.getByTestId('code-workspace-move'));
      expect(
        screen.getByRole('menuitemradio', { name: /com_ui_code_checkout_source/ }),
      ).toHaveAttribute('aria-checked', 'true');
      await userEvent.click(await confirmItem());
      await waitFor(() =>
        expect(moveSpy).toHaveBeenCalledWith({
          conversationId: 'existing',
          from: [old],
          to: [{ ...moved, checkout: 'source' }],
        }),
      );
    });

    test('recovers in the same chat only after confirmation, preserving healthy environments', async () => {
      const missing = { ...moved, workspaceId: 'deleted-project' };
      const kept = { environmentId: 'team-vm', workspaceId: 'shared' };
      const replacement = { ...moved, workspaceId: 'project-b' };
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockResolvedValue({
        conversationId: 'existing',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [replacement, kept],
      });
      const setConversation = jest.fn();
      const rememberSelection = jest.fn();
      const base = relocatable(
        [
          {
            ...target(environment, [
              { id: 'project-a', name: 'Project A' },
              { id: 'project-b', name: 'Project B' },
            ]),
            state: 'missing',
          },
        ],
        rememberSelection,
      );
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={setConversation}
          workspace={{
            ...base,
            transition: {
              ...base.transition!,
              from: [missing, kept],
              previous: [],
              retained: [kept],
            },
          }}
          disabled={false}
        />,
      );

      expect(screen.getByTestId('code-workspace-move')).toHaveAccessibleName(
        'com_ui_code_workspace_recover. com_ui_code_workspace_recover_info',
      );
      await userEvent.click(screen.getByTestId('code-workspace-move'));
      const confirm = await screen.findByRole('menuitem', {
        name: 'com_ui_code_workspace_recover',
      });
      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(screen.getByRole('menuitemradio', { name: /Project B/ }));
      expect(moveSpy).not.toHaveBeenCalled();
      expect(setConversation).not.toHaveBeenCalled();
      expect(rememberSelection).not.toHaveBeenCalled();
      await userEvent.keyboard('{Escape}');
      await waitFor(() =>
        expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument(),
      );
      expect(moveSpy).not.toHaveBeenCalled();
      await userEvent.click(screen.getByTestId('code-workspace-move'));
      await userEvent.click(
        await screen.findByRole('menuitem', { name: 'com_ui_code_workspace_recover' }),
      );

      await waitFor(() => expect(setConversation).toHaveBeenCalledTimes(1));
      expect(moveSpy).toHaveBeenCalledWith({
        conversationId: 'existing',
        from: [missing, kept],
        to: [kept, replacement],
      });
      expect(rememberSelection).toHaveBeenCalledWith(replacement);
      const current = { ...sealed, codeWorkspaces: [missing, kept] };
      expect(setConversation.mock.calls[0][0](current)).toEqual({
        ...current,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [replacement, kept],
      });
    });

    test('keeps a failed recovery retryable without changing the chat or preferences', async () => {
      const missing = { ...moved, workspaceId: 'deleted-project' };
      const moveSpy = jest
        .spyOn(dataService, 'moveConversationCodeEnvironment')
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce({
          conversationId: 'existing',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [moved],
        });
      const setConversation = jest.fn();
      const rememberSelection = jest.fn();
      const base = relocatable(
        [{ ...target(environment, [{ id: 'project-a' }]), state: 'missing' }],
        rememberSelection,
      );
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={setConversation}
          workspace={{
            ...base,
            transition: { ...base.transition!, from: [missing], previous: [] },
          }}
          disabled={false}
        />,
      );
      await userEvent.click(screen.getByTestId('code-workspace-move'));
      await userEvent.click(
        await screen.findByRole('menuitem', { name: 'com_ui_code_workspace_recover' }),
      );
      await waitFor(() =>
        expect(mockShowToast).toHaveBeenCalledWith({
          message: 'com_ui_code_workspace_move_error',
          status: 'error',
        }),
      );
      expect(setConversation).not.toHaveBeenCalled();
      expect(rememberSelection).not.toHaveBeenCalled();

      await userEvent.click(screen.getByTestId('code-workspace-move'));
      await userEvent.click(
        await screen.findByRole('menuitem', { name: 'com_ui_code_workspace_recover' }),
      );
      await waitFor(() => expect(setConversation).toHaveBeenCalledTimes(1));
      expect(moveSpy).toHaveBeenCalledTimes(2);
      expect(rememberSelection).toHaveBeenCalledTimes(1);
    });

    test('disables recovery while its request is pending and applies only the acknowledged result', async () => {
      const missing = { ...moved, workspaceId: 'deleted-project' };
      let finish: (() => void) | undefined;
      jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                conversationId: 'existing',
                codeEnvironmentMode: 'attached',
                codeWorkspaces: [moved],
              });
          }),
      );
      const setConversation = jest.fn();
      const base = relocatable([
        { ...target(environment, [{ id: 'project-a' }]), state: 'missing' },
      ]);
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={setConversation}
          workspace={{
            ...base,
            transition: { ...base.transition!, from: [missing], previous: [] },
          }}
          disabled={false}
        />,
      );
      await userEvent.click(screen.getByTestId('code-workspace-move'));
      await userEvent.click(
        await screen.findByRole('menuitem', { name: 'com_ui_code_workspace_recover' }),
      );
      await waitFor(() => expect(screen.getByTestId('code-workspace-move')).toBeDisabled());
      expect(setConversation).not.toHaveBeenCalled();
      finish?.();
      await waitFor(() => expect(setConversation).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId('code-workspace-move')).not.toBeDisabled();
    });

    test('prevents confirmation if a generation starts while the recovery menu is open', async () => {
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment');
      const base = relocatable([
        { ...target(environment, [{ id: 'project-a' }]), state: 'missing' },
      ]);
      const state = {
        ...base,
        transition: {
          ...base.transition!,
          from: [{ ...moved, workspaceId: 'deleted-project' }],
          previous: [],
        },
      };
      const { rerenderMenu } = renderMenu(
        <CodeWorkspaceMenu setConversation={jest.fn()} workspace={state} disabled={false} />,
      );
      await userEvent.click(screen.getByTestId('code-workspace-move'));
      rerenderMenu(
        <CodeWorkspaceMenu setConversation={jest.fn()} workspace={state} disabled={true} />,
      );
      const confirm = await screen.findByRole('menuitem', {
        name: 'com_ui_code_workspace_recover',
      });
      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      await userEvent.setup({ pointerEventsCheck: 0 }).click(confirm);
      expect(moveSpy).not.toHaveBeenCalled();
    });

    test('moves the chat onto the sole workspace its agent now uses', async () => {
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockResolvedValue({
        conversationId: 'existing',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [moved],
      });
      const setConversation = jest.fn();
      const rememberSelection = jest.fn();
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={setConversation}
          workspace={relocatable(
            [target(environment, [{ id: 'project-a', name: 'Project A' }])],
            rememberSelection,
          )}
          disabled={false}
        />,
      );

      expect(screen.queryByTestId('code-workspace-locked-status')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('code-workspace-move'));
      expect(screen.getByRole('menuitemradio', { name: /Project A/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await userEvent.click(await confirmItem());

      await waitFor(() => expect(setConversation).toHaveBeenCalledTimes(1));
      expect(moveSpy).toHaveBeenCalledTimes(1);
      expect(moveSpy).toHaveBeenCalledWith({
        conversationId: 'existing',
        from: [mac],
        to: [moved],
      });
      expect(rememberSelection).toHaveBeenCalledWith(moved);
      const update = setConversation.mock.calls[0][0];
      expect(update(sealed)).toEqual({
        ...sealed,
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [moved],
      });
      expect(update(conversation)).toBe(conversation);
      expect(mockShowToast).not.toHaveBeenCalled();
    });

    test('moves every new environment in one request once each has a workspace', async () => {
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockResolvedValue({
        conversationId: 'existing',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [],
      });
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={jest.fn()}
          workspace={relocatable([
            target(environment, [{ id: 'project-a', name: 'Project A' }]),
            target(teamVm, [
              { id: 'shared', name: 'Shared' },
              { id: 'scratch', name: 'Scratch' },
            ]),
          ])}
          disabled={false}
        />,
      );

      await userEvent.click(screen.getByTestId('code-workspace-move'));
      expect(await confirmItem()).toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(screen.getByRole('menuitemradio', { name: /Scratch/ }));
      await userEvent.click(await confirmItem());

      await waitFor(() => expect(moveSpy).toHaveBeenCalledTimes(1));
      expect(moveSpy).toHaveBeenCalledWith({
        conversationId: 'existing',
        from: [mac],
        to: [moved, { environmentId: 'team-vm', workspaceId: 'scratch' }],
      });
    });

    test('starts another relocatable chat undecided even when it targets the same machine', async () => {
      const targets = [
        target(teamVm, [
          { id: 'shared', name: 'Shared' },
          { id: 'scratch', name: 'Scratch' },
        ]),
      ];
      const firstChat = relocatable(targets);
      const { rerenderMenu } = renderMenu(
        <CodeWorkspaceMenu setConversation={jest.fn()} workspace={firstChat} disabled={false} />,
      );

      await userEvent.click(screen.getByTestId('code-workspace-move'));
      await userEvent.click(screen.getByRole('menuitemradio', { name: /Scratch/ }));
      expect(await confirmItem()).not.toHaveAttribute('aria-disabled', 'true');

      rerenderMenu(
        <CodeWorkspaceMenu
          setConversation={jest.fn()}
          workspace={{
            ...firstChat,
            transition: { ...firstChat.transition!, conversationId: 'another-chat' },
          }}
          disabled={false}
        />,
      );

      expect(screen.getByRole('menuitemradio', { name: /Scratch/ })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      expect(await confirmItem()).toHaveAttribute('aria-disabled', 'true');
    });

    test('drops a machine the agents stopped using with a single confirm', async () => {
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockResolvedValue({
        conversationId: 'existing',
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [moved],
      });
      const setConversation = jest.fn();
      const base = relocatable([]);
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={setConversation}
          workspace={{
            ...base,
            transition: {
              ...base.transition!,
              from: [mac, moved],
              previous: [{ id: 'mac', name: 'Danny Mac' }],
              retained: [moved],
            },
          }}
          disabled={false}
        />,
      );

      await userEvent.click(screen.getByTestId('code-workspace-move'));
      expect(screen.getByText('com_ui_code_workspace_move_info_removed')).toBeInTheDocument();
      await userEvent.click(await confirmItem());

      await waitFor(() => expect(setConversation).toHaveBeenCalledTimes(1));
      expect(moveSpy).toHaveBeenCalledWith({
        conversationId: 'existing',
        from: [mac, moved],
        to: [moved],
      });
    });

    test('explains a new machine that advertises no workspace and cannot be moved to', async () => {
      const moveSpy = jest.spyOn(dataService, 'moveConversationCodeEnvironment');
      renderMenu(
        <CodeWorkspaceMenu
          setConversation={jest.fn()}
          workspace={relocatable([target(environment, [])])}
          disabled={false}
        />,
      );

      await userEvent.click(screen.getByTestId('code-workspace-move'));

      expect(screen.getByText('com_ui_code_workspace_unavailable')).toBeInTheDocument();
      const confirm = await confirmItem();
      expect(confirm).toHaveAttribute('aria-disabled', 'true');
      await userEvent.setup({ pointerEventsCheck: 0 }).click(confirm);
      expect(moveSpy).not.toHaveBeenCalled();
    });

    test.each([
      {
        name: 'the new machine rejected the workspace',
        data: { reason: 'missing' },
        key: 'com_error_code_workspace_missing',
      },
      {
        name: 'the decision changed elsewhere first',
        data: { reason: 'locked' },
        key: 'com_ui_code_workspace_move_stale',
      },
      {
        name: 'a response is still generating',
        data: { error: 'busy' },
        key: 'com_ui_code_workspace_move_busy',
      },
    ])(
      'explains a refused move when $name and reconciles only stale decisions',
      async ({ data, key }) => {
        jest.spyOn(dataService, 'moveConversationCodeEnvironment').mockRejectedValue(
          new AxiosError('Conflict', 'ERR_BAD_REQUEST', undefined, undefined, {
            status: 409,
            data,
          } as AxiosResponse),
        );
        const persisted = { ...sealed, codeEnvironmentMode: 'without_attached' } as TConversation;
        const read = jest.spyOn(dataService, 'getConversationById').mockResolvedValue(persisted);
        const setConversation = jest.fn();
        renderMenu(
          <CodeWorkspaceMenu
            setConversation={setConversation}
            workspace={relocatable([target(environment, [{ id: 'project-a', name: 'Project A' }])])}
            disabled={false}
          />,
        );

        await userEvent.click(screen.getByTestId('code-workspace-move'));
        await userEvent.click(await confirmItem());

        await waitFor(() =>
          expect(mockShowToast).toHaveBeenCalledWith({ message: key, status: 'error' }),
        );
        if (data.reason === 'locked') {
          expect(read).toHaveBeenCalledWith('existing');
          const update = setConversation.mock.calls[0][0];
          expect(
            update({ ...sealed, codeEnvironmentMode: 'attached', codeWorkspaces: [mac] }),
          ).toEqual(persisted);
        } else {
          expect(read).not.toHaveBeenCalled();
          expect(setConversation).not.toHaveBeenCalled();
        }
      },
    );
  });
});
