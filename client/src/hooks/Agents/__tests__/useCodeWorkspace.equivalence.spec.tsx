import { renderHook } from '@testing-library/react';
import { resolveCodeWorkspace } from '@librechat/chat';
import { EModelEndpoint, Tools } from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TConversation,
  TStartupConfig,
  CodeEnvironmentMode,
  CodeWorkspaceSelection,
} from 'librechat-data-provider';
import type { CodeEnvironmentStatusSnapshot, CodeWorkspaceInputs } from '@librechat/chat';
import type { CodeEnvironmentReconciliation } from '~/store/codeEnvironmentReconciliation';
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

type StatefulCodeSessions = TConfig['statefulCodeSessions'];

interface Fixture {
  conversation: TConversation;
  addedConversation?: TConversation;
  startupConfig: Partial<TStartupConfig>;
  statefulCodeSessions: StatefulCodeSessions;
  capabilities: string[];
  canRunCode?: boolean;
  agents: Record<string, Agent>;
  agentsMap?: Record<string, Agent>;
  statuses: Record<string, CodeEnvironmentStatusSnapshot>;
  recovery?: CodeEnvironmentReconciliation;
  replacingDecision?: boolean;
  /** The fixture must offer machine options, so the groups are not vacuously equal. */
  machineChoice?: boolean;
  /** Pins each fixture to the scenario it names, so a drifted fixture fails loudly. */
  expected: { state: string; canSubmit: boolean };
}

const personal = {
  id: 'personal-vm',
  name: 'Personal VM',
  type: 'attached' as const,
  baseURL: 'https://code.example.com',
};
const runtime = { id: 'runtime-vm', name: 'Runtime VM', type: 'attached' as const };
const stored: CodeWorkspaceSelection = { environmentId: 'personal-vm', workspaceId: 'project-a' };
const allowedEnvironments: NonNullable<StatefulCodeSessions>['allowedEnvironments'] = ['user'];
const capabilities = ['execute_code', 'stateful_code_sessions'];

const readyStatus = (id: string): CodeEnvironmentStatusSnapshot => ({
  data: {
    environmentId: id,
    status: 'ready',
    workspaces: [{ id: 'project-a', name: 'Project A' }],
  },
  isLoading: false,
  isError: false,
});

const agent = (overrides: Partial<Agent> & Pick<Agent, 'id'>): Agent => ({
  name: null,
  description: null,
  created_at: 0,
  avatar: null,
  provider: EModelEndpoint.openAI,
  model: null,
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
  stateful_code_sessions: true,
  tools: [Tools.execute_code],
  code_environment_id: 'personal-vm',
  ...overrides,
});

type ChatOverrides = Omit<
  Partial<TConversation>,
  'conversationId' | 'endpoint' | 'title' | 'createdAt' | 'updatedAt'
> & {
  conversationId?: string;
};

const chat = (overrides: ChatOverrides = {}): TConversation => ({
  title: null,
  createdAt: '',
  updatedAt: '',
  conversationId: 'saved',
  endpoint: EModelEndpoint.agents,
  agent_id: 'agent_primary',
  ...overrides,
});

const inheritanceFixture = (): Fixture => {
  const reviewer = agent({
    id: 'reviewer',
    name: 'PR Reviewer',
    code_environment_ids: ['runtime-vm'],
  });
  const lia = agent({
    id: 'agent_primary',
    name: 'Lia',
    code_environment_ids: ['runtime-vm'],
    subagents: { enabled: true, agent_ids: ['reviewer'] },
  });
  /** An older client sealed only the primary's choice; the reviewer must follow it. */
  const sealed: CodeWorkspaceSelection = {
    environmentId: 'runtime-vm',
    workspaceId: 'project-a',
    agentIds: ['agent_primary'],
  };
  return {
    conversation: chat({ codeEnvironmentMode: 'attached', codeWorkspaces: [sealed] }),
    startupConfig: { codeEnvironmentDecisionVersion: 1, codeWorkspaceInheritanceVersion: 1 },
    statefulCodeSessions: {
      allowedEnvironments,
      allowEnvironmentSelection: true,
      environments: [personal, runtime],
    },
    capabilities,
    agents: { agent_primary: lia },
    agentsMap: { reviewer },
    statuses: {
      'personal-vm': readyStatus('personal-vm'),
      'runtime-vm': readyStatus('runtime-vm'),
    },
    expected: { state: 'ready', canSubmit: true },
  };
};

