import type { TCustomConfig } from 'librechat-data-provider';
import { azureConfigSetup, narrowAzureServedModels, resolveAzureGroups } from './azure';

const baseGroup = {
  apiKey: 'test-key',
  instanceName: 'east',
  version: '2024-10-21',
};

describe('Azure assistants model selection', () => {
  const groups = [
    {
      ...baseGroup,
      group: 'east',
      models: {
        'gpt-4o': { deploymentName: 'gpt-4o', assistants: true },
        'gpt-4o-mini': { deploymentName: 'gpt-4o-mini' },
        'o3-mini': true,
      },
      deploymentName: 'o3-mini',
    },
    {
      ...baseGroup,
      group: 'west',
      instanceName: 'west',
      assistants: true,
      models: { 'gpt-5': { deploymentName: 'gpt-5' } },
    },
  ];

  it('selects a model whose own entry sets assistants, beside a group that sets it', () => {
    const resolved = resolveAzureGroups(groups);

    expect(resolved.isValid).toBe(true);
    expect(resolved.assistantModels).toEqual(['gpt-4o', 'gpt-5']);
    expect(resolved.assistantGroups).toEqual(['east', 'west']);
  });

  it('keeps a model-level assistants model when the served lists are narrowed', () => {
    const resolved = resolveAzureGroups(groups);
    const { config, narrowed } = narrowAzureServedModels({
      groupMap: resolved.groupMap,
      modelGroupMap: resolved.modelGroupMap,
      modelNames: resolved.modelNames,
      assistantModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-5'],
      assistantGroups: ['east', 'west'],
    });

    expect(narrowed).toEqual(['assistantModels']);
    expect(config.assistantModels).toEqual(['gpt-4o', 'gpt-5']);
    expect(config.assistantGroups).toEqual(['east', 'west']);
  });

  it('starts with endpoint-level assistants when only a model entry supports them', () => {
    const config = {
      endpoints: {
        azureOpenAI: {
          assistants: true,
          groups: [
            {
              ...baseGroup,
              group: 'east',
              models: { 'gpt-4o': { deploymentName: 'gpt-4o', assistants: true } },
            },
          ],
        },
      },
    } as unknown as Partial<TCustomConfig>;

    const azure = azureConfigSetup(config);

    expect(azure.assistantModels).toEqual(['gpt-4o']);
    expect(azure.assistantGroups).toEqual(['east']);
  });

  it('still refuses endpoint-level assistants when no group or model supports them', () => {
    const config = {
      endpoints: {
        azureOpenAI: {
          assistants: true,
          groups: [
            {
              ...baseGroup,
              group: 'east',
              models: { 'gpt-4o': { deploymentName: 'gpt-4o', assistants: false } },
            },
          ],
        },
      },
    } as unknown as Partial<TCustomConfig>;

    expect(() => azureConfigSetup(config)).toThrow(
      'No Azure models are configured to support assistants',
    );
  });
});
