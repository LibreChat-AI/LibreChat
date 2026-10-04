import { renderHook } from '@testing-library/react';
import { EModelEndpoint, Tools } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import { withSubmittedCodeDecision } from '../codeDecision';
import useCodeWorkspace from '../useCodeWorkspace';

const mockAgentPermissions = jest.fn();
const mockAgentsConfig = jest.fn();
const mockStatus = jest.fn();
const mockReplacingDecision = jest.fn();
const mockRecovery = jest.fn();
const mockStartupConfig = jest.fn();
const mockAgentsMap = jest.fn();
const mockAccess = jest.fn();
const mockPreference = jest.fn();
const mockRememberPreference = jest.fn();
jest.mock('../workspacePreferences', () => ({
  useWorkspacePreferences: () => ({ get: mockPreference, remember: mockRememberPreference }),
}));
jest.mock('~/hooks/Roles/useHasAccess', () => () => mockAccess());

jest.mock(
  '../useAgentToolPermissions',
  () =>
    (...args: unknown[]) =>
      mockAgentPermissions(...args),
);
jest.mock('../useGetAgentsConfig', () => () => mockAgentsConfig());
jest.mock('~/Providers', () => ({ useAgentsMapContext: () => mockAgentsMap() }));
jest.mock('~/data-provider', () => ({
  useCodeEnvironmentStatusQueries: (...args: unknown[]) => mockStatus(...args),
  useGetStartupConfig: () => ({ data: mockStartupConfig() }),
  useIsReplacingConversationCodeEnvironment: () => mockReplacingDecision(),
  useConversationCodeEnvironmentRecovery: () => mockRecovery(),
}));

const conversation = (codeWorkspaces?: TConversation['codeWorkspaces']): TConversation =>
  ({
    conversationId: 'new',
    endpoint: EModelEndpoint.agents,
    agent_id: 'agent_primary',
    codeWorkspaces,
  }) as TConversation;

