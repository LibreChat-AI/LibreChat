import { orderNames, hasProviderPromptCache } from './promptCache';

const ON = { endpoints: { agents: { promptCache: { stableContext: true } } } };

describe('hasProviderPromptCache', () => {
  it.each([
    ['anthropic', true, true],
    ['bedrock', true, true],
    ['anthropic', false, false],
    ['openAI', true, false],
  ])('is %s with promptCache %s: %s', (provider, promptCache, expected) => {
    expect(hasProviderPromptCache({ provider, model_parameters: { promptCache } })).toBe(expected);
  });
});

describe('orderNames', () => {
  it('sorts by code unit with stableContext and keeps the given order without', () => {
    const names = new Set(['b', 'A', 'a']);
    expect(orderNames(ON, names)).toEqual(['A', 'a', 'b']);
    expect(orderNames({}, names)).toEqual(['b', 'A', 'a']);
  });
});
