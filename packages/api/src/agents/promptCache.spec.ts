import {
  isStableContextEnabled,
  orderNames,
  hasProviderPromptCache,
  replaysSignedReasoning,
  getReasoningReplayTarget,
} from './promptCache';

const ON = { endpoints: { agents: { promptCache: { stableContext: true } } } };

describe('isStableContextEnabled', () => {
  it('is off unless configured', () => {
    expect(isStableContextEnabled(undefined)).toBe(false);
    expect(isStableContextEnabled(null)).toBe(false);
    expect(isStableContextEnabled({})).toBe(false);
    expect(isStableContextEnabled({ endpoints: { agents: {} } })).toBe(false);
    expect(
      isStableContextEnabled({ endpoints: { agents: { promptCache: { stableContext: false } } } }),
    ).toBe(false);
  });

  it('is on when configured and the SDK has the dispatcher', () => {
    expect(isStableContextEnabled(ON)).toBe(true);
  });
});

describe('hasProviderPromptCache', () => {
  it.each(['anthropic', 'openrouter', 'bedrock'])('is true for %s with promptCache', (provider) => {
    expect(hasProviderPromptCache({ provider, model_parameters: { promptCache: true } })).toBe(
      true,
    );
    expect(hasProviderPromptCache({ provider, model_parameters: { promptCache: false } })).toBe(
      false,
    );
    expect(hasProviderPromptCache({ provider })).toBe(false);
  });

  it.each(['openAI', 'google', 'azureOpenAI', undefined])('is false for %s', (provider) => {
    expect(hasProviderPromptCache({ provider, model_parameters: { promptCache: true } })).toBe(
      false,
    );
  });
});

describe('orderNames', () => {
  it('sorts by code unit with stableContext and keeps the given order without', () => {
    const names = new Set(['b', 'A', 'a']);
    expect(orderNames(ON, names)).toEqual(['A', 'a', 'b']);
    expect(orderNames({}, names)).toEqual(['b', 'A', 'a']);
  });
});

describe('signed reasoning replay', () => {
  it.each(['anthropic', 'bedrock'])('applies to %s with stableContext only', (provider) => {
    expect(replaysSignedReasoning(ON, provider)).toBe(true);
    expect(replaysSignedReasoning({}, provider)).toBe(false);
    expect(replaysSignedReasoning(undefined, provider)).toBe(false);
  });

  it.each(['openAI', 'azureOpenAI', 'google', 'openrouter', undefined, null])(
    'does not apply to %s',
    (provider) => {
      expect(replaysSignedReasoning(ON, provider)).toBe(false);
    },
  );

  it('names the model the run serves, through the modelName alias too', () => {
    expect(
      getReasoningReplayTarget(ON, {
        provider: 'anthropic',
        model: 'agent-model',
        model_parameters: { model: 'claude-test' },
      }),
    ).toEqual({ provider: 'anthropic', model: 'claude-test' });
    expect(
      getReasoningReplayTarget(ON, {
        provider: 'bedrock',
        model: 'agent-model',
        model_parameters: { modelName: 'alias-model' },
      }),
    ).toEqual({ provider: 'bedrock', model: 'alias-model' });
    expect(getReasoningReplayTarget(ON, { provider: 'anthropic', model: 'agent-model' })).toEqual({
      provider: 'anthropic',
      model: 'agent-model',
    });
  });

  it('names nothing without a model, with the lever off, or for another provider', () => {
    expect(getReasoningReplayTarget(ON, { provider: 'anthropic' })).toBeUndefined();
    expect(
      getReasoningReplayTarget({}, { provider: 'anthropic', model_parameters: { model: 'm' } }),
    ).toBeUndefined();
    expect(
      getReasoningReplayTarget(ON, { provider: 'openAI', model_parameters: { model: 'm' } }),
    ).toBeUndefined();
  });
});

describe('without a tool dispatcher in the installed SDK', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('@librechat/agents');
  });

  it('behaves as off and warns once', () => {
    const warn = jest.fn();
    jest.resetModules();
    jest.doMock('@librechat/agents', () => ({}));
    jest.doMock('@librechat/data-schemas', () => ({ logger: { warn } }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const promptCache = require('./promptCache') as typeof import('./promptCache');
    expect(promptCache.isStableContextEnabled(ON)).toBe(false);
    expect(promptCache.isStableContextEnabled(ON)).toBe(false);
    expect(promptCache.orderNames(ON, ['b', 'a'])).toEqual(['b', 'a']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('no tool dispatcher');
  });
});
