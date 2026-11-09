import { z } from 'zod';
import { SettingTypes } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import {
  getAgentInferencePolicy,
  parseAgentInferenceInput,
  applyAgentInferenceInput,
} from './input';

const endpoint = {
  name: 'Gateway',
  apiKey: 'server-secret',
  baseURL: 'https://gateway.invalid/v1',
  models: { default: ['permitted'], fetch: false },
  customParams: {
    defaultParamsEndpoint: 'custom',
    paramDefinitions: [{ key: 'min_p', type: SettingTypes.Number, range: { min: 0, max: 1 } }],
  },
};
const appConfig = { endpoints: { custom: [endpoint] } } satisfies Pick<AppConfig, 'endpoints'>;

const input = (parameters: Record<string, unknown>) =>
  parseAgentInferenceInput({ parameters, provider: 'openAI', model: 'permitted' });

describe('Agent inference input', () => {
  it('does not turn an omitted parameter patch into a mutable field', () => {
    const patch = {};
    applyAgentInferenceInput(patch, { provider: 'openAI', model: 'permitted' });
    expect(Object.keys(patch)).toEqual([]);
  });
  it('preserves omission and numeric normalization', () => {
    expect(parseAgentInferenceInput({ provider: 'openAI' })).toBeUndefined();
    expect(input({ temperature: '0.7', max_tokens: '', top_p: 0 })).toEqual({
      temperature: 0.7,
      top_p: 0,
    });
  });

  it.each(['modelKwargs', 'configuration', 'fallbacks', 'apiKey', 'baseURL', 'callbacks'])(
    'rejects the SDK control %s without disclosing its value',
    (key) => {
      const secret = 'never-return-this-submitted-value';
      try {
        input({ temperature: 0.5, [key]: { nested: secret } });
        throw new Error('Expected invalid input');
      } catch (error) {
        expect(error).toBeInstanceOf(z.ZodError);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect((error as z.ZodError).issues).toEqual([
          expect.objectContaining({ path: ['model_parameters', key] }),
        ]);
      }
    },
  );

  it('does not let the redundant model field select a different model', () => {
    expect(input({ model: 'permitted', temperature: 0.4 })).toEqual({ temperature: 0.4 });
    expect(() => input({ model: 'restricted' })).toThrow(z.ZodError);
  });

  it('uses only the selected endpoint definitions, without copying its transport', () => {
    expect(getAgentInferencePolicy('Gateway', appConfig)).toEqual({
      provider: 'Gateway',
      customParams: endpoint.customParams,
    });
    const params = { temperature: 0.3, min_p: 0.1 };
    expect(
      parseAgentInferenceInput({
        parameters: params,
        provider: 'Gateway',
        model: 'permitted',
        appConfig,
      }),
    ).toEqual(params);
    expect(() => input({ min_p: 0.1 })).toThrow(z.ZodError);
    expect(getAgentInferencePolicy('gAtEwAy', appConfig).customParams).toBeUndefined();
    expect(
      parseAgentInferenceInput({
        parameters: {},
        provider: 'Gateway',
        model: 'permitted',
        appConfig,
      }),
    ).not.toHaveProperty('apiKey');
  });

  it('validates Bedrock regions against the already-loaded administrator choices', () => {
    const request = {
      parameters: { region: 'us-west-2', reasoning_effort: 'low' },
      provider: 'bedrock',
      model: 'moonshot.kimi',
      appConfig: { endpoints: { bedrock: { availableRegions: ['us-west-2'] } } },
    };
    expect(parseAgentInferenceInput(request)).toEqual(request.parameters);
    expect(() =>
      parseAgentInferenceInput({
        ...request,
        appConfig: { endpoints: { bedrock: { availableRegions: ['us-east-1'] } } },
      }),
    ).toThrow(z.ZodError);
  });

  it('still rejects Bedrock SDK envelopes on new writes despite recovering known legacy preferences', () => {
    expect(() =>
      parseAgentInferenceInput({
        provider: 'bedrock',
        model: 'us.anthropic.claude-sonnet-5',
        parameters: { additionalModelRequestFields: { thinking: { type: 'disabled' } } },
      }),
    ).toThrow(z.ZodError);
  });

  it('validates a custom value against administrator constraints', () => {
    expect(() =>
      parseAgentInferenceInput({
        parameters: { min_p: 2 },
        provider: 'Gateway',
        model: 'permitted',
        appConfig,
      }),
    ).toThrow(z.ZodError);
  });
});
