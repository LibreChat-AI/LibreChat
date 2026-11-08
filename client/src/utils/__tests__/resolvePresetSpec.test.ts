import { EModelEndpoint } from 'librechat-data-provider';
import type { TModelSpec, TPreset } from 'librechat-data-provider';
import { resolvePresetSpec } from '../endpoints';

const modelSpecs = [
  {
    name: 'fast-chat',
    label: 'Fast Chat',
    preset: { endpoint: EModelEndpoint.openAI, model: 'gpt-fast' },
  },
  {
    name: 'local-chat',
    label: 'Local Chat',
    preset: { endpoint: 'University [local]', model: 'local-model' },
  },
  {
    name: 'support',
    label: 'Support',
    preset: { endpoint: EModelEndpoint.agents, agent_id: 'agent_support' },
  },
] as TModelSpec[];

const preset = (fields: Partial<TPreset>): TPreset =>
  ({ presetId: 'p1', title: 'Saved', endpoint: EModelEndpoint.openAI, ...fields }) as TPreset;

describe('resolvePresetSpec', () => {
  it('keeps the spec a preset was saved from while it still serves the same model', () => {
    expect(resolvePresetSpec(preset({ spec: 'fast-chat', model: 'gpt-fast' }), modelSpecs)).toBe(
      'fast-chat',
    );
  });

  it('keeps a spec on a custom endpoint', () => {
    expect(
      resolvePresetSpec(
        preset({ spec: 'local-chat', endpoint: 'University [local]', model: 'local-model' }),
        modelSpecs,
      ),
    ).toBe('local-chat');
  });

  it('keeps an agent spec matched by agent id', () => {
    expect(
      resolvePresetSpec(
        preset({ spec: 'support', endpoint: EModelEndpoint.agents, agent_id: 'agent_support' }),
        modelSpecs,
      ),
    ).toBe('support');
  });

  it('clears a preset without a spec', () => {
    expect(resolvePresetSpec(preset({ model: 'gpt-fast' }), modelSpecs)).toBeNull();
    expect(resolvePresetSpec(preset({ spec: '', model: 'gpt-fast' }), modelSpecs)).toBeNull();
  });

  it('clears a spec that is no longer configured or not offered to the client', () => {
    expect(
      resolvePresetSpec(preset({ spec: 'removed', model: 'gpt-fast' }), modelSpecs),
    ).toBeNull();
    expect(
      resolvePresetSpec(preset({ spec: 'fast-chat', model: 'gpt-fast' }), undefined),
    ).toBeNull();
  });

  it('clears a spec that points at another endpoint', () => {
    expect(
      resolvePresetSpec(
        preset({ spec: 'fast-chat', endpoint: EModelEndpoint.anthropic, model: 'gpt-fast' }),
        modelSpecs,
      ),
    ).toBeNull();
  });

  it('clears a spec whose model or agent the preset no longer uses', () => {
    expect(
      resolvePresetSpec(preset({ spec: 'fast-chat', model: 'gpt-slow' }), modelSpecs),
    ).toBeNull();
    expect(
      resolvePresetSpec(
        preset({ spec: 'support', endpoint: EModelEndpoint.agents, agent_id: 'agent_other' }),
        modelSpecs,
      ),
    ).toBeNull();
  });
});