const fixtures: Array<[string, () => Fixture]> = [
  [
    'recovery pending',
    () => ({
      conversation: chat({ codeEnvironmentMode: 'attached', codeWorkspaces: [stored] }),
      startupConfig: { codeEnvironmentDecisionVersion: 1 },
      statefulCodeSessions: { allowedEnvironments, environments: [personal] },
      capabilities,
      agents: { agent_primary: agent({ id: 'agent_primary' }) },
      statuses: { 'personal-vm': readyStatus('personal-vm') },
      recovery: {
        request: {
          conversationId: 'saved',
          attempted: { codeEnvironmentMode: 'attached', codeWorkspaces: [stored] },
        },
        status: 'pending',
        token: Symbol('recovery'),
      },
      expected: { state: 'ready', canSubmit: false },
    }),
  ],
  [
    'replacing decision in flight',
    () => ({
      conversation: chat({ codeEnvironmentMode: 'attached', codeWorkspaces: [stored] }),
      startupConfig: {
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeEnvironmentTransitionVersion: 2,
      },
      statefulCodeSessions: { allowedEnvironments, environments: [personal] },
      capabilities,
      agents: { agent_primary: agent({ id: 'agent_primary' }) },
      statuses: { 'personal-vm': readyStatus('personal-vm') },
      replacingDecision: true,
      expected: { state: 'ready', canSubmit: false },
    }),
  ],
  [
    'inherited workspace with an added agent',
    () => {
      const reviewer = agent({
        id: 'agent_added',
        name: 'PR Reviewer',
        code_environment_ids: ['runtime-vm'],
      });
      const lia = agent({
        id: 'agent_primary',
        name: 'Lia',
        code_environment_ids: ['runtime-vm'],
        subagents: { enabled: true, agent_ids: ['agent_added'] },
      });
      const sealed: CodeWorkspaceSelection = {
        environmentId: 'runtime-vm',
        workspaceId: 'project-a',
        agentIds: ['agent_primary'],
      };
      return {
        conversation: chat({ codeEnvironmentMode: 'attached', codeWorkspaces: [sealed] }),
        addedConversation: chat({ conversationId: 'new', agent_id: 'agent_added' }),
        startupConfig: {
          codeEnvironmentDecisionVersion: 1,
          codeEnvironmentMoveVersion: 1,
          codeEnvironmentTransitionVersion: 2,
          codeWorkspaceInheritanceVersion: 1,
        },
        statefulCodeSessions: {
          allowedEnvironments,
          allowEnvironmentSelection: true,
          environments: [personal, runtime],
        },
        capabilities,
        agents: { agent_primary: lia, agent_added: reviewer },
        agentsMap: { agent_added: reviewer },
        statuses: {
          'personal-vm': readyStatus('personal-vm'),
          'runtime-vm': readyStatus('runtime-vm'),
        },
        expected: { state: 'relocatable', canSubmit: false },
      };
    },
  ],
  ['ready inheritance: a subagent follows the primary onto its chosen machine', inheritanceFixture],
  [
    'undecided new chat choosing between two machines',
    () => ({
      conversation: chat({ conversationId: 'new' }),
      startupConfig: { codeEnvironmentDecisionVersion: 1 },
      statefulCodeSessions: {
        allowedEnvironments,
        allowEnvironmentSelection: true,
        environments: [personal, runtime],
      },
      capabilities,
      agents: {
        agent_primary: agent({ id: 'agent_primary', code_environment_ids: ['runtime-vm'] }),
      },
      statuses: {
        'personal-vm': readyStatus('personal-vm'),
        'runtime-vm': readyStatus('runtime-vm'),
      },
      machineChoice: true,
      expected: { state: 'ready', canSubmit: true },
    }),
  ],
  [
    'not required (no code tools)',
    () => ({
      conversation: chat({ conversationId: 'new' }),
      startupConfig: { codeEnvironmentDecisionVersion: 1 },
      statefulCodeSessions: { allowedEnvironments, environments: [personal] },
      capabilities,
      agents: {
        agent_primary: agent({ id: 'agent_primary', tools: [], stateful_code_sessions: false }),
      },
      statuses: { 'personal-vm': readyStatus('personal-vm') },
      expected: { state: 'not_required', canSubmit: true },
    }),
  ],
  [
    'ready attached selection',
    () => ({
      conversation: chat({ conversationId: 'new', codeWorkspaces: [stored] }),
      startupConfig: { codeEnvironmentDecisionVersion: 1 },
      statefulCodeSessions: { allowedEnvironments, environments: [personal] },
      capabilities,
      agents: { agent_primary: agent({ id: 'agent_primary' }) },
      statuses: { 'personal-vm': readyStatus('personal-vm') },
      expected: { state: 'ready', canSubmit: true },
    }),
  ],
  [
    'without_attached locked chat',
    () => ({
      conversation: chat({ codeEnvironmentMode: 'without_attached' }),
      startupConfig: {
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeEnvironmentTransitionVersion: 2,
      },
      statefulCodeSessions: { allowedEnvironments, environments: [personal] },
      capabilities,
      agents: { agent_primary: agent({ id: 'agent_primary' }) },
      statuses: { 'personal-vm': readyStatus('personal-vm') },
      expected: { state: 'without_attached', canSubmit: true },
    }),
  ],
  [
    'sealed selection on a machine the agent left (move transition)',
    () => ({
      conversation: chat({
        codeEnvironmentMode: 'attached',
        codeWorkspaces: [
          { environmentId: 'old-vm', workspaceId: 'project-a', agentIds: ['agent_primary'] },
        ],
      }),
      startupConfig: {
        codeEnvironmentDecisionVersion: 1,
        codeEnvironmentMoveVersion: 1,
        codeEnvironmentTransitionVersion: 2,
      },
      statefulCodeSessions: { allowedEnvironments, environments: [personal] },
      capabilities,
      agents: { agent_primary: agent({ id: 'agent_primary' }) },
      statuses: { 'personal-vm': readyStatus('personal-vm') },
      expected: { state: 'relocatable', canSubmit: false },
    }),
  ],
];

