/**
 * @jest-environment jsdom
 */
import { Constants, EModelEndpoint, type Agent } from 'librechat-data-provider';
import type {
  AgentCreateParams,
  AgentUpdateParams,
  AgentModelParameters,
} from 'librechat-data-provider';
import type { FieldNamesMarkedBoolean } from 'react-hook-form';
import type { AgentForm } from '~/common';
import {
  composeAgentUpdatePayload,
  persistAvatarChanges,
  isAvatarUploadOnlyDirty,
  hasPersistedDirtyFields,
  mayHavePersistedChange,
  shouldSyncSavedStarters,
  isSavedAgentOption,
  computeInstructionsPromptChanged,
} from '../AgentPanel';

test('the create identity contract excludes the update-only clear sentinel', () => {
  const createAcceptsNull: null extends AgentCreateParams['git_identity'] ? true : false = false;
  const updateAcceptsNull: null extends AgentUpdateParams['git_identity'] ? true : false = true;
  expect(createAcceptsNull).toBe(false);
  expect(updateAcceptsNull).toBe(true);
});

const createForm = (): AgentForm => ({
  agent: undefined,
  id: 'agent_123',
  name: 'Agent',
  description: null,
  instructions: null,
  instructionsSource: 'inline',
  instructionsPrompt: null,
  model: 'gpt-4',
  model_parameters: {
    temperature: 1,
    maxContextTokens: null,
    max_context_tokens: null,
    max_output_tokens: null,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  },
  tools: [],
  provider: 'openai',
  agent_ids: [],
  edges: [],
  end_after_tools: false,
  hide_sequential_outputs: false,
  recursion_limit: undefined,
  category: 'general',
  support_contact: undefined,
  artifacts: '',
  execute_code: false,
  file_search: false,
  web_search: false,
  avatar_file: null,
  avatar_preview: '',
  avatar_action: null,
});

