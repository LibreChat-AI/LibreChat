import { EModelEndpoint } from 'librechat-data-provider';
import type { TPreset } from 'librechat-data-provider';
import { mergeQuerySettingsWithSpec, specDisplayFieldReset } from '../endpoints';

describe('mergeQuerySettingsWithSpec', () => {
  const specPreset: TPreset = {
    endpoint: EModelEndpoint.openAI,
    model: 'gpt-4',
    spec: 'my-spec',
    iconURL: 'https://example.com/icon.png',
    modelLabel: 'My Custom GPT',
    greeting: 'Hello from the spec!',
    temperature: 0.7,
  };

  describe('when specPreset is active and query has no spec', () => {
    it('clears all spec display fields for agent share links', () => {
      const querySettings: TPreset = {
        agent_id: 'agent_123',
        endpoint: EModelEndpoint.agents,
      };

      const result = mergeQuerySettingsWithSpec(specPreset, querySettings);

      expect(result.agent_id).toBe('agent_123');
      expect(result.endpoint).toBe(EModelEndpoint.agents);
      expect(result.spec).toBeNull();
      expect(result.iconURL).toBeNull();
      expect(result.modelLabel).toBeNull();
      expect(result.greeting).toBeUndefined();
    });

    it('preserves non-display settings from the spec base', () => {
      const querySettings: TPreset = {
        agent_id: 'agent_123',
        endpoint: EModelEndpoint.agents,
      };

      const result = mergeQuerySettingsWithSpec(specPreset, querySettings);

      expect(result.temperature).toBe(0.7);
    });

    it('clears spec display fields for assistant share links', () => {
      const querySettings: TPreset = {
        assistant_id: 'asst_abc',
        endpoint: EModelEndpoint.assistants,
      };

      const result = mergeQuerySettingsWithSpec(specPreset, querySettings);

      expect(result.assistant_id).toBe('asst_abc');
      expect(result.endpoint).toBe(EModelEndpoint.assistants);
      expect(result.spec).toBeNull();
      expect(result.iconURL).toBeNull();
      expect(result.modelLabel).toBeNull();
      expect(result.greeting).toBeUndefined();
    });

    it('clears spec display fields for model override links', () => {
      const querySettings: TPreset = {
        model: 'claude-sonnet-4-20250514',
        endpoint: EModelEndpoint.anthropic,
      };

      const result = mergeQuerySettingsWithSpec(specPreset, querySettings);

      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.endpoint).toBe(EModelEndpoint.anthropic);
      expect(result.spec).toBeNull();
      expect(result.iconURL).toBeNull();
      expect(result.modelLabel).toBeNull();
      expect(result.greeting).toBeUndefined();
    });
  });

  describe('when query explicitly sets a spec', () => {
    it('preserves spec display fields from the base', () => {
      const querySettings = { spec: 'other-spec' } as TPreset;

      const result = mergeQuerySettingsWithSpec(specPreset, querySettings);

      expect(result.spec).toBe('other-spec');
      expect(result.iconURL).toBe('https://example.com/icon.png');
      expect(result.modelLabel).toBe('My Custom GPT');
      expect(result.greeting).toBe('Hello from the spec!');
    });
  });

  describe('when specPreset is undefined (no spec configured)', () => {
    it('returns querySettings without injecting null display fields', () => {
      const querySettings: TPreset = {
        agent_id: 'agent_123',
        endpoint: EModelEndpoint.agents,
      };

      const result = mergeQuerySettingsWithSpec(undefined, querySettings);

      expect(result.agent_id).toBe('agent_123');
      expect(result.endpoint).toBe(EModelEndpoint.agents);
      expect(result).not.toHaveProperty('spec');
      expect(result).not.toHaveProperty('iconURL');
      expect(result).not.toHaveProperty('modelLabel');
      expect(result).not.toHaveProperty('greeting');
    });
  });

  describe('when querySettings is empty', () => {
    it('still clears spec display fields (no query params is not an explicit spec)', () => {
      const result = mergeQuerySettingsWithSpec(specPreset, {} as TPreset);

      expect(result.spec).toBeNull();
      expect(result.iconURL).toBeNull();
      expect(result.modelLabel).toBeNull();
      expect(result.greeting).toBeUndefined();
      expect(result.endpoint).toBe(EModelEndpoint.openAI);
      expect(result.model).toBe('gpt-4');
      expect(result.temperature).toBe(0.7);
    });
  });

  describe('query settings override spec values', () => {
    it('overrides endpoint and model from spec', () => {
      const querySettings: TPreset = {
        endpoint: EModelEndpoint.anthropic,
        model: 'claude-sonnet-4-20250514',
      };

      const result = mergeQuerySettingsWithSpec(specPreset, querySettings);

      expect(result.endpoint).toBe(EModelEndpoint.anthropic);
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.temperature).toBe(0.7);
      expect(result.spec).toBeNull();
    });
  });
});

describe('specDisplayFieldReset', () => {
  it('contains all spec display fields that need clearing', () => {
    expect(specDisplayFieldReset).toEqual({
      spec: null,
      iconURL: null,
      modelLabel: null,
      greeting: undefined,
    });
  });

  it('has exactly 4 fields', () => {
    expect(Object.keys(specDisplayFieldReset)).toHaveLength(4);
  });
});

it('does not carry a spec model into a different endpoint awaiting its own discovery', () => {
  const merged = mergeQuerySettingsWithSpec(
    { endpoint: EModelEndpoint.openAI, model: 'old-model', agent_id: 'agent_old' },
    { endpoint: EModelEndpoint.anthropic },
  );
  expect(merged.model).toBeUndefined();
  expect(merged.agent_id).toBeUndefined();
});
