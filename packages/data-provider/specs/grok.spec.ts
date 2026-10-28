import { EModelEndpoint, ReasoningEffort } from '../src/schemas';
import { defaultModels } from '../src/config';
import { applyModelAwareDefaults, paramSettings } from '../src/parameterSettings';

const settings = paramSettings[EModelEndpoint.custom]!;

describe('Grok 4.7 through existing endpoints', () => {
  it.each(['grok-4.7', 'x-ai/grok-4.7', 'xai/grok-4.7', 'grok-4-7'])(
    'enables supported reasoning choices for %s',
    (model) => {
      const resolved = applyModelAwareDefaults(settings, EModelEndpoint.custom, model);
      const reasoning = resolved.find((setting) => setting.key === 'reasoning_effort');
      expect(reasoning?.options).toEqual([
        ReasoningEffort.unset,
        ReasoningEffort.low,
        ReasoningEffort.medium,
        ReasoningEffort.high,
        ReasoningEffort.xhigh,
      ]);
      expect(reasoning?.default).toBe(ReasoningEffort.unset);
    },
  );

  it('does not change other models or mutate the shared settings', () => {
    const before = settings.find((setting) => setting.key === 'reasoning_effort')?.options;
    applyModelAwareDefaults(settings, EModelEndpoint.custom, 'grok-4.7');
    expect(settings.find((setting) => setting.key === 'reasoning_effort')?.options).toBe(before);
    for (const model of ['grok-4', 'grok-4.6', 'grok-4.70', 'gpt-5.6']) {
      expect(applyModelAwareDefaults(settings, EModelEndpoint.custom, model)).toBe(settings);
    }
  });

  it('does not advertise xAI models on the OpenAI catalog', () => {
    expect(defaultModels[EModelEndpoint.openAI]).not.toContain('grok-4.7');
  });
});
