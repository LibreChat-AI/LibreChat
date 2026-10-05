import { ErrorTypes } from 'librechat-data-provider';
import { SkillsScope } from 'librechat-data-provider';
import type { CodeExecutionContext } from './execution';
import {
  guardUnavailableSubagent,
  getLazySubagentConfigId,
  createViewableSubagentLoader,
  createRoutedGraphMemberLoader,
  resolveSubagentCodeAvailability,
} from './lazySubagents';
import { CodeWorkspaceSelectionError } from '~/code/errors';

const agent = {
  id: 'child-agent',
  name: 'Child',
  description: 'Delegated work',
  provider: 'openAI',
  model: 'gpt-5',
  model_parameters: {
    temperature: 0,
    maxContextTokens: 128000,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: null,
    frequency_penalty: null,
    presence_penalty: null,
  },
  version: 4,
};

describe('getLazySubagentConfigId', () => {
  it('changes when initializer-relevant config changes', () => {
    const original = getLazySubagentConfigId(agent);
    const changed = getLazySubagentConfigId({
      ...agent,
      instructions: 'Use concise answers.',
    });

    expect(changed).not.toBe(original);
  });

  it('changes when model-advertised identity changes', () => {
    expect(getLazySubagentConfigId({ ...agent, name: 'Renamed child' })).not.toBe(
      getLazySubagentConfigId(agent),
    );
  });

  it('changes when the Git author identity changes', () => {
    expect(
      getLazySubagentConfigId({
        ...agent,
        git_identity: { name: 'First Agent', email: 'first@example.com' },
      }),
    ).not.toBe(
      getLazySubagentConfigId({
        ...agent,
        git_identity: { name: 'Second Agent', email: 'second@example.com' },
      }),
    );
  });

  it('is stable across key order and excludes secret values', () => {
    const first = getLazySubagentConfigId({
      ...agent,
      tool_kwargs: { retry: 2, access_token: 'first-secret' },
    });
    const second = getLazySubagentConfigId({
      ...agent,
      tool_kwargs: { access_token: 'second-secret', retry: 2 },
    });

    expect(second).toBe(first);
  });

  it('includes token-budget settings in the descriptor identity', () => {
    expect(getLazySubagentConfigId({ ...agent, tool_kwargs: { max_tokens: 1024 } })).not.toBe(
      getLazySubagentConfigId({ ...agent, tool_kwargs: { max_tokens: 2048 } }),
    );
  });

  it('includes the persisted version in the descriptor identity', () => {
    expect(getLazySubagentConfigId({ ...agent, version: 5 })).not.toBe(
      getLazySubagentConfigId(agent),
    );
  });

  it('changes when the linked instructions prompt changes, even at the same version', () => {
    const linkedA = {
      ...agent,
      instructionsPrompt: {
        source: 'native' as const,
        groupId: 'group-a',
        selection: { type: 'production' as const },
      },
    };
    const linkedB = {
      ...agent,
      instructionsPrompt: {
        source: 'native' as const,
        groupId: 'group-b',
        selection: { type: 'production' as const },
      },
    };

    // Same `version` on both sides reproduces a revert that restores an older link
    // without bumping the version number.
    expect(getLazySubagentConfigId(linkedA)).not.toBe(getLazySubagentConfigId(linkedB));
  });

  it('leaves the descriptor identity unchanged for an agent with no linked prompt', () => {
    const withoutLink = getLazySubagentConfigId(agent);
    const explicitlyUnset = getLazySubagentConfigId({ ...agent, instructionsPrompt: undefined });

    expect(explicitlyUnset).toBe(withoutLink);
  });

  it('changes when the persisted skill catalog scope changes', () => {
    expect(
      getLazySubagentConfigId({
        ...agent,
        skills_enabled: true,
        skills_scope: SkillsScope.none,
      }),
    ).not.toBe(
      getLazySubagentConfigId({
        ...agent,
        skills_enabled: true,
        skills_scope: SkillsScope.all,
      }),
    );
  });
});

describe('createViewableSubagentLoader', () => {
  it('reads and checks VIEW once per subagent, and hides what the principal cannot view', async () => {
    const getAgent = jest.fn(async (id: string) => (id === 'missing' ? null : { id }));
    const canView = jest.fn(async (candidate: { id: string }) => candidate.id !== 'hidden');
    const load = createViewableSubagentLoader({ getAgent, canView });

    await expect(Promise.all([load('child'), load('child')])).resolves.toEqual([
      { id: 'child' },
      { id: 'child' },
    ]);
    await expect(load('hidden')).resolves.toBeNull();
    await expect(load('missing')).resolves.toBeNull();
    expect(getAgent).toHaveBeenCalledTimes(3);
    expect(canView).toHaveBeenCalledTimes(2);
  });

  it('shares a failed read with every caller', async () => {
    const getAgent = jest.fn(async () => {
      throw new Error('transient read');
    });
    const load = createViewableSubagentLoader({ getAgent, canView: async () => true });
    await expect(load('child')).rejects.toThrow('transient read');
    await expect(load('child')).rejects.toThrow('transient read');
    expect(getAgent).toHaveBeenCalledTimes(1);
  });
});

