import { defaultModels, initialModelsConfig } from '../src/config';
import { EModelEndpoint } from '../src/schemas';
import { ReasoningEffort } from '../src/types';
import { applyModelAwareDefaults, paramSettings } from '../src/parameterSettings';

describe.each(['gpt-6-sol', 'gpt-6-luna'])('%s catalog and settings', (model) => {
  it('offers native OpenAI and Agents support without advertising legacy Assistants support', () => {
    for (const endpoint of [EModelEndpoint.openAI, EModelEndpoint.agents]) {
      expect(defaultModels[endpoint]).toContain(model);
      expect(initialModelsConfig[endpoint]).toContain(model);
    }
    for (const endpoint of [EModelEndpoint.assistants, EModelEndpoint.azureAssistants])
      expect(defaultModels[endpoint]).not.toContain(model);
    expect(initialModelsConfig[EModelEndpoint.azureOpenAI]).not.toContain(model);
  });
  it.each([EModelEndpoint.openAI, EModelEndpoint.azureOpenAI])(
    'keeps stored keys while limiting effort controls on %s',
    (endpoint) => {
      const settings = paramSettings[endpoint]!;
      const next = applyModelAwareDefaults(settings, endpoint, model);
      expect(next.map(({ key }) => key)).toEqual(settings.map(({ key }) => key));
      expect(next.find(({ key }) => key === 'reasoning_effort')?.options).toEqual([
        ReasoningEffort.unset,
        ReasoningEffort.none,
        ReasoningEffort.low,
        ReasoningEffort.medium,
        ReasoningEffort.high,
        ReasoningEffort.xhigh,
        ReasoningEffort.max,
      ]);
      expect(settings.find(({ key }) => key === 'reasoning_effort')?.options).toContain(
        ReasoningEffort.minimal,
      );
      expect(next.find(({ key }) => key === 'useResponsesApi')?.default).toBe(false);
      const routed = applyModelAwareDefaults(settings, endpoint, model, {
        [model]: { default: true, on: true, off: false },
      });
      expect(routed.find(({ key }) => key === 'useResponsesApi')?.default).toBe(true);
      expect(settings.find(({ key }) => key === 'useResponsesApi')?.default).toBe(false);
    },
  );
});
