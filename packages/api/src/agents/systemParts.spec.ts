import { Providers } from '@librechat/agents';
import {
  ContextPartKeys,
  listContextParts,
  contributeContext,
  assembleSystemPrompt,
  assembleAdditionalInstructions,
  sdkMovesDynamicInstructions,
} from './systemParts';
import type { ContextAgent } from './systemParts';

describe('contributeContext', () => {
  it('assembles parts in canonical order, whatever order they arrive in', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.skills, 'Skills');
    contributeContext(agent, ContextPartKeys.memoryGuard, 'Guard');
    contributeContext(agent, ContextPartKeys.project, 'Project');
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    expect(agent.additional_instructions).toBe('Project\n\nGuard\n\nArtifacts\n\nSkills');
  });

  it('replaces a part contributed twice instead of repeating it', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.project, 'Old project');
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    contributeContext(agent, ContextPartKeys.project, 'New project');
    expect(agent.additional_instructions).toBe('New project\n\nArtifacts');
  });

  it('keeps existing additional instructions as the agent part, ahead of the others', () => {
    const agent: ContextAgent = { additional_instructions: 'Own' };
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    expect(agent.contextParts).toEqual({ agent: 'Own', artifacts: 'Artifacts' });
    expect(agent.additional_instructions).toBe('Own\n\nArtifacts');
  });

  it('does not change agent copies made before the contribution', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    const copy = { ...agent };
    contributeContext(copy, ContextPartKeys.alwaysApplySkills, 'Skill');
    expect(agent.contextParts).toEqual({ artifacts: 'Artifacts' });
    expect(agent.additional_instructions).toBe('Artifacts');
    expect(copy.additional_instructions).toBe('Artifacts\n\nSkill');
  });

  it('rejects keys outside the registry and tool context map keys', () => {
    expect(() => contributeContext({}, 'unknown', 'x')).toThrow('Unknown system prompt part');
    expect(() => contributeContext({}, 'runtime:web_search', 'x')).toThrow(
      'Unknown system prompt part',
    );
  });
});

describe('assembleAdditionalInstructions', () => {
  it('leaves initialization parts untrimmed until request context is applied', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.project, 'Project\n');
    expect(agent.additional_instructions).toBe('Project\n');
    contributeContext(agent, ContextPartKeys.memory, 'Memory\n');
    expect(agent.additional_instructions).toBe('Project\n\nMemory');
  });

  it('trims once request context is applied, even when it adds nothing', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.project, ' Project\n');
    contributeContext(agent, ContextPartKeys.rag, undefined);
    expect(agent.contextParts).toEqual({ project: ' Project\n', rag: '' });
    expect(agent.additional_instructions).toBe('Project');
  });

  it('returns undefined when every part is empty', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.rag, '');
    contributeContext(agent, ContextPartKeys.memory, '  ');
    expect(agent.additional_instructions).toBeUndefined();
  });

  it('appends subagent parts after the request block as given', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.alwaysApplySkills, 'Skill\n');
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    contributeContext(agent, ContextPartKeys.memory, 'Memory');
    expect(agent.additional_instructions).toBe('Artifacts\n\nMemory\n\nSkill\n');
  });

  it('assembles the subset of parts a filter selects', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    contributeContext(agent, ContextPartKeys.rag, 'Retrieved');
    contributeContext(agent, ContextPartKeys.agentFiles, 'Files');
    expect(assembleAdditionalInstructions(agent, ({ kind }) => kind !== 'turn')).toBe(
      'Artifacts\n\nFiles',
    );
    expect(agent.additional_instructions).toBe('Artifacts\n\nRetrieved\n\nFiles');
    expect(assembleAdditionalInstructions(agent, ({ kind }) => kind === 'turn')).toBe('Retrieved');
  });
});

describe('listContextParts', () => {
  it('classifies every part and orders tool instructions first, runtime context last', () => {
    const agent: ContextAgent = {
      toolContextMap: { web_search: 'Search instructions', skipped: { not: 'text' } },
      dynamicToolContextMap: {
        queued_code_files: 'Queued',
        web_search: 'Started at',
        custom_tool: 'Custom',
      },
    };
    contributeContext(agent, ContextPartKeys.agentFiles, 'Files');
    contributeContext(agent, ContextPartKeys.rag, 'Retrieved');
    contributeContext(agent, ContextPartKeys.project, 'Project');
    expect(listContextParts(agent).map(({ key, kind }) => [key, kind])).toEqual([
      ['tool:web_search', 'static'],
      ['project', 'conversation'],
      ['rag', 'turn'],
      ['agent_files', 'static'],
      ['runtime:queued_code_files', 'turn'],
      ['runtime:web_search', 'conversation'],
      ['runtime:custom_tool', 'turn'],
    ]);
  });
});

