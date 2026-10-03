import { SkillsScope } from 'librechat-data-provider';
import { getLazySubagentConfigId } from './lazySubagents';

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
