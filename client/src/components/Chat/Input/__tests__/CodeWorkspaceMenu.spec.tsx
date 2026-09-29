import { AxiosError } from 'axios';
import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { dataService } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
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
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => {
  const { cloneElement } = jest.requireActual('react');
  return {
    composerControlClasses: () => 'composer-control',
    useToastContext: () => ({ showToast: mockShowToast }),
    TooltipAnchor: ({
      render,
      children,
    }: {
      render: React.ReactElement;
      children: React.ReactNode;
    }) => cloneElement(render, {}, children),
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
    expect(await screen.findByText(label!)).toBeInTheDocument();
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

  describe('a chat sealed to a machine it can no longer reach', () => {
    const mac = { environmentId: 'mac', workspaceId: 'primary' };
    const sealed = { ...conversation, conversationId: 'existing' } as TConversation;

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test.each(['offline', 'no-longer-used'])(
      'continues without the %s workspace',
      async (scenario) => {
        const moveSpy = jest
          .spyOn(dataService, 'moveConversationCodeEnvironment')
          .mockResolvedValue({
            conversationId: 'existing',
            codeEnvironmentMode: 'without_attached',
          });
        const setConversation = jest.fn();
        renderMenu(
          <CodeWorkspaceMenu
            setConversation={setConversation}
            workspace={workspace({
              locked: true,
              required: scenario === 'offline',
              canSubmit: scenario !== 'offline',
              state: scenario === 'offline' ? 'unavailable' : 'not_required',
              selections: undefined,
              environments:
                scenario === 'offline'
                  ? [{ environment, state: 'unavailable', workspaces: [], selected: undefined }]
                  : [],
              transition: {
                kind: 'move',
                conversationId: 'existing',
                from: [mac],
                previous: scenario === 'offline' ? [] : [{ id: 'mac', name: 'Danny Mac' }],
                retained: [],
                targets: [],
                detachable: true,
              },
            })}
            disabled={false}
          />,
        );

        await userEvent.click(screen.getByTestId('code-workspace'));
        /** Nothing to move onto, so the only decision left is to stop waiting for the machine. */
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
      },
    );
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