describe('subagent code availability', () => {
  const context = { environmentId: 'vm', environmentType: 'attached' } as CodeExecutionContext;

  it('keeps the resolved route when the workspace is usable', async () => {
    await expect(
      resolveSubagentCodeAvailability({
        agentId: 'child',
        codeEnvAvailable: true,
        statefulCodeSessions: true,
        resolveContext: async () => context,
      }),
    ).resolves.toEqual({
      codeEnvAvailable: true,
      statefulCodeSessions: true,
      codeExecutionContext: context,
    });
  });

  it('reports a missing workspace instead of throwing, and turns code off', async () => {
    await expect(
      resolveSubagentCodeAvailability({
        agentId: 'child',
        codeEnvAvailable: true,
        statefulCodeSessions: true,
        resolveContext: async () => {
          throw new CodeWorkspaceSelectionError('required');
        },
      }),
    ).resolves.toEqual({
      codeEnvAvailable: false,
      statefulCodeSessions: false,
      codeWorkspaceUnavailable: 'required',
    });
  });

  it.each([new CodeWorkspaceSelectionError('locked'), new Error('not configured')])(
    'propagates %s',
    async (error) => {
      await expect(
        resolveSubagentCodeAvailability({
          agentId: 'child',
          codeEnvAvailable: true,
          statefulCodeSessions: true,
          resolveContext: async () => {
            throw error;
          },
        }),
      ).rejects.toBe(error);
    },
  );

  it('lists an unavailable subagent with the reason and never resolves it', async () => {
    const resolve = jest.fn(async () => 'config');
    const guarded = guardUnavailableSubagent({
      description: 'Reviews PRs.',
      codeWorkspaceUnavailable: 'missing',
      resolve,
    });
    expect(guarded.description).toContain('Unavailable in this conversation');
    await expect(guarded.resolve({})).rejects.toMatchObject({
      code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
      reason: 'missing',
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(guardUnavailableSubagent({ description: 'Reviews PRs.', resolve })).toEqual({
      description: 'Reviews PRs.',
      resolve,
    });
  });
});

describe('createRoutedGraphMemberLoader', () => {
  const signal = new AbortController().signal;
  type Deps = Parameters<typeof createRoutedGraphMemberLoader<{ id: string }, string>>[0];
  const setup = (overrides: Partial<Deps> = {}) => {
    const skipped = new Set<string>();
    const deps: Deps = {
      getShared: jest.fn((_memberId: string): string | undefined => undefined),
      isSkipped: jest.fn((memberId: string) => skipped.has(memberId)),
      skip: jest.fn((memberId: string) => {
        skipped.add(memberId);
      }),
      getAgent: jest.fn(async (memberId: string) => ({ id: memberId })),
      canView: jest.fn(async () => true),
      initialize: jest.fn(
        async ({ memberId, context }: { memberId: string; context: { executionId: string } }) =>
          `${memberId}@${context.executionId}`,
      ),
      isFatal: jest.fn(() => false),
      ...overrides,
    };
    return { deps, load: createRoutedGraphMemberLoader<{ id: string }, string>(deps) };
  };

  it('initializes a member as a child of the routed parent execution', async () => {
    const { deps, load } = setup();

    await expect(load('member', 'run-parent', signal)).resolves.toBe(
      'member@run-parent:graph:member',
    );
    expect(deps.initialize).toHaveBeenCalledWith({
      agent: { id: 'member' },
      memberId: 'member',
      context: { signal, parentRunId: 'run-parent', executionId: 'run-parent:graph:member' },
    });
  });

  it('reuses a shared member and never initializes a skipped or unviewable one', async () => {
    const shared = setup({ getShared: jest.fn(() => 'shared-config') });
    await expect(shared.load('member', 'run-parent', signal)).resolves.toBe('shared-config');
    expect(shared.deps.getAgent).not.toHaveBeenCalled();

    const hidden = setup({ canView: jest.fn(async () => false) });
    await expect(hidden.load('member', 'run-parent', signal)).resolves.toBeNull();
    await expect(hidden.load('member', 'run-other', signal)).resolves.toBeNull();
    expect(hidden.deps.getAgent).toHaveBeenCalledTimes(1);
    expect(hidden.deps.initialize).not.toHaveBeenCalled();
  });

  it('drops a member that fails to initialize unless the failure is fatal', async () => {
    const failure = new Error('tools failed to load');
    const recoverable = setup({ initialize: jest.fn().mockRejectedValue(failure) });
    await expect(recoverable.load('member', 'run-parent', signal)).resolves.toBeNull();

    const fatal = setup({
      initialize: jest.fn().mockRejectedValue(failure),
      isFatal: jest.fn(() => true),
    });
    await expect(fatal.load('member', 'run-parent', signal)).rejects.toBe(failure);

    const aborted = new AbortController();
    aborted.abort(new Error('canceled'));
    await expect(fatal.load('member', 'run-parent', aborted.signal)).rejects.toThrow('canceled');
  });
});
