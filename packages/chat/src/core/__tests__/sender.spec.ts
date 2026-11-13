import { EModelEndpoint, getResponseSender } from 'librechat-data-provider';
import type { TModelSpec, TEndpointOption, TEndpointsConfig } from 'librechat-data-provider';
import { resolveSender } from '../turns/sender';

const modelSpecs = [{ name: 'fast-qwen', label: 'Fast Qwen' }] as TModelSpec[];

const endpointsConfig: TEndpointsConfig = {
  [EModelEndpoint.custom]: {
    order: 0,
    userProvide: false,
    modelDisplayLabel: 'Together',
  },
};

const together: TEndpointOption = {
  endpoint: EModelEndpoint.custom,
  endpointType: EModelEndpoint.custom,
  model: 'Qwen/Qwen2.5-72B-Instruct',
};

describe('resolveSender', () => {
  it('prefers modelLabel over the spec and endpoint labels', () => {
    const option = { ...together, modelLabel: 'My Qwen', spec: 'fast-qwen' };
    expect(resolveSender(option, endpointsConfig, modelSpecs)).toBe('My Qwen');
  });

  it('surfaces the model spec label when no modelLabel is set', () => {
    const option = { ...together, spec: 'fast-qwen' };
    expect(resolveSender(option, endpointsConfig, modelSpecs)).toBe('Fast Qwen');
  });

  it('lets the endpoint modelDisplayLabel beat the family heuristic', () => {
    const option = { ...together, model: 'mistralai/Mixtral-8x7B-Instruct-v0.1' };
    expect(resolveSender(option, endpointsConfig, modelSpecs)).toBe('Together');
  });

  it('ignores a spec name that is not in the list', () => {
    const option = { ...together, spec: 'missing' };
    expect(resolveSender(option, endpointsConfig, undefined)).toBe('Together');
  });

  it('falls through to getResponseSender when no label resolves', () => {
    const anthropic: TEndpointOption = { endpoint: EModelEndpoint.anthropic };
    expect(resolveSender(anthropic, undefined, undefined)).toBe('Claude');
    const unknownModel: TEndpointOption = {
      endpoint: EModelEndpoint.openAI,
      model: 'some-unknown-model',
    };
    expect(resolveSender(unknownModel, undefined, modelSpecs)).toBe(
      getResponseSender(unknownModel),
    );
  });

  it('never reveals model or spec labels for agent conversations', () => {
    const option: TEndpointOption = {
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_abc123',
      model: 'gpt-5.5',
      modelLabel: 'GPT-5.5 Pro',
      spec: 'fast-qwen',
    };
    expect(resolveSender(option, endpointsConfig, modelSpecs)).toBe('');
  });
});
