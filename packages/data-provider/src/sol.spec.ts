import {
  paramSettings,
  agentParamSettings,
  applyModelAwareDefaults,
  resolveReasoningSettingForTarget,
} from './parameterSettings';
import { defaultModels, initialModelsConfig } from './config';
import { EModelEndpoint, ReasoningEffort } from './schemas';

const model = 'gpt-6.2-sol';

it('offers Sol 6.2 on chat and Agents but not Assistants', () => {
  for (const catalog of [defaultModels, initialModelsConfig]) {
    expect(catalog[EModelEndpoint.openAI]).toContain(model);
    expect(catalog[EModelEndpoint.agents]).toContain(model);
    expect(catalog[EModelEndpoint.assistants]).not.toContain(model);
    expect(catalog[EModelEndpoint.azureAssistants] ?? []).not.toContain(model);
  }
});

it.each([EModelEndpoint.openAI, EModelEndpoint.azureOpenAI])(
  'offers supported controls on %s for chat and Agents',
  (endpoint) => {
    for (const settings of [paramSettings[endpoint]!, agentParamSettings[endpoint]!]) {
      for (const name of [model, `${model}-2026-11-17`]) {
        const original = structuredClone(settings);
        const routing = {
          [name]: { default: true, on: true, off: false, firstPartyEndpoint: true },
        };
        const result = applyModelAwareDefaults(settings, endpoint, name, routing);
        if (endpoint === EModelEndpoint.openAI) {
          expect(
            resolveReasoningSettingForTarget({
              endpoint,
              model: name,
              responsesApiRouting: routing,
            })?.options,
          ).not.toContain('none');
        }
        expect(result.find((setting) => setting.key === 'reasoning_effort')?.options).toEqual([
          ReasoningEffort.unset,
          ReasoningEffort.low,
          ReasoningEffort.medium,
          ReasoningEffort.high,
          ReasoningEffort.xhigh,
          ReasoningEffort.max,
        ]);
        expect(result.find((setting) => setting.key === 'max_tokens')?.range?.max).toBe(128000);
        expect(result.some((setting) => ['temperature', 'top_p'].includes(setting.key))).toBe(
          false,
        );
        expect(settings).toEqual(original);
      }
    }
  },
);

it('keeps earlier Sol and custom endpoint controls intact', () => {
  const settings = paramSettings[EModelEndpoint.openAI]!;
  for (const [endpoint, name] of [
    [EModelEndpoint.openAI, 'gpt-6.1-sol'],
    ['Gateway', model],
  ]) {
    const result = applyModelAwareDefaults(settings, endpoint, name);
    expect(result.find((setting) => setting.key === 'reasoning_effort')?.options).toContain('none');
    expect(result.some((setting) => setting.key === 'temperature')).toBe(true);
  }
});

it('preserves gateway controls even when the parameter schema is OpenAI', () => {
  const settings = paramSettings[EModelEndpoint.openAI]!;
  for (const routing of [
    undefined,
    { [model]: { default: false, on: true, off: false, firstPartyEndpoint: false } },
  ]) {
    const result = applyModelAwareDefaults(settings, EModelEndpoint.openAI, model, routing);
    expect(result.find((setting) => setting.key === 'reasoning_effort')?.options).toContain('none');
    expect(result.some((setting) => setting.key === 'temperature')).toBe(true);
    expect(result.some((setting) => setting.key === 'top_p')).toBe(true);
  }
});

it('preserves custom OpenAI-schema reasoning options without a native declaration', () => {
  expect(
    resolveReasoningSettingForTarget({
      endpoint: 'Gateway',
      model,
      defaultParamsEndpoint: EModelEndpoint.openAI,
    })?.options,
  ).toContain('none');
});
