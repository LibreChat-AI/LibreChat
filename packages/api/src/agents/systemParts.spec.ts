import { Providers } from '@librechat/agents';
import type { ContextAgent } from './systemParts';
import {
  ContextPartKeys,
  contributeContext,
  assembleSystemPrompt,
  sdkMovesDynamicInstructions,
} from './systemParts';

describe('contributeContext', () => {
  it('assembles parts in canonical order, whatever order they arrive in', () => {
    const agent: ContextAgent = {};
    contributeContext(agent, ContextPartKeys.skills, 'Skills');
    contributeContext(agent, ContextPartKeys.memoryGuard, 'Guard');
    contributeContext(agent, ContextPartKeys.project, 'Project');
    contributeContext(agent, ContextPartKeys.artifacts, 'Artifacts');
    expect(agent.additional_instructions).toBe('Project\n\nGuard\n\nArtifacts\n\nSkills');
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
});

describe('sdkMovesDynamicInstructions', () => {
  it.each([Providers.ANTHROPIC, Providers.OPENROUTER, Providers.BEDROCK])(
    'is true for %s with promptCache enabled',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, { promptCache: true })).toBe(true);
    },
  );

  it.each([Providers.OPENAI, Providers.GOOGLE, Providers.AZURE, 'custom'])(
    'is false for %s even with promptCache',
    (provider) => {
      expect(sdkMovesDynamicInstructions(provider, { promptCache: true })).toBe(false);
    },
  );
});