function applyHookMocks(fixture: Fixture) {
  mockPreference.mockReset();
  mockRememberPreference.mockReset();
  mockAccess.mockReturnValue(fixture.canRunCode ?? true);
  mockReplacingDecision.mockReturnValue(fixture.replacingDecision ?? false);
  mockRecovery.mockReturnValue(fixture.recovery);
  mockStartupConfig.mockReturnValue(fixture.startupConfig);
  mockAgentPermissions.mockImplementation((agentId?: string | null) => ({
    agent: agentId == null ? undefined : fixture.agents[agentId],
  }));
  mockAgentsMap.mockReturnValue(fixture.agentsMap ?? {});
  mockAgentsConfig.mockReturnValue({
    agentsConfig: {
      capabilities: fixture.capabilities,
      statefulCodeSessions: fixture.statefulCodeSessions,
    },
  });
  mockStatus.mockImplementation((ids: string[]) => ids.map((id) => fixture.statuses[id]));
}

function toInputs(fixture: Fixture): CodeWorkspaceInputs {
  const { conversation, addedConversation } = fixture;
  return {
    conversation,
    addedConversation,
    primaryAgent: conversation.agent_id == null ? undefined : fixture.agents[conversation.agent_id],
    addedAgent:
      addedConversation?.agent_id == null ? undefined : fixture.agents[addedConversation.agent_id],
    agentsMap: fixture.agentsMap ?? {},
    statefulCodeSessions: fixture.statefulCodeSessions,
    startupConfig: fixture.startupConfig,
    canRunCode: fixture.canRunCode ?? true,
    capabilities: fixture.capabilities,
    configurationLoaded: true,
    recoveryPending: fixture.recovery != null,
    replacingDecision: fixture.replacingDecision ?? false,
    statuses: fixture.statuses,
    getPreferredWorkspace: mockPreference,
  };
}