describe('composeAgentUpdatePayload', () => {
  it('preserves a legacy chain on unrelated saves and sends explicit removal', () => {
    const form = createForm();
    form.agent_ids = ['first', 'second'];
    expect(
      composeAgentUpdatePayload(form, 'agent_123', undefined, {
        instructionsPromptChanged: false,
      }).payload.agent_ids,
    ).toEqual(['first', 'second']);
    form.agent_ids = [];
    expect(
      composeAgentUpdatePayload(form, 'agent_123', undefined, {
        instructionsPromptChanged: false,
      }).payload.agent_ids,
    ).toEqual([]);
  });
  it('omits unchanged unavailable machine choices but submits an explicit removal', () => {
    const form = createForm();
    form.agent = {
      ...({ id: 'agent_123', code_environment_ids: ['missing'] } as Agent),
      value: 'agent_123',
    };
    form.code_environment_ids = ['missing'];
    expect(
      composeAgentUpdatePayload(form, 'agent_123', undefined, {
        instructionsPromptChanged: false,
      }).payload.code_environment_ids,
    ).toBeUndefined();
    form.code_environment_ids = [];
    expect(
      composeAgentUpdatePayload(form, 'agent_123', undefined, {
        instructionsPromptChanged: false,
      }).payload.code_environment_ids,
    ).toEqual([]);
  });
  it('includes avatar: null when resetting a persistent agent', () => {
    const form = createForm();
    form.avatar_action = 'reset';

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.avatar).toBeNull();
  });

  it('omits avatar when resetting an ephemeral agent', () => {
    const form = createForm();
    form.avatar_action = 'reset';

    const { payload } = composeAgentUpdatePayload(form, Constants.EPHEMERAL_AGENT_ID, undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.avatar).toBeUndefined();
  });

  it('never adds avatar during upload actions', () => {
    const form = createForm();
    form.avatar_action = 'upload';

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.avatar).toBeUndefined();
  });

  it('forces stateful_code_sessions off when execute_code is disabled', () => {
    const form = createForm();
    form.execute_code = false;
    form.stateful_code_sessions = true;

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.stateful_code_sessions).toBe(false);
  });

  it('removes programmatic callers when execute_code is disabled', () => {
    const form = createForm();
    form.execute_code = false;
    form.tool_options = {
      search: { allowed_callers: ['code_execution'], defer_loading: true },
    };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.tool_options).toEqual({ search: { defer_loading: true } });
  });

  it('preserves programmatic callers when execute_code is enabled', () => {
    const form = createForm();
    form.execute_code = true;
    form.tool_options = {
      search: { allowed_callers: ['code_execution'] },
    };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.tool_options).toEqual({
      search: { allowed_callers: ['code_execution'] },
    });
  });

  it('preserves stateful_code_sessions when execute_code is enabled', () => {
    const form = createForm();
    form.execute_code = true;
    form.stateful_code_sessions = true;

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.stateful_code_sessions).toBe(true);
  });

  it('defaults stateful environments to the scalable user scope', () => {
    const form = createForm();
    form.execute_code = true;
    form.stateful_code_sessions = true;

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.stateful_code_environment).toBe('user');
  });

  it('preserves an explicit stateful environment scope', () => {
    const form = createForm();
    form.execute_code = true;
    form.stateful_code_sessions = true;
    form.stateful_code_environment = 'agent-user';

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.stateful_code_environment).toBe('agent-user');
  });

  it('sends a deployment-default reset for an existing agent', () => {
    const form = createForm();
    form.code_environment_id = null;

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.code_environment_id).toBeNull();
  });

  it('omits a deployment-default reset when creating an agent', () => {
    const form = createForm();
    form.code_environment_id = null;

    const { payload } = composeAgentUpdatePayload(form, undefined, undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.code_environment_id).toBeUndefined();
  });

  it('normalizes a configured Git identity', () => {
    const form = createForm();
    form.git_identity = { name: '  Coding Agent  ', email: '  agent@example.com  ' };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.git_identity).toEqual({
      name: 'Coding Agent',
      email: 'agent@example.com',
    });
  });

  it('clears an empty Git identity when updating an agent', () => {
    const form = createForm();
    form.git_identity = { name: '', email: '' };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.git_identity).toBeNull();
  });

  it('does not turn a partially filled Git identity into a clear operation', () => {
    const form = createForm();
    form.git_identity = { name: 'Coding Agent', email: '' };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.git_identity).toEqual({ name: 'Coding Agent', email: '' });
  });

  it('omits an empty Git identity when creating an agent', () => {
    const form = createForm();
    form.git_identity = { name: '', email: '' };

    const { payload } = composeAgentUpdatePayload(form, undefined, undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.git_identity).toBeUndefined();
  });

  it('persists standalone skill authoring separately from catalog access', () => {
    const form = createForm();
    form.skills = [];
    form.skills_enabled = false;
    form.skill_authoring_enabled = true;

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.skills_enabled).toBe(false);
    expect(payload.skill_authoring_enabled).toBe(true);
  });

  it.each([
    [EModelEndpoint.anthropic, 'claude-opus-5-5'],
    [EModelEndpoint.bedrock, 'global.anthropic.claude-opus-5-5'],
  ])(
    'preserves model-hidden %s settings when saving without opening the model panel',
    (provider, model) => {
      const form = createForm();
      form.provider = provider;
      form.model = model;
      const stored = {
        maxContextTokens: null,
        max_context_tokens: null,
        max_output_tokens: null,
        top_p: null,
        frequency_penalty: null,
        presence_penalty: null,
        thinking: false,
        thinkingBudget: 4096,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
      };
      form.model_parameters = stored;
      const { payload } = composeAgentUpdatePayload(
        form,
        'agent_123',
        { endpointsConfig: {}, startupConfig: {} },
        { instructionsPromptChanged: false },
      );
      expect(payload.model_parameters).toEqual(form.model_parameters);
      expect(JSON.parse(JSON.stringify(payload)).model_parameters).toEqual(form.model_parameters);
    },
  );

  it('prunes dropped model parameters during submission', () => {
    const form = createForm();
    form.provider = EModelEndpoint.openAI;
    form.model_parameters.model = 'deployment-override';

    const { payload } = composeAgentUpdatePayload(
      form,
      'agent_123',
      {
        endpointsConfig: {},
        startupConfig: {
          endpointsDropParamsMap: { [EModelEndpoint.openAI]: ['topP'] },
        },
      },
      { instructionsPromptChanged: false },
    );

    expect(payload.model_parameters?.temperature).toBe(1);
    expect(payload.model_parameters?.top_p).toBeUndefined();
    expect(payload.model_parameters?.model).toBe('deployment-override');
  });

  it('preserves model parameters during submission when the provider schema is unknown', () => {
    const form = createForm();
    form.provider = 'removed-provider';

    const { payload } = composeAgentUpdatePayload(
      form,
      'agent_123',
      { endpointsConfig: {}, startupConfig: {} },
      { instructionsPromptChanged: false },
    );

    expect(payload.model_parameters).toEqual(form.model_parameters);
  });

  it('sends edited starters trimmed and without blanks', () => {
    const form = createForm();
    form.agent = { conversation_starters: ['Plan my week'] } as AgentForm['agent'];
    form.conversation_starters = ['  Plan my week ', '', '   ', 'Summarize'];

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.conversation_starters).toEqual(['Plan my week', 'Summarize']);
  });

  it('sends an empty list so removing every starter clears them', () => {
    const form = createForm();
    form.agent = { conversation_starters: ['Plan my week'] } as AgentForm['agent'];
    form.conversation_starters = [];

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.conversation_starters).toEqual([]);
  });

  it('leaves untouched stored starters alone, even past the builder cap', () => {
    const stored = [' Padded ', 'Two', 'Three', 'Four', 'Five', 'Six'];
    const form = createForm();
    form.agent = { conversation_starters: stored } as AgentForm['agent'];
    form.conversation_starters = [...stored];
    form.name = 'Renamed';

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.conversation_starters).toBeUndefined();
  });

  it('omits starters when the form never loaded them', () => {
    const { payload } = composeAgentUpdatePayload(createForm(), 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.conversation_starters).toBeUndefined();
  });
});

