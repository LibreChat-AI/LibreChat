import { EModelEndpoint } from 'librechat-data-provider';
import type { TPreset, TModelSpec } from 'librechat-data-provider';
import type { MentionOption } from '~/common';
import { mentionEndpoint } from '../useSelectMention';

jest.mock('~/hooks', () => ({ useDefaultConvo: jest.fn() }));
jest.mock('~/store', () => ({ __esModule: true, default: {} }));

const option = (type: string, value: string): MentionOption =>
  ({ type, value, label: value }) as MentionOption;

describe('mentionEndpoint', () => {
  const presets = [{ presetId: 'p-1', endpoint: EModelEndpoint.google }] as TPreset[];
  const modelSpecs = [
    { name: 'fast', preset: { endpoint: EModelEndpoint.anthropic } },
  ] as TModelSpec[];
  const from = (type: string, value: string) =>
    mentionEndpoint(option(type, value), { presets, modelSpecs });

  it('reads an endpoint and one of its models from the option itself', () => {
    expect(from('endpoint', EModelEndpoint.openAI)).toBe(EModelEndpoint.openAI);
    expect(from('model', 'Mistral')).toBe('Mistral');
  });

  it('reads a preset and a model spec from what they are set to', () => {
    expect(from('preset', 'p-1')).toBe(EModelEndpoint.google);
    expect(from('modelSpec', 'fast')).toBe(EModelEndpoint.anthropic);
  });

  it('names nothing for a preset or a model spec that is not there', () => {
    expect(from('preset', 'gone')).toBeUndefined();
    expect(from('modelSpec', 'gone')).toBeUndefined();
  });

  it('reads an agent and an assistant from the endpoint the option is listed under', () => {
    expect(from(EModelEndpoint.agents, 'agent_1')).toBe(EModelEndpoint.agents);
    expect(from(EModelEndpoint.assistants, 'asst_1')).toBe(EModelEndpoint.assistants);
  });
});