describe('useCodeWorkspace', () => {
  it.each([
    { enabled: false, capable: true },
    { enabled: true, capable: false },
  ])('blocks a restored isolation choice when support disappears: %j', ({ enabled, capable }) => {
    mockAgentsConfig().agentsConfig.statefulCodeSessions.environments[0].configSchema = {
      workspaces: { allowCheckoutSelection: enabled },
    };
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          workspaces: [
            { id: 'project-a', ...(capable ? { workspaceInstances: ['git_worktree'] } : {}) },
          ],
        },
      },
    ]);
    const selected = [
      { environmentId: 'personal-vm', workspaceId: 'project-a', checkout: 'isolated' as const },
    ];
    const { result } = renderHook(() =>
      useCodeWorkspace({
        ...conversation(selected),
        conversationId: 'saved',
        codeEnvironmentMode: 'attached',
      }),
    );
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.resolveSubmission(selected)).toBeUndefined();
  });

  it.each(['source', 'isolated'] as const)(
    'retains %s checkout through submission and restored-session resolution',
    (checkout) => {
      mockAgentsConfig().agentsConfig.statefulCodeSessions.environments[0].configSchema = {
        workspaces: { allowCheckoutSelection: true },
      };
      mockStatus.mockReturnValue([
        {
          data: {
            environmentId: 'personal-vm',
            status: 'ready',
            workspaces: [{ id: 'project-a', workspaceInstances: ['git_worktree'] }],
          },
        },
      ]);
      const selection = [{ environmentId: 'personal-vm', workspaceId: 'project-a', checkout }];
      const { result, rerender } = renderHook(
        ({ saved }) =>
          useCodeWorkspace({
            ...conversation(selection),
            conversationId: saved ? 'saved' : 'new',
            codeEnvironmentMode: 'attached',
          }),
        { initialProps: { saved: false } },
      );
      expect(result.current.resolveSubmission(selection)?.codeWorkspaces).toEqual(selection);
      rerender({ saved: true });
      expect(result.current.resolveSubmission(selection)?.codeWorkspaces).toEqual(selection);
    },
  );

  describe('per-chat machines', () => {
    function enableChoices() {
      const config = mockAgentsConfig().agentsConfig;
      config.statefulCodeSessions.allowEnvironmentSelection = true;
      config.statefulCodeSessions.environments.push({
        id: 'runtime-vm',
        name: 'Runtime VM',
        type: 'attached',
      });
      config.statefulCodeSessions.environments.push({
        id: 'unlisted-vm',
        name: 'Unlisted',
        type: 'attached',
      });
      mockAgentPermissions().agent.code_environment_ids = ['runtime-vm'];
      return config;
    }

    function enableInheritance() {
      mockStartupConfig.mockReturnValue({
        ...mockStartupConfig(),
        codeWorkspaceInheritanceVersion: 1,
      });
    }

    it('names the reviewer whose separate machine still needs a workspace', () => {
      enableChoices();
      mockAgentPermissions().agent.name = 'Lia';
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          name: 'PR Reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'runtime-vm',
        },
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: {
            environmentId: id,
            status: 'ready',
            workspaces:
              id === 'runtime-vm' ? [{ id: 'one' }, { id: 'two' }] : [{ id: 'project-a' }],
          },
        })),
      );
      const { result } = renderHook(() =>
        useCodeWorkspace(
          conversation([{ environmentId: 'personal-vm', workspaceId: 'project-a' }]),
        ),
      );
      expect(result.current.canSubmit).toBe(false);
      expect(
        result.current.environments.find(({ environment }) => environment.id === 'runtime-vm'),
      ).toMatchObject({ state: 'choose', requiredBy: [{ id: 'reviewer', name: 'PR Reviewer' }] });
    });

    it('shares one selected machine between Lia and a reviewer that both explicitly allow it', () => {
      enableChoices();
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          name: 'PR Reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'runtime-vm',
          code_environment_ids: ['personal-vm'],
        },
      });
      const selection = [{ environmentId: 'personal-vm', workspaceId: 'project-a' }];
      const { result } = renderHook(() => useCodeWorkspace(conversation(selection)));
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.environments).toHaveLength(1);
      expect(result.current.environments[0].requiredBy).toEqual(
        expect.arrayContaining([
          { id: 'reviewer', name: 'PR Reviewer' },
          { id: 'agent_primary', name: undefined },
        ]),
      );
      expect(result.current.resolveSubmission(selection)?.codeWorkspaces).toEqual(selection);
    });

    it('preserves the default plus an overlapping machine required by a fixed reviewer', () => {
      enableChoices();
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'runtime-vm',
        },
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: { environmentId: id, status: 'ready', workspaces: [{ id: 'project-a' }] },
        })),
      );
      const choices = [
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
        { environmentId: 'runtime-vm', workspaceId: 'project-a' },
      ];
      const { result } = renderHook(() => useCodeWorkspace(conversation(choices)));
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.fixedMachineIds).toEqual(['runtime-vm']);
      expect(result.current.resolveSubmission(choices)?.codeWorkspaces).toEqual(choices);
    });

    it('keeps a fixed reviewer on A while the primary explicitly chooses B, including reload', () => {
      enableChoices();
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'personal-vm',
        },
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: { environmentId: id, status: 'ready', workspaces: [{ id: 'project-a' }] },
        })),
      );
      const choices = [
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
        { environmentId: 'runtime-vm', workspaceId: 'project-a', agentIds: ['agent_primary'] },
      ];
      const { result, rerender } = renderHook(
        ({ saved }) =>
          useCodeWorkspace({
            ...conversation(choices),
            conversationId: saved ? 'saved' : 'new',
            codeEnvironmentMode: 'attached',
          }),
        { initialProps: { saved: false } },
      );
      expect(result.current.fixedMachineIds).toEqual(['personal-vm']);
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.resolveSubmission(choices)?.codeWorkspaces).toEqual(choices);
      expect(
        result.current.environments.find(({ environment }) => environment.id === 'runtime-vm')
          ?.requiredBy,
      ).toEqual([{ id: 'agent_primary', name: undefined }]);
      rerender({ saved: true });
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.resolveSubmission(choices)?.codeWorkspaces).toEqual(choices);
    });

    it("routes a reviewer with Lia's chosen machine when an older client sealed only her", () => {
      enableChoices();
      enableInheritance();
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          name: 'PR Reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'personal-vm',
          code_environment_ids: ['runtime-vm'],
        },
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: { environmentId: id, status: 'ready', workspaces: [{ id: 'project-a' }] },
        })),
      );
      const sealedChoice = [
        { environmentId: 'runtime-vm', workspaceId: 'project-a', agentIds: ['agent_primary'] },
      ];
      const { result } = renderHook(() =>
        useCodeWorkspace({
          ...conversation(sealedChoice),
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
        }),
      );
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.environments.map(({ environment }) => environment.id)).toEqual([
        'runtime-vm',
      ]);
      expect(result.current.environments[0].requiredBy).toEqual(
        expect.arrayContaining([{ id: 'reviewer', name: 'PR Reviewer' }]),
      );
      expect(result.current.resolveSubmission(sealedChoice)?.codeWorkspaces).toEqual(sealedChoice);
    });

    it("echoes the reviewer's former selection after it follows Lia, without gating on it", () => {
      enableChoices();
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeEnvironmentTransitionVersion: 2,
        codeWorkspaceInheritanceVersion: 1,
      });
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          name: 'PR Reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'personal-vm',
          code_environment_ids: ['runtime-vm'],
        },
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: { environmentId: id, status: 'ready', workspaces: [{ id: 'project-a' }] },
        })),
      );
      /** The demo incident's sealed decision: the reviewer's Code API checkout plus Lia's machine. */
      const incident = [
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
        { environmentId: 'runtime-vm', workspaceId: 'project-a', agentIds: ['agent_primary'] },
      ];
      const { result } = renderHook(() =>
        useCodeWorkspace({
          ...conversation(incident),
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
        }),
      );
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.transition?.kind).not.toBe('move');
      /** Nothing runs on the former machine, so its readiness is never polled or required. */
      expect(result.current.environments.map(({ environment }) => environment.id)).toEqual([
        'runtime-vm',
      ]);
      expect(mockStatus).toHaveBeenLastCalledWith(['runtime-vm'], true, expect.anything());
      expect(
        result.current.environments.find(({ environment }) => environment.id === 'runtime-vm')
          ?.requiredBy,
      ).toEqual(expect.arrayContaining([{ id: 'reviewer', name: 'PR Reviewer' }]));
      expect(result.current.resolveSubmission(incident)?.codeWorkspaces).toEqual(incident);
    });

    it("lets a new chat's reviewer follow Lia before any workspace is picked", () => {
      enableChoices();
      enableInheritance();
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          name: 'PR Reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'runtime-vm',
          code_environment_ids: ['personal-vm'],
        },
      });
      const { result } = renderHook(() => useCodeWorkspace(conversation()));
      expect(result.current.environments.map(({ environment }) => environment.id)).toEqual([
        'personal-vm',
      ]);
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.resolveSubmission()?.codeWorkspaces).toEqual([
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
      ]);
    });

    it("still asks for the reviewer's own machine when the API predates inheritance", () => {
      enableChoices();
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'runtime-vm',
          code_environment_ids: ['personal-vm'],
        },
      });
      const { result } = renderHook(() => useCodeWorkspace(conversation()));
      expect(result.current.environments.map(({ environment }) => environment.id)).toEqual([
        'personal-vm',
        'runtime-vm',
      ]);
    });

    it("keeps a reviewer that may not use Lia's machine on its own default", () => {
      enableChoices();
      mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['reviewer'] };
      mockAgentsMap.mockReturnValue({
        reviewer: {
          id: 'reviewer',
          name: 'PR Reviewer',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'personal-vm',
        },
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: { environmentId: id, status: 'ready', workspaces: [{ id: 'one' }, { id: 'two' }] },
        })),
      );
      const { result } = renderHook(() =>
        useCodeWorkspace(
          conversation([
            { environmentId: 'runtime-vm', workspaceId: 'one', agentIds: ['agent_primary'] },
          ]),
        ),
      );
      expect(result.current.canSubmit).toBe(false);
      expect(
        result.current.environments.find(({ environment }) => environment.id === 'personal-vm'),
      ).toMatchObject({ state: 'choose', requiredBy: [{ id: 'reviewer', name: 'PR Reviewer' }] });
    });

    it('offers an explicit saved-chat recovery target when the selected default disappears', () => {
      const config = enableChoices();
      config.statefulCodeSessions.environments = config.statefulCodeSessions.environments.filter(
        ({ id }: { id: string }) => id !== 'personal-vm',
      );
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: { environmentId: id, status: 'ready', workspaces: [{ id: 'project-a' }] },
        })),
      );
      const selected = [{ environmentId: 'personal-vm', workspaceId: 'project-a' }];
      const { result } = renderHook(() =>
        useCodeWorkspace({
          ...conversation(selected),
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
        }),
      );
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.transition).toMatchObject({
        kind: 'move',
        detachable: false,
        from: selected,
      });
      expect(result.current.transition?.targets.map(({ environment }) => environment.id)).toEqual([
        'runtime-vm',
      ]);
    });

    it('offers authorized alternatives without querying their status or blocking the default', () => {
      enableChoices();
      const { result } = renderHook(() => useCodeWorkspace(conversation()));
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.machineOptions?.map(({ id }) => id)).toEqual([
        'personal-vm',
        'runtime-vm',
      ]);
      expect(mockStatus).toHaveBeenLastCalledWith(['personal-vm'], true, {
        notifyOnChangeProps: ['data', 'isLoading', 'isError'],
      });
    });

    it('keeps two simultaneous chats independent and preserves the restored selection', () => {
      enableChoices();
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: {
            environmentId: id,
            status: 'ready',
            workspaces: [{ id: 'project-a', name: 'Project A' }],
          },
        })),
      );
      const selected = [{ environmentId: 'runtime-vm', workspaceId: 'project-a' }];
      const first = renderHook(() => useCodeWorkspace(conversation(selected)));
      const second = renderHook(() => useCodeWorkspace(conversation()));
      expect(first.result.current.resolveSubmission()).toEqual({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: selected,
      });
      expect(second.result.current.selections?.[0].environmentId).toBe('personal-vm');
      const restored = renderHook(() =>
        useCodeWorkspace({
          ...conversation(selected),
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
        }),
      );
      expect(restored.result.current.canSubmit).toBe(true);
      expect(restored.result.current.machineOptions).toBeUndefined();
    });

    it.each(['deployment', 'agent'])(
      'retains fixed binding when the %s opt-in is disabled',
      (gate) => {
        const config = enableChoices();
        if (gate === 'deployment') config.statefulCodeSessions.allowEnvironmentSelection = false;
        else mockAgentPermissions().agent.code_environment_ids = [];
        const { result } = renderHook(() => useCodeWorkspace(conversation()));
        expect(result.current.machineOptions).toBeUndefined();
        expect(result.current.selections?.[0].environmentId).toBe('personal-vm');
      },
    );

    it.each(['deployment', 'agent'])(
      'requires explicit recovery when the %s opt-in revokes a saved owned route',
      (gate) => {
        const config = enableChoices();
        mockStartupConfig.mockReturnValue({
          codeEnvironmentDecisionVersion: 1,
          codeEnvironmentMoveVersion: 1,
        });
        mockStatus.mockImplementation((ids: string[]) =>
          ids.map((id) => ({
            data: { environmentId: id, status: 'ready', workspaces: [{ id: 'project-a' }] },
          })),
        );
        if (gate === 'deployment') config.statefulCodeSessions.allowEnvironmentSelection = false;
        else mockAgentPermissions().agent.code_environment_ids = [];
        const selected = [
          { environmentId: 'personal-vm', workspaceId: 'project-a' },
          { environmentId: 'runtime-vm', workspaceId: 'project-a', agentIds: ['agent_primary'] },
        ];
        const { result } = renderHook(() =>
          useCodeWorkspace({
            ...conversation(selected),
            conversationId: 'saved',
            codeEnvironmentMode: 'attached',
          }),
        );
        expect(result.current.canSubmit).toBe(false);
        expect(result.current.resolveSubmission(selected)).toBeUndefined();
        expect(result.current.transition?.kind).toBe('move');
      },
    );

    it('fails closed on inaccessible, unused or ambiguous non-default machines', () => {
      const config = enableChoices();
      mockAgentPermissions().agent.code_environment_ids.push('third-vm');
      config.statefulCodeSessions.environments.push({
        id: 'third-vm',
        name: 'Third VM',
        type: 'attached',
      });
      for (const selected of [
        [{ environmentId: 'other-users-vm', workspaceId: 'primary' }],
        [{ environmentId: 'unlisted-vm', workspaceId: 'primary' }],
        [
          { environmentId: 'runtime-vm', workspaceId: 'primary' },
          { environmentId: 'third-vm', workspaceId: 'project-a' },
        ],
        [
          { environmentId: 'personal-vm', workspaceId: 'project-a' },
          { environmentId: 'runtime-vm', workspaceId: 'primary' },
        ],
      ]) {
        const { result } = renderHook(() => useCodeWorkspace(conversation(selected)));
        expect(result.current.canSubmit).toBe(false);
      }
    });

    it('keeps child discovery available while graph choices are partial', () => {
      const config = enableChoices();
      config.statefulCodeSessions.environments.push(
        { id: 'child-vm', name: 'Child', type: 'attached' },
        { id: 'child-alternative', name: 'Child alternative', type: 'attached' },
      );
      mockAgentPermissions().agent.agent_ids = ['child'];
      mockAgentsMap.mockReturnValue({
        child: {
          id: 'child',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'child-vm',
          code_environment_ids: ['child-alternative'],
        },
      });
      mockStatus.mockImplementation((ids: string[]) =>
        ids.map((id) => ({
          data: {
            environmentId: id,
            status: 'ready',
            workspaces:
              id === 'child-vm'
                ? [
                    { id: 'one', name: 'One' },
                    { id: 'two', name: 'Two' },
                  ]
                : [{ id: 'project-a', name: 'Project A' }],
          },
        })),
      );
      const selected = [{ environmentId: 'personal-vm', workspaceId: 'project-a' }];
      const { result, rerender } = renderHook(
        ({ choices }) => useCodeWorkspace(conversation(choices)),
        {
          initialProps: { choices: selected },
        },
      );
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.environments.map(({ environment }) => environment.id)).toEqual([
        'child-vm',
        'personal-vm',
      ]);
      expect(result.current.machineOptions?.map(({ id }) => id)).toEqual([
        'personal-vm',
        'runtime-vm',
        'child-vm',
        'child-alternative',
      ]);
      expect(result.current.machineOptionGroups).toEqual([
        ['personal-vm', 'runtime-vm'],
        ['child-vm', 'child-alternative'],
      ]);
      const choices = [
        ...selected,
        { environmentId: 'child-alternative', workspaceId: 'project-a' },
      ];
      rerender({ choices });
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.resolveSubmission(choices)?.codeWorkspaces).toEqual([
        choices[1],
        choices[0],
      ]);
    });

    it('keeps recovery controls when an implicit attached default loses access to the chosen machine', () => {
      const config = enableChoices();
      config.statefulCodeSessions.environments[0].default = true;
      config.statefulCodeSessions.environments = config.statefulCodeSessions.environments.filter(
        ({ id }: { id: string }) => id !== 'runtime-vm',
      );
      delete mockAgentPermissions().agent.code_environment_id;
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeEnvironmentTransitionVersion: 2,
      });
      const selected = [{ environmentId: 'runtime-vm', workspaceId: 'primary' }];
      const { result } = renderHook(() =>
        useCodeWorkspace({
          ...conversation(selected),
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
        }),
      );
      expect(result.current.required).toBe(true);
      expect(result.current.visible).toBe(true);
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.environments[0].environment.id).toBe('personal-vm');
      expect(result.current.transition).toMatchObject({
        kind: 'move',
        detachable: true,
        from: selected,
      });
    });

    it('offers a move-only recovery target after the agent revokes a saved alternative', () => {
      enableChoices();
      mockAgentPermissions().agent.code_environment_ids = [];
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
      });
      const selected = [{ environmentId: 'runtime-vm', workspaceId: 'primary' }];
      const { result } = renderHook(() =>
        useCodeWorkspace({
          ...conversation(selected),
          conversationId: 'saved',
          codeEnvironmentMode: 'attached',
        }),
      );
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.transition).toMatchObject({
        kind: 'move',
        detachable: false,
        from: selected,
      });
      expect(result.current.transition?.targets.map(({ environment }) => environment.id)).toEqual([
        'personal-vm',
      ]);
    });

    it('offers child alternatives even when the primary agent has a fixed machine', () => {
      const config = enableChoices();
      mockAgentPermissions().agent.code_environment_ids = [];
      config.statefulCodeSessions.environments.push({
        id: 'child-vm',
        name: 'Child',
        type: 'attached',
      });
      mockAgentPermissions().agent.agent_ids = ['child'];
      mockAgentsMap.mockReturnValue({
        child: {
          id: 'child',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'child-vm',
          code_environment_ids: ['runtime-vm'],
        },
      });
      const { result } = renderHook(() => useCodeWorkspace(conversation()));
      expect(result.current.machineOptions?.map(({ id }) => id)).toEqual([
        'runtime-vm',
        'child-vm',
      ]);
      expect(result.current.machineOptionGroups).toEqual([['child-vm', 'runtime-vm']]);
    });

    it('does not expose ignored choices for an implicit managed default alongside an attached child', () => {
      const config = enableChoices();
      config.statefulCodeSessions.environments[0].type = 'managed';
      config.statefulCodeSessions.environments[0].default = true;
      delete mockAgentPermissions().agent.code_environment_id;
      config.statefulCodeSessions.environments.push({
        id: 'child-vm',
        name: 'Child',
        type: 'attached',
      });
      mockAgentPermissions().agent.agent_ids = ['child'];
      mockAgentsMap.mockReturnValue({
        child: {
          id: 'child',
          stateful_code_sessions: true,
          tools: [Tools.execute_code],
          code_environment_id: 'child-vm',
        },
      });
      const { result } = renderHook(() => useCodeWorkspace(conversation()));
      expect(result.current.required).toBe(true);
      expect(result.current.machineOptions).toBeUndefined();
      expect(result.current.environments.map(({ environment }) => environment.id)).toEqual([
        'child-vm',
      ]);
    });
  });
  beforeEach(() => {
    mockPreference.mockReset();
    mockRememberPreference.mockReset();
    mockAccess.mockReturnValue(true);
    mockReplacingDecision.mockReturnValue(false);
    mockRecovery.mockReturnValue(undefined);
    mockStartupConfig.mockReturnValue({ codeEnvironmentDecisionVersion: 1 });
    mockAgentPermissions.mockReturnValue({
      tools: [Tools.execute_code],
      agent: {
        id: 'agent_primary',
        stateful_code_sessions: true,
        code_environment_id: 'personal-vm',
        tools: [Tools.execute_code],
      },
    });
    mockAgentsMap.mockReturnValue({});
    mockAgentsConfig.mockReturnValue({
      agentsConfig: {
        capabilities: ['execute_code', 'stateful_code_sessions'],
        statefulCodeSessions: {
          environments: [
            {
              id: 'personal-vm',
              name: 'Personal VM',
              type: 'attached',
              baseURL: 'https://code.example.com',
            },
          ],
        },
      },
    });
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          statefulWorkspace: true,
          workspaces: [{ id: 'project-a', name: 'Project A' }],
        },
        isLoading: false,
        isError: false,
      },
    ]);
  });

  it.each(['role', 'execute_code', 'stateful_code_sessions'])(
    'does not require a workspace when %s permission is disabled',
    (gate) => {
      if (gate === 'role') mockAccess.mockReturnValue(false);
      else {
        const config = mockAgentsConfig();
        config.agentsConfig.capabilities = config.agentsConfig.capabilities.filter(
          (value: string) => value !== gate,
        );
      }
      const { result } = renderHook(() => useCodeWorkspace(conversation()));
      expect(result.current.required).toBe(false);
      expect(result.current.state).toBe('not_required');
      expect(mockStatus).toHaveBeenLastCalledWith(['personal-vm'], false, {
        notifyOnChangeProps: ['data', 'isLoading', 'isError'],
      });
    },
  );

  /* The server checks for active work before it polls the target workspace, so a turn submitted
   * during that poll runs under the decision being replaced while the replacement still lands. */
  it('withholds submission while a decision replacement is in flight', () => {
    mockReplacingDecision.mockReturnValue(true);

    const { result } = renderHook(() =>
      useCodeWorkspace({ ...conversation(), conversationId: 'existing' } as TConversation),
    );

    expect(result.current.canSubmit).toBe(false);
    expect(result.current.resolveSubmission()).toBeUndefined();
    /** The control stays reachable, so the reader sees where the chat runs while it settles. */
    expect(result.current.visible).toBe(true);
  });

  it('keeps a saved chat without workspace access through first send and reload', () => {
    mockStartupConfig.mockReturnValue({
      codeEnvironmentDecisionVersion: 1,
      codeEnvironmentMoveVersion: 1,
      codeEnvironmentTransitionVersion: 2,
    });
    const existing = { ...conversation(), conversationId: 'existing' } as TConversation;
    const { result, rerender } = renderHook(({ chat }) => useCodeWorkspace(chat), {
      initialProps: { chat: existing },
    });
    expect(result.current.mode).toBe('without_attached');
    expect(result.current.canSubmit).toBe(true);
    const submission = result.current.resolveSubmission()!;
    expect(submission).toEqual({ codeEnvironmentMode: 'without_attached' });
    const persisted = JSON.parse(JSON.stringify(withSubmittedCodeDecision(existing, submission)));
    rerender({ chat: persisted });
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.transition?.kind).toBe('attach');
    const attached = {
      ...persisted,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
    };
    rerender({ chat: attached });
    expect(result.current.resolveSubmission()).toEqual({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: attached.codeWorkspaces,
    });
  });

  it.each(['pending', 'error'] as const)(
    'blocks every send while reconciliation is %s, even after switching to a non-coding agent',
    (status) => {
      mockRecovery.mockReturnValue({
        request: { conversationId: 'existing', attempted: {} },
        status,
        token: Symbol(),
      });
      mockAgentPermissions.mockReturnValue({
        tools: [],
        agent: { id: 'agent_primary', tools: [] },
      });
      const { result } = renderHook(() =>
        useCodeWorkspace({ ...conversation(), conversationId: 'existing' } as TConversation),
      );
      expect(result.current.required).toBe(false);
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.resolveSubmission()).toBeUndefined();
      expect(result.current.visible).toBe(true);
      expect(result.current.recovery?.status).toBe(status);
    },
  );

  it('reports unavailable when a ready worker advertises no workspaces', () => {
    mockStatus()[0].data.workspaces = [];
    const { result } = renderHook(() => useCodeWorkspace(conversation()));
    expect(result.current.state).toBe('unavailable');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.resolveSubmission(undefined, 'attached')).toBeUndefined();
  });

  it('selects one unambiguous initial workspace', () => {
    const { result } = renderHook(() => useCodeWorkspace(conversation()));

    expect(result.current.state).toBe('ready');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.locked).toBe(false);
    expect(result.current.mode).toBe('attached');
    expect(result.current.selections).toEqual([
      { environmentId: 'personal-vm', workspaceId: 'project-a' },
    ]);
    expect(mockStatus).toHaveBeenCalledWith(['personal-vm'], true, {
      notifyOnChangeProps: ['data', 'isLoading', 'isError'],
    });
  });

  it('does not emit a selection-less decision until the API advertises support', () => {
    mockStartupConfig.mockReturnValue({});
    mockStatus()[0].data.workspaces.push({ id: 'project-b', name: 'Project B' });

    const { result } = renderHook(() => useCodeWorkspace(conversation()));

    expect(result.current.supportsEnvironmentDecisions).toBe(false);
    expect(result.current.mode).toBeUndefined();
    expect(result.current.state).toBe('choose');
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.resolveSubmission()).toBeUndefined();
    expect(result.current.resolveSubmission(undefined, 'without_attached')).toBeUndefined();
  });

  it('uses an agent default ahead of the last used workspace while a chat is undecided', () => {
    mockStatus()[0].data.workspaces.push({ id: 'project-b', name: 'Project B' });
    mockAgentPermissions().agent.code_workspace_id = 'project-b';
    mockPreference.mockReturnValue('project-a');
    const { result, rerender } = renderHook(
      ({ id }) => useCodeWorkspace({ ...conversation(), conversationId: id }),
      {
        initialProps: { id: 'new' },
      },
    );
    expect(result.current.selections?.[0].workspaceId).toBe('project-b');
    /* Saving the chat does not seal a decision it never recorded, so the default still applies and
     * the composer still offers the choice. */
    rerender({ id: 'existing' });
    expect(result.current.locked).toBe(false);
    expect(result.current.mode).toBe('without_attached');
    expect(result.current.resolveSubmission()).toEqual({ codeEnvironmentMode: 'without_attached' });
    expect(result.current.selections?.[0].workspaceId).toBe('project-b');
    expect(result.current.canSubmit).toBe(true);
  });

  it('uses a valid last choice and preserves an explicit conversation binding', () => {
    mockStatus()[0].data.workspaces.push({ id: 'project-b', name: 'Project B' });
    mockPreference.mockReturnValue('project-b');
    const { result } = renderHook(() =>
      useCodeWorkspace({ ...conversation(), conversationId: 'new' }),
    );
    expect(result.current.selections?.[0].workspaceId).toBe('project-b');
    const saved = [{ environmentId: 'personal-vm', workspaceId: 'project-a' }];
    const existing = renderHook(() =>
      useCodeWorkspace({ ...conversation(saved), conversationId: 'new' }),
    );
    expect(existing.result.current.selections).toEqual(saved);
  });

  it('reads and records preferences for the root that reaches each environment', () => {
    const primaryAgent = {
      id: 'agent_primary',
      stateful_code_sessions: true,
      code_environment_id: 'primary-vm',
      tools: [Tools.execute_code],
    };
    const addedAgent = {
      id: 'agent_added',
      stateful_code_sessions: true,
      code_environment_id: 'added-vm',
      tools: [Tools.execute_code],
    };
    mockAgentPermissions.mockImplementation((agentId) => ({
      tools: [Tools.execute_code],
      agent: agentId === 'agent_added' ? addedAgent : primaryAgent,
    }));
    mockAgentsConfig.mockReturnValue({
      agentsConfig: {
        capabilities: ['execute_code', 'stateful_code_sessions'],
        statefulCodeSessions: {
          environments: [
            { id: 'primary-vm', name: 'Primary VM', type: 'attached' },
            { id: 'added-vm', name: 'Added VM', type: 'attached' },
          ],
        },
      },
    });
    mockStatus.mockReturnValue(
      ['added-vm', 'primary-vm'].map((environmentId) => ({
        data: {
          environmentId,
          status: 'ready',
          workspaces: [{ id: 'project-a' }, { id: 'project-b' }],
        },
        isLoading: false,
        isError: false,
      })),
    );
    mockPreference.mockImplementation((environmentId, agentId) =>
      environmentId === 'added-vm' && agentId === 'agent_added' ? 'project-b' : 'project-a',
    );

    const addedConversation = {
      ...conversation(),
      conversationId: 'new',
      agent_id: 'agent_added',
    };
    const { result } = renderHook(() =>
      useCodeWorkspace({ ...conversation(), conversationId: 'new' }, addedConversation),
    );

    expect(result.current.selections).toEqual([
      { environmentId: 'added-vm', workspaceId: 'project-b' },
      { environmentId: 'primary-vm', workspaceId: 'project-a' },
    ]);
    result.current.rememberSelection({ environmentId: 'added-vm', workspaceId: 'project-a' });
    expect(mockRememberPreference).toHaveBeenCalledWith('added-vm', 'project-a', ['agent_added']);
  });

  it('applies an added agent default after the primary workspace is already pinned', () => {
    const primaryAgent = {
      id: 'agent_primary',
      stateful_code_sessions: true,
      code_environment_id: 'primary-vm',
      code_workspace_id: 'primary-project',
      tools: [Tools.execute_code],
    };
    const addedAgent = {
      id: 'agent_added',
      stateful_code_sessions: true,
      code_environment_id: 'added-vm',
      code_workspace_id: 'added-project',
      tools: [Tools.execute_code],
    };
    mockAgentPermissions.mockImplementation((agentId) => ({
      tools: [Tools.execute_code],
      agent: agentId === 'agent_added' ? addedAgent : primaryAgent,
    }));
    mockAgentsConfig.mockReturnValue({
      agentsConfig: {
        capabilities: ['execute_code', 'stateful_code_sessions'],
        statefulCodeSessions: {
          environments: [
            { id: 'primary-vm', type: 'attached' },
            { id: 'added-vm', type: 'attached' },
          ],
        },
      },
    });
    mockStatus.mockImplementation((environmentIds: string[]) =>
      environmentIds.map((environmentId) => ({
        data: {
          environmentId,
          status: 'ready',
          workspaces: [
            { id: environmentId === 'primary-vm' ? 'primary-project' : 'added-project' },
          ],
        },
        isLoading: false,
        isError: false,
      })),
    );
    const primarySelection = {
      environmentId: 'primary-vm',
      workspaceId: 'primary-project',
    };
    const addedConversation = {
      ...conversation(),
      conversationId: 'new',
      agent_id: 'agent_added',
    };

    const { result } = renderHook(() =>
      useCodeWorkspace(
        { ...conversation([primarySelection]), conversationId: 'new' },
        addedConversation,
      ),
    );

    expect(result.current.selections).toEqual([
      { environmentId: 'added-vm', workspaceId: 'added-project' },
      primarySelection,
    ]);
    expect(result.current.canSubmit).toBe(true);
  });

  it('ignores stale remembered choices but never silently replaces a missing agent default', () => {
    mockPreference.mockReturnValue('gone');
    const { result, rerender } = renderHook(() =>
      useCodeWorkspace({ ...conversation(), conversationId: 'new' }),
    );
    expect(result.current.selections?.[0].workspaceId).toBe('project-a');
    mockAgentPermissions.mockReturnValue({
      ...mockAgentPermissions(),
      agent: { ...mockAgentPermissions().agent, code_workspace_id: 'gone' },
    });
    rerender();
    expect(result.current.state).toBe('missing');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.resolveSubmission()).toEqual({
      codeEnvironmentMode: 'without_attached',
    });
  });

  it.each(['ephemeral', 'openAI__gpt-4o'])('does not block ephemeral agent %s', (agent_id) => {
    mockAgentPermissions.mockReturnValue({});
    const { result } = renderHook(() => useCodeWorkspace({ ...conversation(), agent_id }));
    expect(result.current.required).toBe(false);
    expect(result.current.state).toBe('not_required');
    expect(mockStatus).toHaveBeenLastCalledWith([], false, {
      notifyOnChangeProps: ['data', 'isLoading', 'isError'],
    });
  });

  it('still blocks missing saved-agent metadata alongside an ephemeral agent', () => {
    mockAgentPermissions.mockReturnValue({});
    const { result } = renderHook(() =>
      useCodeWorkspace(
        { ...conversation(), agent_id: 'ephemeral' },
        { ...conversation(), agent_id: 'agent_missing' },
      ),
    );
    expect(result.current.required).toBe(true);
    expect(result.current.state).toBe('unavailable');
  });

  it.each([false, undefined])(
    'selects native roots without runtime sessions: %s',
    (statefulWorkspace) => {
      const statuses = mockStatus();
      statuses[0].data.statefulWorkspace = statefulWorkspace;
      const selection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
      const { result } = renderHook(() => useCodeWorkspace(conversation([selection])));
      expect(result.current.state).toBe('ready');
      expect(result.current.selections).toEqual([selection]);
      expect(result.current.resolveSelections([selection])).toEqual([selection]);
    },
  );

  it('automatically selects a sole native root without runtime sessions', () => {
    mockStatus()[0].data.statefulWorkspace = false;
    const { result } = renderHook(() => useCodeWorkspace(conversation()));
    expect(result.current.state).toBe('ready');
    expect(result.current.selections).toEqual([
      { environmentId: 'personal-vm', workspaceId: 'project-a' },
    ]);
  });

  it.each(['offline', 'starting'])('rejects a native worker that is %s', (status) => {
    Object.assign(mockStatus()[0].data, { status, statefulWorkspace: false });
    const { result } = renderHook(() => useCodeWorkspace(conversation()));
    expect(result.current.state).toBe('unavailable');
    expect(result.current.selections).toBeUndefined();
  });

  it('rejects a ready native worker without advertised roots', () => {
    Object.assign(mockStatus()[0].data, { statefulWorkspace: false, workspaces: undefined });
    const { result } = renderHook(() => useCodeWorkspace(conversation()));
    expect(result.current.state).toBe('unsupported');
    expect(result.current.selections).toBeUndefined();
  });

  it('allows ordinary chat without a workspace and uses one after explicit selection', () => {
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          statefulWorkspace: true,
          workspaces: [{ id: 'primary' }, { id: 'canary-a' }, { id: 'canary-b' }],
        },
        isLoading: false,
        isError: false,
      },
    ]);

    const initialConversation: TConversation = {
      ...conversation(),
      codeApprovalMode: 'fullAccess',
    };
    const { result, rerender } = renderHook(({ current }) => useCodeWorkspace(current), {
      initialProps: { current: initialConversation },
    });

    expect(result.current.state).toBe('choose');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.selections).toBeUndefined();
    expect(result.current.resolveSubmission()).toEqual({
      codeEnvironmentMode: 'without_attached',
    });

    const selection = { environmentId: 'personal-vm', workspaceId: 'canary-a' };
    rerender({ current: { ...initialConversation, codeWorkspaces: [selection] } });

    expect(result.current.state).toBe('ready');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.resolveSubmission([selection])).toEqual({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
  });

  it('submits an explicit selection from several advertised workspaces', () => {
    const selection = { environmentId: 'personal-vm', workspaceId: 'canary-a' };
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          workspaces: [{ id: 'primary' }, { id: 'canary-a' }, { id: 'canary-b' }],
        },
        isLoading: false,
        isError: false,
      },
    ]);

    const { result } = renderHook(() => useCodeWorkspace(conversation([selection])));

    expect(result.current.canSubmit).toBe(true);
    expect(result.current.resolveSubmission([selection])).toEqual({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [selection],
    });
  });

  it('allows ordinary chat while the attached worker status is loading', () => {
    mockStatus.mockReturnValue([{ data: undefined, isLoading: true, isError: false }]);

    const { result } = renderHook(() => useCodeWorkspace(conversation()));

    expect(result.current.required).toBe(true);
    expect(result.current.state).toBe('loading');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.resolveSubmission()).toEqual({
      codeEnvironmentMode: 'without_attached',
    });
  });

  it('allows ordinary chat while endpoint capabilities are loading', () => {
    mockAgentsConfig.mockReturnValue({ agentsConfig: null, endpointsConfig: undefined });

    const { result } = renderHook(() => useCodeWorkspace(conversation()));

    expect(result.current.required).toBe(true);
    expect(result.current.state).toBe('loading');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.resolveSubmission()).toEqual({
      codeEnvironmentMode: 'without_attached',
    });
    expect(mockStatus).toHaveBeenLastCalledWith([], false, {
      notifyOnChangeProps: ['data', 'isLoading', 'isError'],
    });
  });

  it('does not replace a saved workspace that disappeared', () => {
    const saved = { environmentId: 'personal-vm', workspaceId: 'removed-project' };
    const { result } = renderHook(() => useCodeWorkspace(conversation([saved])));

    expect(result.current.state).toBe('missing');
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.selections).toBeUndefined();
    expect(result.current.resolveSelections([saved])).toBeUndefined();
  });

  it('does not reuse a workspace selection after the environment changes', () => {
    const saved = { environmentId: 'old-vm', workspaceId: 'project-a' };
    const { result } = renderHook(() => useCodeWorkspace(conversation([saved])));

    expect(result.current.state).toBe('choose');
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.selections).toBeUndefined();
    expect(result.current.transition).toBeUndefined();
  });

  describe('a saved chat sealed to a machine its agent no longer uses', () => {
    const sealed = (codeWorkspaces: TConversation['codeWorkspaces']): TConversation =>
      ({
        ...conversation(codeWorkspaces),
        conversationId: 'existing',
        codeEnvironmentMode: 'attached',
      }) as TConversation;
    const mac = { environmentId: 'mac', workspaceId: 'primary' };

    beforeEach(() => {
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeEnvironmentTransitionVersion: 2,
      });
    });

    it('keeps the recovery status for an API that cannot move chats', () => {
      mockStartupConfig.mockReturnValue({ codeEnvironmentDecisionVersion: 1 });

      const { result } = renderHook(() => useCodeWorkspace(sealed([mac])));

      expect(result.current.state).toBe('choose');
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.transition).toBeUndefined();
    });

    it.each(['non-coding', 'managed-only'])(
      'offers detach after switching to a %s agent',
      (kind) => {
        const previous = { environmentId: 'personal-vm', workspaceId: 'project-a' };
        const agent = mockAgentPermissions().agent;
        if (kind === 'non-coding') {
          agent.tools = [];
          agent.stateful_code_sessions = false;
        } else {
          agent.code_environment_id = 'managed';
          mockAgentsConfig().agentsConfig.statefulCodeSessions.environments.push({
            id: 'managed',
            type: 'managed',
            name: 'Managed',
          });
        }
        const original = sealed([previous]);
        const { result, rerender } = renderHook(({ chat }) => useCodeWorkspace(chat), {
          initialProps: { chat: original },
        });
        expect(result.current.required).toBe(false);
        expect(result.current.state).toBe('not_required');
        expect(result.current.canSubmit).toBe(true);
        expect(result.current.visible).toBe(true);
        expect(result.current.transition).toEqual(
          expect.objectContaining({
            kind: 'move',
            from: [previous],
            retained: [],
            targets: [],
            detachable: true,
          }),
        );
        // Switching agents does not silently detach. Only a successful transition clears the seal.
        expect(original.codeWorkspaces).toEqual([previous]);
        rerender({
          chat: { ...original, codeEnvironmentMode: 'without_attached', codeWorkspaces: undefined },
        });
        expect(result.current.transition).toBeUndefined();
        expect(result.current.canSubmit).toBe(true);
        expect(result.current.visible).toBe(false);
      },
    );

    it('keeps the no-environment detach hidden on a move-only deployment', () => {
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
      });
      mockAgentPermissions().agent.tools = [];
      mockAgentPermissions().agent.stateful_code_sessions = false;
      const { result } = renderHook(() => useCodeWorkspace(sealed([mac])));
      expect(result.current.required).toBe(false);
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.transition).toBeUndefined();
      expect(result.current.visible).toBe(false);
    });

    it('offers to move the chat instead of an unusable workspace choice', () => {
      mockAgentsConfig().agentsConfig.statefulCodeSessions.environments.push({
        id: 'mac',
        name: 'Danny Mac',
        type: 'attached',
        baseURL: 'https://code.example.com',
      });

      const { result } = renderHook(() => useCodeWorkspace(sealed([mac])));

      expect(result.current.locked).toBe(true);
      expect(result.current.state).toBe('relocatable');
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.transition).toEqual({
        kind: 'move',
        detachable: true,
        conversationId: 'existing',
        from: [mac],
        previous: [{ id: 'mac', name: 'Danny Mac' }],
        retained: [],
        targets: [
          expect.objectContaining({
            environment: expect.objectContaining({ id: 'personal-vm' }),
            state: 'choose',
            workspaces: [{ id: 'project-a', name: 'Project A' }],
          }),
        ],
      });
    });

    it('offers to drop a machine the agents stopped using instead of trimming the seal', () => {
      const kept = { environmentId: 'personal-vm', workspaceId: 'project-a' };
      const gone = { environmentId: 'gone-vm', workspaceId: 'root' };

      const { result } = renderHook(() => useCodeWorkspace(sealed([gone, kept])));

      expect(result.current.state).toBe('relocatable');
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.transition).toEqual({
        kind: 'move',
        detachable: true,
        conversationId: 'existing',
        from: [gone, kept],
        previous: [{ id: 'gone-vm', name: undefined }],
        retained: [kept],
        targets: [],
      });
    });

    it('never submits a trimmed seal when the API cannot move chats', () => {
      mockStartupConfig.mockReturnValue({ codeEnvironmentDecisionVersion: 1 });
      const kept = { environmentId: 'personal-vm', workspaceId: 'project-a' };
      const gone = { environmentId: 'gone-vm', workspaceId: 'root' };

      const { result } = renderHook(() => useCodeWorkspace(sealed([gone, kept])));

      expect(result.current.state).toBe('choose');
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.resolveSubmission([gone, kept], 'attached')).toBeUndefined();
    });

    it('treats a legacy selection-only seal the same way', () => {
      const { result } = renderHook(() =>
        useCodeWorkspace({ ...conversation([mac]), conversationId: 'existing' }),
      );

      expect(result.current.state).toBe('relocatable');
      expect(result.current.transition?.previous).toEqual([{ id: 'mac', name: undefined }]);
    });

    it.each([
      {
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeEnvironmentTransitionVersion: 2,
      },
      { codeEnvironmentMoveVersion: 1, codeEnvironmentTransitionVersion: 2 },
    ])('carries over a sealed workspace the agents still use: %j', (startupConfig) => {
      mockStartupConfig.mockReturnValue(startupConfig);
      const primary = {
        id: 'agent_primary',
        stateful_code_sessions: true,
        code_environment_id: 'personal-vm',
        tools: [Tools.execute_code],
        subagents: { enabled: true, agent_ids: ['child'] },
      };
      mockAgentPermissions.mockImplementation((id?: string) => ({
        agent: id === 'agent_primary' ? primary : undefined,
        tools: id === 'agent_primary' ? primary.tools : undefined,
      }));
      mockAgentsMap.mockReturnValue({
        child: {
          id: 'child',
          stateful_code_sessions: true,
          code_environment_id: 'team-vm',
          tools: [Tools.execute_code],
        },
      });
      mockAgentsConfig().agentsConfig.statefulCodeSessions.environments.push({
        id: 'team-vm',
        name: 'Team VM',
        type: 'attached',
        baseURL: 'https://two.example.com',
      });
      mockStatus.mockReturnValue([
        mockStatus()[0],
        {
          data: {
            environmentId: 'team-vm',
            status: 'ready',
            statefulWorkspace: true,
            workspaces: [{ id: 'project-b' }],
          },
          isLoading: false,
          isError: false,
        },
      ]);
      const kept = { environmentId: 'personal-vm', workspaceId: 'project-a' };

      const { result } = renderHook(() => useCodeWorkspace(sealed([kept])));

      expect(result.current.state).toBe('relocatable');
      expect(result.current.transition?.previous).toEqual([]);
      expect(result.current.transition?.retained).toEqual([kept]);
      expect(result.current.transition?.targets.map(({ environment }) => environment.id)).toEqual([
        'team-vm',
      ]);
    });

    /** A second machine the agents use that no set of picks can cover: unreachable, so it is
     *  neither carried over nor selectable. */
    const withUnreachableSecondEnvironment = () => {
      const primary = {
        id: 'agent_primary',
        stateful_code_sessions: true,
        code_environment_id: 'personal-vm',
        tools: [Tools.execute_code],
        subagents: { enabled: true, agent_ids: ['child'] },
      };
      mockAgentPermissions.mockImplementation((id?: string) => ({
        agent: id === 'agent_primary' ? primary : undefined,
        tools: id === 'agent_primary' ? primary.tools : undefined,
      }));
      mockAgentsMap.mockReturnValue({
        child: {
          id: 'child',
          stateful_code_sessions: true,
          code_environment_id: 'team-vm',
          tools: [Tools.execute_code],
        },
      });
      mockAgentsConfig().agentsConfig.statefulCodeSessions.environments.push({
        id: 'team-vm',
        name: 'Team VM',
        type: 'attached',
        baseURL: 'https://two.example.com',
      });
      mockStatus.mockReturnValue([mockStatus()[0], { isLoading: false, isError: true }]);
    };

    /* A transition replaces the decision whole, so one that named only the reachable machines
     * would seal a decision the next turn refuses, trading one dead end for a sealed one. */
    it('refuses to attach while another machine the agents use is unreachable', () => {
      withUnreachableSecondEnvironment();

      const { result } = renderHook(() =>
        useCodeWorkspace({
          ...conversation(),
          conversationId: 'existing',
          codeEnvironmentMode: 'without_attached',
        } as TConversation),
      );

      /** The chat keeps running without a workspace, which an unreachable machine does not change. */
      expect(result.current.state).toBe('without_attached');
      expect(result.current.canSubmit).toBe(true);
      /** Already running without a workspace, so there is nothing to escape to. */
      expect(result.current.transition).toBeUndefined();
      expect(result.current.visible).toBe(true);
    });

    it('offers only to continue without a workspace when a machine cannot be covered', () => {
      withUnreachableSecondEnvironment();
      const kept = { environmentId: 'personal-vm', workspaceId: 'project-a' };

      const { result } = renderHook(() => useCodeWorkspace(sealed([kept])));

      expect(result.current.state).toBe('unavailable');
      expect(result.current.canSubmit).toBe(false);
      /** No partial decision on offer: an empty target set is the detach, and that is the escape. */
      expect(result.current.transition).toEqual(
        expect.objectContaining({
          kind: 'move',
          detachable: true,
          from: [kept],
          retained: [],
          targets: [],
        }),
      );
    });

    /* A replica advertising the move-only protocol refuses an attach as `locked` and an empty
     * target set as `invalid`, so those wait for v2 while the move it already serves keeps working
     * — a mixed-version deployment must not lose the recovery path it had. */
    describe('against a deployment that only supports moves', () => {
      beforeEach(() => {
        mockStartupConfig.mockReturnValue({
          codeEnvironmentDecisionVersion: 1,
          codeEnvironmentMoveVersion: 1,
        });
      });

      it('keeps the move but withholds leaving attached execution', () => {
        mockAgentsConfig().agentsConfig.statefulCodeSessions.environments.push({
          id: 'mac',
          name: 'Danny Mac',
          type: 'attached',
          baseURL: 'https://code.example.com',
        });

        const { result } = renderHook(() => useCodeWorkspace(sealed([mac])));

        expect(result.current.state).toBe('relocatable');
        expect(result.current.transition).toEqual(
          expect.objectContaining({ kind: 'move', detachable: false }),
        );
      });

      it('offers no attach to a chat that continues without a workspace', () => {
        const { result } = renderHook(() =>
          useCodeWorkspace({
            ...conversation(),
            conversationId: 'existing',
            codeEnvironmentMode: 'without_attached',
          } as TConversation),
        );

        expect(result.current.state).toBe('without_attached');
        expect(result.current.transition).toBeUndefined();
      });

      /** Nothing to move onto and no detach to offer, so the composer reports the state instead. */
      it('offers nothing when a machine the agents use cannot be covered', () => {
        withUnreachableSecondEnvironment();
        const kept = { environmentId: 'personal-vm', workspaceId: 'project-a' };

        const { result } = renderHook(() => useCodeWorkspace(sealed([kept])));

        expect(result.current.state).toBe('unavailable');
        expect(result.current.canSubmit).toBe(false);
        expect(result.current.transition).toBeUndefined();
        expect(result.current.visible).toBe(true);
      });
    });

    it('waits for the new machine before offering a move', () => {
      mockStatus.mockReturnValue([{ isLoading: true, isError: false }]);

      const { result } = renderHook(() => useCodeWorkspace(sealed([mac])));

      expect(result.current.state).toBe('loading');
      expect(result.current.transition).toBeUndefined();
    });

    /* The sealed workspace cannot be swapped for another on the same machine, so the only decision
     * left is whether to keep waiting for it. */
    it.each([
      {
        name: 'the sealed machine lost its workspace',
        stored: { environmentId: 'personal-vm', workspaceId: 'removed-project' },
        state: 'missing',
        status: undefined,
      },
      {
        name: 'the sealed machine is unreachable',
        stored: { environmentId: 'personal-vm', workspaceId: 'project-a' },
        state: 'unavailable',
        status: { isLoading: false, isError: true },
      },
    ])('offers to continue without a workspace when $name', ({ stored, state, status }) => {
      if (status != null) mockStatus.mockReturnValue([status]);

      const { result } = renderHook(() => useCodeWorkspace(sealed([stored])));

      expect(result.current.state).toBe(state);
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.visible).toBe(true);
      expect(result.current.transition).toEqual(
        expect.objectContaining({ kind: 'move', detachable: true, from: [stored], targets: [] }),
      );
    });

    it('does not offer recovery to an API that only supports environment moves', () => {
      mockStartupConfig.mockReturnValue({ codeEnvironmentMoveVersion: 1 });
      const removed = { environmentId: 'personal-vm', workspaceId: 'removed-project' };

      const { result } = renderHook(() => useCodeWorkspace(sealed([removed])));

      expect(result.current.state).toBe('missing');
      expect(result.current.transition).toBeUndefined();
    });

    describe('missing workspace recovery', () => {
      const missing = { environmentId: 'personal-vm', workspaceId: 'deleted-project' };
      const replacement = { environmentId: 'personal-vm', workspaceId: 'project-a' };

      beforeEach(() => {
        mockStartupConfig.mockReturnValue({
          codeEnvironmentMoveVersion: 1,
          codeWorkspaceRecoveryVersion: 1,
        });
      });

      it.each(['attached', undefined] as const)(
        'offers explicit recovery without silently selecting a replacement for mode %s',
        (codeEnvironmentMode) => {
          const { result, rerender } = renderHook(
            ({ codeWorkspaces }) =>
              useCodeWorkspace({ ...sealed(codeWorkspaces), codeEnvironmentMode }),
            { initialProps: { codeWorkspaces: [missing] } },
          );

          expect(result.current.state).toBe('relocatable');
          expect(result.current.canSubmit).toBe(false);
          expect(result.current.selections).toBeUndefined();
          expect(result.current.resolveSubmission([missing], 'attached')).toBeUndefined();
          expect(result.current.transition).toEqual({
            kind: 'move',
            detachable: false,
            conversationId: 'existing',
            from: [missing],
            previous: [],
            retained: [],
            targets: [expect.objectContaining({ state: 'missing', selected: undefined })],
          });

          rerender({ codeWorkspaces: [replacement] });
          expect(result.current.state).toBe('ready');
          expect(result.current.locked).toBe(true);
          expect(result.current.canSubmit).toBe(true);
          expect(result.current.transition).toBeUndefined();
        },
      );

      it.each([
        { codeEnvironmentMoveVersion: 1 },
        { codeEnvironmentMoveVersion: 1, codeWorkspaceRecoveryVersion: 2 },
        { codeWorkspaceRecoveryVersion: 1 },
        { codeEnvironmentMoveVersion: 2, codeWorkspaceRecoveryVersion: 1 },
      ])('never offers recovery without both supported capabilities: %j', (config) => {
        mockStartupConfig.mockReturnValue(config);
        const { result } = renderHook(() => useCodeWorkspace(sealed([missing])));
        expect(result.current.state).toBe('missing');
        expect(result.current.transition).toBeUndefined();
        expect(result.current.canSubmit).toBe(false);
      });

      it('preserves ordinary environment moves on a recovery-capable API', () => {
        const { result } = renderHook(() => useCodeWorkspace(sealed([mac])));
        expect(result.current.state).toBe('relocatable');
        expect(result.current.transition?.targets[0].state).toBe('choose');
      });

      it('offers the empty recovery picker without inventing a replacement', () => {
        mockStatus()[0].data.workspaces = [];
        const { result } = renderHook(() => useCodeWorkspace(sealed([missing])));
        expect(result.current.transition?.targets[0].workspaces).toEqual([]);
        expect(result.current.canSubmit).toBe(false);
      });

      it.each(['ready', 'loading', 'unavailable', 'unsupported', 'choose', 'missing'] as const)(
        'handles a second environment in state %s without dropping its sealed selection',
        (state) => {
          mockAgentPermissions().agent.subagents = { enabled: true, agent_ids: ['child'] };
          mockAgentsMap.mockReturnValue({
            child: {
              id: 'child',
              stateful_code_sessions: true,
              code_environment_id: 'team-vm',
              tools: [Tools.execute_code],
            },
          });
          mockAgentsConfig().agentsConfig.statefulCodeSessions.environments.push({
            id: 'team-vm',
            name: 'Team VM',
            type: 'attached',
            baseURL: 'https://team.example.com',
          });
          const kept = { environmentId: 'team-vm', workspaceId: 'shared' };
          mockStatus().push({
            data: {
              environmentId: 'team-vm',
              status: state === 'unavailable' ? 'unavailable' : 'ready',
              workspaces:
                state === 'unsupported'
                  ? undefined
                  : [{ id: state === 'missing' ? 'replacement' : 'shared' }],
            },
            isLoading: state === 'loading',
            isError: false,
          });
          const from = state === 'choose' ? [missing] : [missing, kept];
          const { result } = renderHook(() => useCodeWorkspace(sealed(from)));

          expect(result.current.canSubmit).toBe(false);
          if (['loading', 'unavailable', 'unsupported'].includes(state)) {
            expect(result.current.transition).toBeUndefined();
            return;
          }
          expect(result.current.transition?.from).toEqual(from);
          expect(result.current.transition?.retained).toEqual(state === 'ready' ? [kept] : []);
          expect(
            result.current.transition?.targets.map(({ environment }) => environment.id),
          ).toEqual(state === 'ready' ? ['personal-vm'] : ['personal-vm', 'team-vm']);
        },
      );
    });

    it('offers both missing-workspace replacement and explicit detach when both are advertised', () => {
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeWorkspaceRecoveryVersion: 1,
        codeEnvironmentTransitionVersion: 2,
      });
      const missing = { environmentId: 'personal-vm', workspaceId: 'removed-project' };
      const { result } = renderHook(() => useCodeWorkspace(sealed([missing])));
      expect(result.current.state).toBe('relocatable');
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.transition).toMatchObject({
        kind: 'move',
        detachable: true,
        from: [missing],
        targets: [expect.objectContaining({ state: 'missing' })],
      });
    });

    it('keeps a healthy attached workspace visible with an explicit detach action', () => {
      const kept = { environmentId: 'personal-vm', workspaceId: 'project-a' };

      const { result } = renderHook(() => useCodeWorkspace(sealed([kept])));

      expect(result.current.state).toBe('ready');
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.transition).toMatchObject({
        kind: 'detach',
        from: [kept],
        retained: [kept],
        targets: [],
        detachable: true,
      });
      expect(result.current.visible).toBe(true);
      expect(result.current.resolveSubmission([kept], 'attached')).toEqual({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [kept],
      });
    });

    it('does not offer healthy detach to a replica that only supports moves', () => {
      mockStartupConfig.mockReturnValue({
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
      });
      const kept = { environmentId: 'personal-vm', workspaceId: 'project-a' };
      const { result } = renderHook(() => useCodeWorkspace(sealed([kept])));
      expect(result.current.transition).toBeUndefined();
      expect(result.current.visible).toBe(false);
    });

    /* A chat that recorded running without a workspace keeps that decision until its owner attaches
     * one; switching it to a coding agent is a transition, not a dead end. */
    it('offers to attach a workspace to a chat that continues without one', () => {
      const withoutAttached = {
        ...conversation(),
        conversationId: 'existing',
        codeEnvironmentMode: 'without_attached',
      } as TConversation;

      const { result } = renderHook(() => useCodeWorkspace(withoutAttached));

      expect(result.current.state).toBe('without_attached');
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.visible).toBe(true);
      expect(result.current.transition).toEqual({
        kind: 'attach',
        detachable: false,
        conversationId: 'existing',
        from: [],
        previous: [],
        retained: [],
        targets: [
          expect.objectContaining({
            environment: expect.objectContaining({ id: 'personal-vm' }),
            state: 'choose',
            workspaces: [{ id: 'project-a', name: 'Project A' }],
          }),
        ],
      });
    });

    it.each([
      { name: 'the API cannot move chats', config: { codeEnvironmentDecisionVersion: 1 } },
      {
        name: 'no machine is reachable',
        config: {
          codeEnvironmentDecisionVersion: 1,
          codeEnvironmentMoveVersion: 1,
          codeEnvironmentTransitionVersion: 2,
        },
        status: { isLoading: false, isError: true },
      },
    ])('still reports a chat running without a workspace when $name', ({ config, status }) => {
      mockStartupConfig.mockReturnValue(config);
      if (status != null) mockStatus.mockReturnValue([status]);

      const { result } = renderHook(() =>
        useCodeWorkspace({
          ...conversation(),
          conversationId: 'existing',
          codeEnvironmentMode: 'without_attached',
        } as TConversation),
      );

      expect(result.current.state).toBe('without_attached');
      expect(result.current.canSubmit).toBe(true);
      expect(result.current.visible).toBe(true);
      expect(result.current.transition).toBeUndefined();
    });

    it('offers but does not automatically attach a sole workspace to an undecided saved chat', () => {
      const { result } = renderHook(() =>
        useCodeWorkspace({ ...conversation(), conversationId: 'existing' } as TConversation),
      );

      expect(result.current.locked).toBe(false);
      expect(result.current.state).toBe('ready');
      expect(result.current.selections).toEqual([
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
      ]);
      expect(result.current.resolveSubmission()).toEqual({
        codeEnvironmentMode: 'without_attached',
      });
    });

    /* Switching an existing chat to a coding agent used to leave the composer with a sealed
     * decision its owner never made: nothing to select, and Send disabled. */
    it.each([
      { support: { codeEnvironmentDecisionVersion: 1 } },
      {
        support: {
          codeEnvironmentDecisionVersion: 1,
          codeEnvironmentMoveVersion: 1,
          codeEnvironmentTransitionVersion: 2,
        },
      },
    ])('lets a saved chat with several workspaces choose one', ({ support }) => {
      mockStartupConfig.mockReturnValue(support);
      mockStatus()[0].data.workspaces.push({ id: 'project-b', name: 'Project B' });
      const chosen = { environmentId: 'personal-vm', workspaceId: 'project-b' };

      const { result } = renderHook(() =>
        useCodeWorkspace({ ...conversation(), conversationId: 'existing' } as TConversation),
      );

      expect(result.current.locked).toBe(false);
      expect(result.current.state).toBe('choose');
      expect(result.current.transition).toBeUndefined();
      /* `useChatFunctions` submits the conversation's latest selections and mode together, the way
       * the menu writes both when a workspace is picked. */
      expect(result.current.resolveSubmission([chosen], 'attached')).toEqual({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [chosen],
      });
    });

    /* A replica that predates the protocol reads a field-less row as sealed `without_attached`, so
     * attaching an agent default here would submit a choice it rejects as `locked`. The rollout
     * window keeps the legacy lock, which is what an unadvertised protocol means. */
    it('keeps the legacy lock until the deployment advertises the protocol', () => {
      mockStartupConfig.mockReturnValue({});
      mockStatus()[0].data.workspaces.push({ id: 'project-b', name: 'Project B' });
      mockAgentPermissions().agent.code_workspace_id = 'project-b';

      const { result } = renderHook(() =>
        useCodeWorkspace({ ...conversation(), conversationId: 'existing' } as TConversation),
      );

      expect(result.current.locked).toBe(true);
      expect(result.current.mode).toBeUndefined();
      expect(result.current.selections).toBeUndefined();
      expect(result.current.canSubmit).toBe(false);
      expect(result.current.resolveSubmission()).toBeUndefined();
    });

    it('keeps auto-selecting for an API that does not seal decisions', () => {
      mockStartupConfig.mockReturnValue({});

      const { result } = renderHook(() =>
        useCodeWorkspace({ ...conversation(), conversationId: 'existing' } as TConversation),
      );

      expect(result.current.state).toBe('ready');
      expect(result.current.selections).toEqual([
        { environmentId: 'personal-vm', workspaceId: 'project-a' },
      ]);
    });
  });

  it('invalidates readiness when current agent metadata changes environments', () => {
    let environmentId = 'personal-vm';
    mockAgentPermissions.mockImplementation((agentId?: string) =>
      agentId == null
        ? {}
        : {
            tools: [Tools.execute_code],
            agent: {
              id: agentId,
              stateful_code_sessions: true,
              code_environment_id: environmentId,
              tools: [Tools.execute_code],
            },
          },
    );
    mockAgentsConfig.mockReturnValue({
      agentsConfig: {
        capabilities: ['execute_code', 'stateful_code_sessions'],
        statefulCodeSessions: {
          environments: [
            { id: 'personal-vm', type: 'attached' },
            { id: 'team-vm', type: 'attached' },
          ],
        },
      },
    });
    mockStatus.mockImplementation((ids: string[]) =>
      ids.map((id) => ({
        data: {
          environmentId: id,
          status: 'ready',
          workspaces: [{ id: id === 'personal-vm' ? 'project-a' : 'project-b' }],
        },
        isLoading: false,
        isError: false,
      })),
    );
    const saved = { environmentId: 'personal-vm', workspaceId: 'project-a' };
    const { result, rerender } = renderHook(() => useCodeWorkspace(conversation([saved])));
    expect(result.current.canSubmit).toBe(true);

    environmentId = 'team-vm';
    rerender();

    expect(result.current.state).toBe('choose');
    expect(result.current.canSubmit).toBe(false);
    expect(result.current.resolveSubmission([saved])).toBeUndefined();
  });

  it('rejects a status response for a different environment', () => {
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'another-vm',
          status: 'ready',
          statefulWorkspace: true,
          workspaces: [{ id: 'project-a' }],
        },
        isLoading: false,
        isError: false,
      },
    ]);

    const { result } = renderHook(() => useCodeWorkspace(conversation()));

    expect(result.current.state).toBe('unavailable');
    expect(result.current.selections).toBeUndefined();
  });

  it('blocks sending when the agent-selected environment is not accessible', () => {
    mockAgentsConfig.mockReturnValue({
      agentsConfig: {
        capabilities: ['execute_code', 'stateful_code_sessions'],
        statefulCodeSessions: { environments: [] },
      },
    });

    const { result } = renderHook(() => useCodeWorkspace(conversation()));

    expect(result.current.required).toBe(true);
    expect(result.current.state).toBe('unavailable');
    expect(result.current.selections).toBeUndefined();
    expect(mockStatus).toHaveBeenCalledWith([], false, {
      notifyOnChangeProps: ['data', 'isLoading', 'isError'],
    });
  });

  it('does not gate a non-agent conversation', () => {
    const { result } = renderHook(() =>
      useCodeWorkspace({ ...conversation(), endpoint: EModelEndpoint.openAI }),
    );

    expect(result.current.required).toBe(false);
    expect(result.current.state).toBe('not_required');
    expect(result.current.canSubmit).toBe(true);
    expect(result.current.resolveSubmission()).toEqual({});
  });

  it('requires an explicit choice when reachable agents disagree on one machine', () => {
    const primary = {
      ...mockAgentPermissions().agent,
      code_workspace_id: 'project-a',
      subagents: { enabled: true, agent_ids: ['child'] },
    };
    mockAgentPermissions.mockImplementation((id?: string) => ({
      agent: id === 'agent_primary' ? primary : undefined,
    }));
    mockAgentsMap.mockReturnValue({
      child: {
        id: 'child',
        stateful_code_sessions: true,
        code_environment_id: 'personal-vm',
        code_workspace_id: 'project-b',
        tools: [Tools.execute_code],
      },
    });
    const { result } = renderHook(() =>
      useCodeWorkspace({ ...conversation(), conversationId: 'new' }),
    );
    expect(result.current.state).toBe('choose');
    expect(result.current.canSubmit).toBe(true);
    expect(
      result.current.resolveSubmission(
        [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
        'attached',
      ),
    ).toEqual({
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }],
    });
  });

  it.each(['subagent', 'handoff'])('collects every attached environment through %s', (kind) => {
    const primary = {
      id: 'agent_primary',
      stateful_code_sessions: true,
      code_environment_id: 'personal-vm',
      tools: [Tools.execute_code],
      subagents: { enabled: true, agent_ids: ['child'] },
      ...(kind === 'handoff'
        ? {
            subagents: { enabled: false, agent_ids: [] },
            edges: [{ from: 'agent_primary', to: 'child', edgeType: 'handoff' }],
          }
        : {}),
    };
    mockAgentPermissions.mockImplementation((id?: string) => ({
      agent: id === 'agent_primary' ? primary : undefined,
      tools: id === 'agent_primary' ? primary.tools : undefined,
    }));
    mockAgentsMap.mockReturnValue({
      child: {
        id: 'child',
        stateful_code_sessions: true,
        code_environment_id: 'team-vm',
        tools: [Tools.execute_code],
      },
    });
    mockAgentsConfig.mockReturnValue({
      agentsConfig: {
        capabilities: ['execute_code', 'stateful_code_sessions'],
        statefulCodeSessions: {
          environments: [
            { id: 'personal-vm', type: 'attached', baseURL: 'https://one.example.com' },
            { id: 'team-vm', type: 'attached', baseURL: 'https://two.example.com' },
          ],
        },
      },
    });
    mockStatus.mockReturnValue([
      {
        data: {
          environmentId: 'personal-vm',
          status: 'ready',
          statefulWorkspace: true,
          workspaces: [{ id: 'project-a' }],
        },
        isLoading: false,
        isError: false,
      },
      {
        data: {
          environmentId: 'team-vm',
          status: 'ready',
          statefulWorkspace: true,
          workspaces: [{ id: 'project-b' }],
        },
        isLoading: false,
        isError: false,
      },
    ]);

    const { result } = renderHook(() => useCodeWorkspace(conversation()));

    expect(result.current.state).toBe('ready');
    expect(result.current.selections).toEqual([
      { environmentId: 'personal-vm', workspaceId: 'project-a' },
      { environmentId: 'team-vm', workspaceId: 'project-b' },
    ]);
  });
});