function compare(fixture: Fixture) {
  applyHookMocks(fixture);
  const { result } = renderHook(() =>
    useCodeWorkspace(fixture.conversation, fixture.addedConversation),
  );
  const hook = result.current;
  const derived = resolveCodeWorkspace(toInputs(fixture));

  expect(hook.state).toBe(derived.state);
  expect(hook.canSubmit).toBe(derived.canSubmit);
  expect(hook.required).toBe(derived.required);
  expect(hook.locked).toBe(derived.locked);
  expect(hook.visible).toBe(derived.visible);
  expect(hook.supportsEnvironmentDecisions).toBe(derived.supportsEnvironmentDecisions);
  expect(hook.mode).toBe(derived.mode);
  expect(hook.transition).toEqual(derived.transition);
  expect(hook.selections).toEqual(derived.selections);
  expect(hook.environments).toEqual(derived.environments);
  expect(hook.machineOptions).toEqual(derived.machineOptions);
  expect(hook.machineOptionGroups).toEqual(derived.machineOptionGroups);
  if (fixture.machineChoice) expect(hook.machineOptionGroups?.length).toBeGreaterThan(0);
  expect(hook.machineChoiceOwners).toEqual(derived.machineChoiceOwners);
  expect(hook.fixedMachineIds).toEqual(derived.fixedMachineIds);

  /** The snapshot the hook exposes for a send resolves to what the hook itself reports. */
  const exposed = resolveCodeWorkspace(hook.readInputs());
  expect(exposed.state).toBe(hook.state);
  expect(exposed.canSubmit).toBe(hook.canSubmit);
  expect(exposed.required).toBe(hook.required);
  expect(exposed.locked).toBe(hook.locked);
  expect(exposed.visible).toBe(hook.visible);
  expect(exposed.supportsEnvironmentDecisions).toBe(hook.supportsEnvironmentDecisions);
  expect(exposed.mode).toBe(hook.mode);
  expect(exposed.transition).toEqual(hook.transition);
  expect(exposed.selections).toEqual(hook.selections);
  expect(exposed.environments).toEqual(hook.environments);
  expect(exposed.machineOptions).toEqual(hook.machineOptions);
  expect(exposed.machineOptionGroups).toEqual(hook.machineOptionGroups);
  expect(exposed.machineChoiceOwners).toEqual(hook.machineChoiceOwners);
  expect(exposed.fixedMachineIds).toEqual(hook.fixedMachineIds);

  const explicit: CodeWorkspaceSelection[] = [stored];
  const candidates: Array<[CodeWorkspaceSelection[] | undefined, CodeEnvironmentMode?]> = [
    [fixture.conversation.codeWorkspaces, fixture.conversation.codeEnvironmentMode],
    [undefined, undefined],
    [explicit, 'attached'],
    [explicit, undefined],
    [undefined, 'without_attached'],
  ];
  for (const [selections, mode] of candidates) {
    expect(hook.resolveSubmission(selections, mode)).toEqual(
      derived.resolveSubmission(selections, mode),
    );
    expect(hook.resolveSelections(selections)).toEqual(derived.resolveSelections(selections));
  }

  for (const environment of derived.environments) {
    const { id } = environment.environment;
    hook.rememberSelection({ environmentId: id, workspaceId: 'project-a' });
    expect(mockRememberPreference).toHaveBeenLastCalledWith(id, 'project-a', [
      ...(derived.preferenceAgentIds.get(id) ?? []),
    ]);
  }
  return { hook, derived };
}

describe('useCodeWorkspace and resolveCodeWorkspace stay equivalent', () => {
  it.each(fixtures)('%s', (_name, build) => {
    const fixture = build();
    const { hook } = compare(fixture);
    expect({ state: hook.state, canSubmit: hook.canSubmit }).toEqual(fixture.expected);
  });

  it('inheritance changes the outcome, and both chains follow it', () => {
    const on = compare(inheritanceFixture());
    const off = compare({
      ...inheritanceFixture(),
      startupConfig: { codeEnvironmentDecisionVersion: 1 },
    });
    expect(on.hook.environments.map(({ environment }) => environment.id)).toEqual(['runtime-vm']);
    expect(on.hook.environments[0].requiredBy).toEqual(
      expect.arrayContaining([{ id: 'reviewer', name: 'PR Reviewer' }]),
    );
    expect(on.derived.environments.map(({ environment }) => environment.id)).toEqual([
      'runtime-vm',
    ]);
    expect({ state: on.hook.state, canSubmit: on.hook.canSubmit }).toEqual({
      state: 'ready',
      canSubmit: true,
    });
    /** Without inheritance the reviewer needs its own default machine, which has no workspace. */
    expect(off.hook.environments.map(({ environment }) => environment.id)).toEqual([
      'personal-vm',
      'runtime-vm',
    ]);
    expect({ state: off.hook.state, canSubmit: off.hook.canSubmit }).toEqual({
      state: 'choose',
      canSubmit: false,
    });
  });
});