describe('composeAgentUpdatePayload instructionsPrompt', () => {
  it('omits instructionsPrompt for an unlinked agent left in the default inline mode', () => {
    const form = createForm();

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload).not.toHaveProperty('instructionsPrompt');
  });

  it('omits instructionsPrompt when the link did not change', () => {
    const form = createForm();
    form.instructionsSource = 'prompt';
    form.instructionsPrompt = {
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'production' },
    };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload).not.toHaveProperty('instructionsPrompt');
  });

  it('sends the link with a Production selection when changed', () => {
    const form = createForm();
    form.instructionsSource = 'prompt';
    form.instructionsPrompt = {
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'production' },
    };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: true,
    });

    expect(payload.instructionsPrompt).toEqual({
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'production' },
    });
  });

  it('sends the link with an exact selection when a specific version is chosen', () => {
    const form = createForm();
    form.instructionsSource = 'prompt';
    form.instructionsPrompt = {
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'exact', promptId: 'prompt_7' },
    };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: true,
    });

    expect(payload.instructionsPrompt).toEqual({
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'exact', promptId: 'prompt_7' },
    });
  });

  it('sends null when switching a linked agent back to inline', () => {
    const form = createForm();
    form.instructionsSource = 'inline';
    form.instructionsPrompt = {
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'production' },
    };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: true,
    });

    expect(payload.instructionsPrompt).toBeNull();
  });

  it('never re-sends the restricted stub, even if a caller marks it changed', () => {
    const form = createForm();
    form.instructionsSource = 'prompt';
    form.instructionsPrompt = { source: 'native', restricted: true };

    const { payload } = composeAgentUpdatePayload(form, 'agent_123', undefined, {
      instructionsPromptChanged: true,
    });

    expect(payload.instructionsPrompt).toBeNull();
  });

  it('always sends the link on create, even when the changed flag is false', () => {
    /** A create has no `agent_id` and no stored value to diff against. Gating on the
     *  caller's changed flag here is how a new agent linked to the same group as
     *  whatever agent was last open in the panel ends up created with no link at all. */
    const form = createForm();
    form.instructionsSource = 'prompt';
    form.instructionsPrompt = {
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'production' },
    };

    const { payload } = composeAgentUpdatePayload(form, undefined, undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.instructionsPrompt).toEqual({
      source: 'native',
      groupId: 'group_1',
      selection: { type: 'production' },
    });
  });

  it('sends null on create for the default inline mode, even when the changed flag is false', () => {
    const form = createForm();

    const { payload } = composeAgentUpdatePayload(form, undefined, undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload).toHaveProperty('instructionsPrompt', null);
  });

  it('never sends the restricted stub on create either', () => {
    const form = createForm();
    form.instructionsSource = 'prompt';
    form.instructionsPrompt = { source: 'native', restricted: true };

    const { payload } = composeAgentUpdatePayload(form, undefined, undefined, {
      instructionsPromptChanged: false,
    });

    expect(payload.instructionsPrompt).toBeNull();
  });
});

