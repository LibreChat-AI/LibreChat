import { paramSettings, applyModelAwareDefaults } from './parameterSettings';
import { defaultModels, initialModelsConfig } from './config';
import { EModelEndpoint } from './schemas';

it('keeps the restricted model out of universal and Assistants catalogs', () => {
  for (const models of [...Object.values(defaultModels), ...Object.values(initialModelsConfig)]) {
    expect(models).not.toContain('gpt-6-cyber');
  }
});

it('offers the published output limit without an invented reasoning effort enum', () => {
  const result = applyModelAwareDefaults(
    paramSettings[EModelEndpoint.openAI]!,
    EModelEndpoint.openAI,
    'gpt-6-cyber',
    { 'gpt-6-cyber': { default: true, on: true, off: false } },
  );
  expect(result.find((setting) => setting.key === 'max_tokens')?.range?.max).toBe(128000);
  expect(result.find((setting) => setting.key === 'useResponsesApi')?.default).toBe(true);
  expect(result.some((setting) => setting.key.startsWith('reasoning_'))).toBe(false);
});

it('preserves the actual transport route and administrator custom reasoning definitions', () => {
  const settings = paramSettings[EModelEndpoint.openAI]!;
  const native = applyModelAwareDefaults(settings, EModelEndpoint.openAI, 'gpt-6-cyber', {
    'gpt-6-cyber': { default: false, on: false, off: false },
  });
  expect(native.find((setting) => setting.key === 'useResponsesApi')?.default).toBe(false);
  expect(applyModelAwareDefaults(settings, 'Daybreak', 'gpt-6-cyber')).toBe(settings);
});
