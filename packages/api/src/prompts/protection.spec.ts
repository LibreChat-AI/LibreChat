import type {
  FiltersConfig,
  ModelParameterFilterField,
  PromptFilterField,
} from 'librechat-data-provider';
import {
  inspectPromptContent,
  projectStoredPrompts,
  projectStoredPresets,
  projectStoredPromptGroup,
  projectStoredPromptGroups,
} from './protection';

const pattern = {
  starterPatterns: [],
  customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
};

const promptFilters = (fields?: PromptFilterField[]): FiltersConfig => ({
  prompts: { pii: { ...pattern, fields } },
});

const modelParameterFilters = (fields?: ModelParameterFilterField[]): FiltersConfig => ({
  modelParameters: { pii: { ...pattern, fields } },
});

describe('stored prompt protection', () => {
  it('inspects prompt submissions at the typed shared boundary', () => {
    expect(
      inspectPromptContent({ prompt: 'PRIVATE-PROMPT' }, promptFilters(['text'])),
    ).toMatchObject({ source: 'prompt', field: 'text' });
    expect(
      inspectPromptContent(
        { prompt: 'PRIVATE-PROMPT' },
        {
          messages: { pii: pattern },
        },
      ),
    ).toBeNull();
  });

  it('redacts policy fields while preserving prompt management structure', () => {
    const safe = { _id: 'safe', groupId: 'group', prompt: 'Safe prompt', type: 'text' };
    const blocked = {
      _id: 'blocked',
      groupId: 'group',
      author: 'user',
      name: 'PRIVATE-NAME',
      prompt: 'PRIVATE-PROMPT',
      type: 'text',
      createdAt: '2026-08-21',
    };

    const projected = projectStoredPrompts([safe, blocked], promptFilters());

    expect(projected[0]).toBe(safe);
    expect(projected[1]).toEqual({
      _id: 'blocked',
      groupId: 'group',
      author: 'user',
      prompt: '',
      type: 'text',
      createdAt: '2026-08-21',
      contentFilterBlocked: true,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-');
  });

  it('omits blocked group metadata and scopes production-prompt handling to reuse', () => {
    const safe = {
      _id: 'safe-group',
      name: 'Safe group',
      productionPrompt: { _id: 'safe-prompt', prompt: 'Safe prompt' },
    };
    const blockedMetadata = {
      _id: 'blocked-metadata',
      name: 'PRIVATE-GROUP',
      productionPrompt: { _id: 'safe-prompt', prompt: 'Safe prompt' },
    };
    const blockedProduction = {
      _id: 'blocked-production',
      name: 'Safe group',
      productionPrompt: { _id: 'blocked-prompt', prompt: 'PRIVATE-PROMPT', type: 'text' },
    };

    expect(projectStoredPromptGroup(safe, promptFilters())).toBe(safe);
    expect(projectStoredPromptGroup(blockedMetadata, promptFilters())).toBeNull();
    expect(projectStoredPromptGroup(blockedProduction, promptFilters())).toEqual({
      _id: 'blocked-production',
      name: 'Safe group',
      productionPrompt: {
        _id: 'blocked-prompt',
        prompt: '',
        type: 'text',
        contentFilterBlocked: true,
      },
    });
    expect(
      projectStoredPromptGroup(blockedProduction, promptFilters(), { forReuse: true }),
    ).toBeNull();
    expect(
      projectStoredPromptGroups([safe, blockedMetadata, blockedProduction], promptFilters(), {
        forReuse: true,
      }),
    ).toEqual([safe]);
  });

  it('redacts every prompt and model-parameter field from blocked presets', () => {
    const preset = {
      presetId: 'preset',
      endpoint: 'openAI',
      title: 'Safe title',
      promptPrefix: 'Safe prompt',
      options: { routing: 'PRIVATE-ROUTE' },
      additional_model_request_fields: { nested: 'PRIVATE-NESTED' },
    };

    const [projected] = projectStoredPresets([preset], modelParameterFilters());

    expect(projected).toEqual({
      presetId: 'preset',
      endpoint: 'openAI',
      title: '',
      contentFilterBlocked: true,
    });
    expect(JSON.stringify(projected)).not.toContain('PRIVATE-');
  });

  it('fails closed only when preset traversal overlaps a selected field', () => {
    const oversizedExamples = Array.from({ length: 4_097 }, () => ({
      input: 'Safe input',
      output: 'Safe output',
    }));
    const preset = {
      presetId: 'oversized',
      title: 'Safe title',
      endpoint: 'openAI',
      examples: oversizedExamples,
    };

    expect(projectStoredPresets([preset], promptFilters(['name']))[0]).toBe(preset);
    expect(projectStoredPresets([preset], promptFilters(['example_input']))[0]).toEqual({
      presetId: 'oversized',
      title: '',
      endpoint: 'openAI',
      contentFilterBlocked: true,
    });
    expect(
      projectStoredPresets(
        [{ ...preset, options: { routing: 'PRIVATE-MODEL-PARAMETER' } }],
        modelParameterFilters(['request_fields']),
      )[0],
    ).toEqual({
      presetId: 'oversized',
      title: '',
      endpoint: 'openAI',
      contentFilterBlocked: true,
    });
  });

  it('skips extraction and allocation for irrelevant policies', () => {
    const preset = {
      presetId: 'unrelated',
      get title(): string {
        throw new Error('prompt fields must not be read');
      },
    };
    const filters: FiltersConfig = { messages: { pii: pattern } };
    const presets = [preset];

    expect(projectStoredPresets(presets, filters)).toBe(presets);
  });
});