describe('persistAvatarChanges', () => {
  it('returns false for ephemeral agents', async () => {
    const uploadAvatar = jest.fn();
    const result = await persistAvatarChanges({
      agentId: String(Constants.EPHEMERAL_AGENT_ID),
      avatarActionState: 'upload',
      avatarFile: new File(['avatar'], 'avatar.png', { type: 'image/png' }),
      uploadAvatar,
    });

    expect(result).toBe(false);
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('returns false when no upload is pending', async () => {
    const uploadAvatar = jest.fn();
    const result = await persistAvatarChanges({
      agentId: 'agent_123',
      avatarActionState: null,
      avatarFile: null,
      uploadAvatar,
    });

    expect(result).toBe(false);
    expect(uploadAvatar).not.toHaveBeenCalled();
  });

  it('uploads avatar when all prerequisites are met', async () => {
    const uploadAvatar = jest.fn().mockResolvedValue({} as Agent);
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' });

    const result = await persistAvatarChanges({
      agentId: 'agent_123',
      avatarActionState: 'upload',
      avatarFile: file,
      uploadAvatar,
    });

    expect(result).toBe(true);
    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    const callArgs = uploadAvatar.mock.calls[0][0];
    expect(callArgs.agent_id).toBe('agent_123');
    expect(callArgs.formData).toBeInstanceOf(FormData);
  });
});

describe('isAvatarUploadOnlyDirty', () => {
  it('detects avatar-only dirty state', () => {
    const dirtyFields = {
      avatar_action: true,
      avatar_preview: true,
    } as FieldNamesMarkedBoolean<AgentForm>;

    expect(isAvatarUploadOnlyDirty(dirtyFields)).toBe(true);
  });

  it('ignores agent field when checking dirty state', () => {
    const dirtyFields = {
      agent: { value: true } as any,
      avatar_file: true,
    } as FieldNamesMarkedBoolean<AgentForm>;

    expect(isAvatarUploadOnlyDirty(dirtyFields)).toBe(true);
  });

  it('returns false when other fields are dirty', () => {
    const dirtyFields = {
      name: true,
    } as FieldNamesMarkedBoolean<AgentForm>;

    expect(isAvatarUploadOnlyDirty(dirtyFields)).toBe(false);
  });
});

describe('hasPersistedDirtyFields', () => {
  it('returns false for an untouched form', () => {
    expect(hasPersistedDirtyFields(undefined)).toBe(false);
    expect(hasPersistedDirtyFields({} as FieldNamesMarkedBoolean<AgentForm>)).toBe(false);
  });

  it('returns false for an upload-only submission, which uses its own endpoint', () => {
    const dirtyFields = {
      avatar_action: true,
      avatar_preview: true,
    } as FieldNamesMarkedBoolean<AgentForm>;

    expect(hasPersistedDirtyFields(dirtyFields, 'upload')).toBe(false);
  });

  it('returns true for a reset-only submission, which is sent as avatar: null', () => {
    const dirtyFields = {
      avatar_action: true,
      avatar_preview: true,
    } as FieldNamesMarkedBoolean<AgentForm>;

    expect(hasPersistedDirtyFields(dirtyFields, 'reset')).toBe(true);
  });

  it('returns true for an edit the update endpoint persists', () => {
    const dirtyFields = {
      avatar_action: true,
      tools: true,
    } as unknown as FieldNamesMarkedBoolean<AgentForm>;

    expect(hasPersistedDirtyFields(dirtyFields)).toBe(true);
  });

  it('ignores the agent field, which tracks selection rather than an edit', () => {
    const dirtyFields = {
      agent: { value: true },
    } as unknown as FieldNamesMarkedBoolean<AgentForm>;

    expect(hasPersistedDirtyFields(dirtyFields)).toBe(false);
  });
});

describe('mayHavePersistedChange', () => {
  const agent = (overrides: Partial<Agent> = {}): Agent =>
    ({
      id: 'agent_123',
      provider: 'openai',
      model: 'gpt-4',
      name: 'Agent',
      tools: ['a'],
      ...overrides,
    }) as Agent;

  it('returns true when anything needed for the comparison is missing', () => {
    /** Without the expanded agent the comparison cannot be trusted, and reporting no
     *  change for a save that did change is the worse error. */
    expect(mayHavePersistedChange(undefined, agent(), agent())).toBe(true);
    expect(mayHavePersistedChange({ name: 'Renamed' }, undefined, agent())).toBe(true);
    expect(mayHavePersistedChange({ name: 'Renamed' }, agent(), undefined)).toBe(true);
  });

  it('returns true when the stored agent came back changed', () => {
    expect(mayHavePersistedChange({ name: 'Renamed' }, agent(), agent({ name: 'Renamed' }))).toBe(
      true,
    );
  });

  it('returns true for a reset that cleared an avatar the agent was carrying', () => {
    const previous = agent({ avatar: { filepath: '/images/a.png', source: 'local' } });

    expect(mayHavePersistedChange({ avatar: null }, previous, agent({ avatar: null }))).toBe(true);
  });

  it('returns false when the server normalized the submission back to the stored value', () => {
    /** An MCP tool rejected by authorization, or a skill pruned because it no longer
     *  exists, is dropped server-side and nothing is persisted. */
    const stored = agent({ tools: ['a'], skills: ['keep'] });

    expect(
      mayHavePersistedChange(
        { tools: ['a', 'mcp_rejected'], skills: ['keep', 'deleted'] },
        stored,
        agent({ tools: ['a'], skills: ['keep'] }),
      ),
    ).toBe(false);
  });

  it('compares nested values rather than object identity', () => {
    const parameters = (temperature: number): AgentModelParameters => ({
      ...createForm().model_parameters,
      temperature,
    });
    const previous = agent({ model_parameters: parameters(1) });

    expect(
      mayHavePersistedChange(
        { model_parameters: parameters(1) },
        previous,
        agent({ model_parameters: parameters(1) }),
      ),
    ).toBe(false);
    expect(
      mayHavePersistedChange(
        { model_parameters: parameters(2) },
        previous,
        agent({ model_parameters: parameters(2) }),
      ),
    ).toBe(true);
  });

  it('ignores fields the submission did not carry', () => {
    expect(
      mayHavePersistedChange({ name: 'Agent' }, agent({ description: 'before' }), agent()),
    ).toBe(false);
  });
});

describe('shouldSyncSavedStarters', () => {
  const submitted = { agentId: 'agent_a', starters: ['  Plan my week', ''] };

  it('syncs when the rows still hold what the save sent for the same agent', () => {
    expect(shouldSyncSavedStarters(submitted, { ...submitted }, 'agent_a')).toBe(true);
  });

  it('keeps starter edits made while the save was in flight', () => {
    const current = { agentId: 'agent_a', starters: ['  Plan my week', 'Typed during save'] };
    expect(shouldSyncSavedStarters(submitted, current, 'agent_a')).toBe(false);
  });

  it('leaves the rows alone after switching to another agent during the save', () => {
    const current = { agentId: 'agent_b', starters: submitted.starters };
    expect(shouldSyncSavedStarters(submitted, current, 'agent_a')).toBe(false);
  });

  it('syncs a create once the form carries the new id, but not another agent', () => {
    const created = { agentId: '', starters: ['Hi'] };
    expect(shouldSyncSavedStarters(created, { agentId: '', starters: ['Hi'] }, 'agent_new')).toBe(
      true,
    );
    expect(
      shouldSyncSavedStarters(created, { agentId: 'agent_new', starters: ['Hi'] }, 'agent_new'),
    ).toBe(true);
    expect(
      shouldSyncSavedStarters(created, { agentId: 'agent_b', starters: ['Hi'] }, 'agent_new'),
    ).toBe(false);
  });

  it('does nothing without a submitted snapshot', () => {
    expect(shouldSyncSavedStarters(null, { agentId: 'agent_a', starters: [] }, 'agent_a')).toBe(
      false,
    );
  });
});

describe('isSavedAgentOption', () => {
  const option = { id: 'agent_b', conversation_starters: ['  B  '] } as AgentForm['agent'];

  it('merges a save into the option of the agent it was for', () => {
    expect(isSavedAgentOption(option, 'agent_b')).toBe(true);
  });

  it('keeps another agent selected while the save was in flight as its own baseline', () => {
    expect(isSavedAgentOption(option, 'agent_a')).toBe(false);
  });

  it('ignores a missing option', () => {
    expect(isSavedAgentOption(undefined, 'agent_a')).toBe(false);
  });
});

describe('computeInstructionsPromptChanged', () => {
  const link = {
    source: 'native' as const,
    groupId: 'group_1',
    selection: { type: 'production' as const },
  };
  const otherLink = {
    source: 'native' as const,
    groupId: 'group_2',
    selection: { type: 'production' as const },
  };
  const stub = { source: 'native' as const, restricted: true as const };

  it('is unchanged for an unlinked form matching an unlinked agent', () => {
    expect(computeInstructionsPromptChanged('inline', null, null)).toBe(false);
    expect(computeInstructionsPromptChanged('inline', null, undefined)).toBe(false);
  });

  it('is changed when switching from inline to a selected link', () => {
    expect(computeInstructionsPromptChanged('prompt', link, null)).toBe(true);
  });

  it('is changed when switching a linked agent back to inline', () => {
    expect(computeInstructionsPromptChanged('inline', null, link)).toBe(true);
  });

  it('is changed when picking a different link than the one loaded', () => {
    expect(computeInstructionsPromptChanged('prompt', otherLink, link)).toBe(true);
  });

  it('is unchanged when the form still carries the link exactly as loaded', () => {
    /** This is the case a stale `dirtyFields.instructionsPrompt` gets wrong: the field
     *  was dirtied by the save that set this link, but the value now matches what the
     *  server has, so nothing here warrants resending it. */
    expect(computeInstructionsPromptChanged('prompt', link, link)).toBe(false);
    expect(computeInstructionsPromptChanged('prompt', { ...link }, link)).toBe(false);
  });

  it('is unchanged for a restricted stub the editor cannot see, in either direction', () => {
    expect(computeInstructionsPromptChanged('prompt', stub, stub)).toBe(false);
    expect(computeInstructionsPromptChanged('prompt', stub, null)).toBe(false);
  });

  it('is changed when an editor with access replaces a restricted stub with a real link', () => {
    expect(computeInstructionsPromptChanged('prompt', link, stub)).toBe(true);
  });

  it('is changed when a restricted stub is switched to Inline, so the removal is sent', () => {
    /** Both sides resolve to `null` here (inline mode and the stub both do), so a diff
     *  of resolved values alone can't tell this apart from "still the stub, unchanged"
     *  above — the stub-aware branch has to settle it directly. */
    expect(computeInstructionsPromptChanged('inline', null, stub)).toBe(true);
    expect(computeInstructionsPromptChanged('inline', stub, stub)).toBe(true);
  });
});
