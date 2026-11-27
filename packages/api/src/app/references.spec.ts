import { EModelEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { normalizeEndpointReferences } from './references';

const asConfig = (config: Record<string, unknown>): AppConfig => config as unknown as AppConfig;

describe('normalizeEndpointReferences', () => {
  it('folds and dedupes addedEndpoints, spec endpoints and allowedProviders', () => {
    const config = asConfig({
      modelSpecs: {
        enforce: false,
        list: [
          { name: 'local', label: 'Local', preset: { endpoint: 'Ollama', model: 'llama3' } },
          { name: 'gpt', label: 'GPT', preset: { endpoint: EModelEndpoint.openAI } },
        ],
        addedEndpoints: ['Ollama', EModelEndpoint.openAI, 'ollama', 'OLLAMA'],
      },
      endpoints: {
        [EModelEndpoint.agents]: { allowedProviders: ['Ollama', EModelEndpoint.openAI] },
        [EModelEndpoint.openAI]: { titleModel: 'gpt-4o-mini' },
      },
    });

    const normalized = normalizeEndpointReferences(config);

    expect(normalized.modelSpecs?.addedEndpoints).toEqual(['ollama', EModelEndpoint.openAI]);
    expect(normalized.modelSpecs?.list?.map((spec) => spec.preset?.endpoint)).toEqual([
      'ollama',
      EModelEndpoint.openAI,
    ]);
    expect(normalized.modelSpecs?.list?.[0]?.preset).toEqual({
      endpoint: 'ollama',
      model: 'llama3',
    });
    expect(normalized.modelSpecs?.enforce).toBe(false);
    expect(normalized.endpoints?.agents?.allowedProviders).toEqual([
      'ollama',
      EModelEndpoint.openAI,
    ]);
    expect(normalized.endpoints?.openAI).toBe(config.endpoints?.openAI);
  });

  it('leaves the input untouched', () => {
    const config = asConfig({
      modelSpecs: {
        addedEndpoints: ['Ollama'],
        list: [{ name: 'a', preset: { endpoint: 'Ollama' } }],
      },
      endpoints: { [EModelEndpoint.agents]: { allowedProviders: ['Ollama'] } },
    });
    const snapshot = JSON.parse(JSON.stringify(config));

    normalizeEndpointReferences(config);

    expect(config).toEqual(snapshot);
  });

  it('returns the same objects when every reference is already a served name', () => {
    const spec = { name: 'a', label: 'A', preset: { endpoint: 'ollama' } };
    const config = asConfig({
      modelSpecs: { list: [spec], addedEndpoints: ['ollama', 'Custom Gateway'] },
      endpoints: { [EModelEndpoint.agents]: { allowedProviders: [EModelEndpoint.openAI] } },
    });

    const normalized = normalizeEndpointReferences(config);

    expect(normalized).toBe(config);
    expect(normalized.modelSpecs?.list?.[0]).toBe(spec);
  });

  it('keeps unchanged parts by identity when only one reference changes', () => {
    const list = [{ name: 'a', label: 'A', preset: { endpoint: EModelEndpoint.openAI } }];
    const config = asConfig({
      modelSpecs: { list, addedEndpoints: ['Ollama'] },
      endpoints: { [EModelEndpoint.agents]: { allowedProviders: [EModelEndpoint.openAI] } },
    });

    const normalized = normalizeEndpointReferences(config);

    expect(normalized.modelSpecs?.list).toBe(list);
    expect(normalized.modelSpecs?.addedEndpoints).toEqual(['ollama']);
    expect(normalized.endpoints).toBe(config.endpoints);
  });

  it('does not add keys a config leaves out', () => {
    const config = asConfig({
      modelSpecs: { list: [{ name: 'a', preset: { endpoint: 'Ollama' } }] },
    });

    const normalized = normalizeEndpointReferences(config);

    expect(Object.keys(normalized.modelSpecs ?? {})).toEqual(['list']);
    expect(normalized).not.toHaveProperty('endpoints');
  });

  it('keeps other spellings of non-folded endpoint names verbatim', () => {
    const config = asConfig({
      modelSpecs: { addedEndpoints: ['OpenRouter', 'openrouter'] },
      endpoints: { [EModelEndpoint.agents]: { allowedProviders: ['OpenRouter'] } },
    });

    expect(normalizeEndpointReferences(config)).toBe(config);
  });

  it('accepts a config with no model specs or agents block', () => {
    const config = asConfig({ endpoints: { [EModelEndpoint.openAI]: {} } });

    expect(normalizeEndpointReferences(config)).toBe(config);
    expect(normalizeEndpointReferences(asConfig({}))).toEqual({});
  });
});