describe('assembleSystemPrompt', () => {
  const stableContext = true;

  it('puts tool instructions before the agent instructions and runtime context after the tail with stableContext', () => {
    expect(
      assembleSystemPrompt(
        {
          instructions: 'Base',
          additional_instructions: 'Artifacts',
          toolContextMap: { web_search: 'Search instructions', empty: '' },
          dynamicToolContextMap: { web_search: 'Started at', execute_code: 'Files' },
        },
        { stableContext },
      ),
    ).toEqual({
      instructions: 'Search instructions\nBase',
      additional_instructions: 'Artifacts\nStarted at\nFiles',
    });
  });

  it('puts runtime context ahead of the tail without stableContext', () => {
    expect(
      assembleSystemPrompt({
        instructions: 'Base',
        additional_instructions: 'Artifacts',
        toolContextMap: { web_search: 'Search instructions' },
        dynamicToolContextMap: { web_search: 'Started at', execute_code: 'Files' },
      }),
    ).toEqual({
      instructions: 'Search instructions\nBase',
      additional_instructions: 'Started at\nFiles\nArtifacts',
    });
  });

  it('never moves parts without stableContext', () => {
    const agent: ContextAgent = { instructions: 'Base' };
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    contributeContext(agent, ContextPartKeys.rag, 'Retrieved');
    expect(assembleSystemPrompt(agent, { moveTurnPartsOnly: true })).toEqual({
      instructions: 'Base',
      additional_instructions: 'Artifacts\n\nRetrieved',
    });
  });

  it('handles missing parts', () => {
    expect(
      assembleSystemPrompt(
        { dynamicToolContextMap: { web_search: 'Started at' } },
        { stableContext },
      ),
    ).toEqual({ instructions: '', additional_instructions: 'Started at' });
    expect(assembleSystemPrompt({ additional_instructions: 'Artifacts' })).toEqual({
      instructions: '',
      additional_instructions: 'Artifacts',
    });
  });

  it('moves only per-turn parts when asked, keeping the rest with the instructions', () => {
    const agent: ContextAgent = {
      instructions: 'Base',
      dynamicToolContextMap: { web_search: 'Started at', queued_code_files: 'Queued' },
    };
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    contributeContext(agent, ContextPartKeys.agentFiles, 'Files');
    contributeContext(agent, ContextPartKeys.memory, 'Memory');
    contributeContext(agent, ContextPartKeys.rag, 'Retrieved\n');
    expect(assembleSystemPrompt(agent, { stableContext, moveTurnPartsOnly: true })).toEqual({
      instructions: 'Base\n\nArtifacts\n\nFiles\nStarted at',
      additional_instructions: 'Retrieved\n\n\nMemory\n\nQueued',
    });
    expect(assembleSystemPrompt(agent, { stableContext }).additional_instructions).toBe(
      'Artifacts\n\nRetrieved\n\n\nMemory\n\nFiles\nStarted at\nQueued',
    );
  });

  it('sends a runtime key it does not know with the per-turn parts', () => {
    const agent: ContextAgent = {
      instructions: 'Base',
      dynamicToolContextMap: { web_search: 'Started at', new_tool: 'Changes every turn' },
    };
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    expect(assembleSystemPrompt(agent, { stableContext, moveTurnPartsOnly: true })).toEqual({
      instructions: 'Base\n\nArtifacts\nStarted at',
      additional_instructions: 'Changes every turn',
    });
  });

  it('treats additional instructions without parts as stable', () => {
    expect(
      assembleSystemPrompt(
        { additional_instructions: ' Own\n' },
        { stableContext, moveTurnPartsOnly: true },
      ),
    ).toEqual({ instructions: 'Own', additional_instructions: '' });
  });

  it('takes the tail from the parts when additional_instructions is written directly', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    agent.additional_instructions = 'Written directly';
    expect(assembleSystemPrompt(agent, { stableContext }).additional_instructions).toBe(
      'Artifacts',
    );
    expect(assembleSystemPrompt(agent).additional_instructions).toBe('Artifacts');
  });
});

describe('sdkMovesDynamicInstructions', () => {
  it.each([Providers.ANTHROPIC, Providers.OPENROUTER])(
    'is true for %s with promptCache enabled',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, { promptCache: true })).toBe(true);
    },
  );

  it.each([Providers.ANTHROPIC, Providers.OPENROUTER])(
    'is false for %s without promptCache',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, {})).toBe(false);
      expect(sdkMovesDynamicInstructions(provider, { promptCache: false })).toBe(false);
      expect(sdkMovesDynamicInstructions(provider, { promptCache: 'true' })).toBe(false);
      expect(sdkMovesDynamicInstructions(provider, undefined)).toBe(false);
    },
  );

  it.each([Providers.OPENAI, Providers.BEDROCK, Providers.GOOGLE, Providers.AZURE, 'custom'])(
    'is false for %s even with promptCache',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, { promptCache: true })).toBe(false);
    },
  );

  it('is false without a provider', () => {
    expect(sdkMovesDynamicInstructions(undefined, { promptCache: true })).toBe(false);
  });
});
