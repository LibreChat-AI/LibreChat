import { getAvailableAgentSelection, getAvailableModelSelection } from './agentModelSelection';

describe('getAvailableModelSelection', () => {
  it('returns an empty value when a saved model is unavailable', () => {
    expect(getAvailableModelSelection('gpt-removed', ['gpt-4.1'])).toBe('');
  });
});

describe('getAvailableAgentSelection', () => {
  const providers = [
    { label: 'Anthropic', value: 'anthropic' },
    { label: 'Bedrock', value: 'bedrock' },
  ];
  const models = {
    anthropic: ['claude-sonnet-4'],
    bedrock: ['claude-sonnet-4', 'claude-haiku-3'],
  };

  it('keeps an available provider and model', () => {
    expect(
      getAvailableAgentSelection({
        provider: 'bedrock',
        model: 'claude-sonnet-4',
        providers,
        models,
      }),
    ).toEqual({ provider: 'bedrock', model: 'claude-sonnet-4' });
  });

  it('returns an empty selection when the provider is unavailable', () => {
    expect(
      getAvailableAgentSelection({
        provider: 'openAI',
        model: 'gpt-5',
        providers,
        models,
      }),
    ).toEqual({ provider: '', model: '' });
  });

  it('returns an empty selection when the provider has no model catalogue', () => {
    expect(
      getAvailableAgentSelection({
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        providers,
        models: { bedrock: models.bedrock },
      }),
    ).toEqual({ provider: '', model: '' });
  });

  it('keeps the provider but clears an unavailable model', () => {
    expect(
      getAvailableAgentSelection({
        provider: 'bedrock',
        model: 'claude-opus-3',
        providers,
        models,
      }),
    ).toEqual({ provider: 'bedrock', model: '' });
  });
});
