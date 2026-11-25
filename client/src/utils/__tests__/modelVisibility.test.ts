import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import {
  emptyModelVisibility,
  filterVisibleModels,
  isEndpointConfigured,
  isEndpointVisible,
  isModelVisible,
  visibleEndpointsConfig,
  withEndpointVisible,
  withModelVisible,
} from '../modelVisibility';

describe('model visibility defaults', () => {
  it('treats a provider without a server credential as unconfigured', () => {
    expect(isEndpointConfigured({ order: 0, userProvide: true })).toBe(false);
    expect(isEndpointConfigured({ order: 0, keyProvided: false })).toBe(false);
    expect(isEndpointConfigured({ order: 0, userProvide: false, keyProvided: true })).toBe(true);
    expect(isEndpointConfigured({ order: 0 })).toBe(true);
  });

  it('hides unconfigured providers by default and offers configured ones', () => {
    const visibility = emptyModelVisibility;
    expect(isEndpointVisible('openAI', { order: 0, userProvide: true }, visibility)).toBe(false);
    expect(isEndpointVisible('OpenCodex', { order: 1, keyProvided: true }, visibility)).toBe(true);
  });

  it('lets an explicit choice override the default', () => {
    const shown = withEndpointVisible(emptyModelVisibility, 'openAI', true);
    expect(isEndpointVisible('openAI', { order: 0, userProvide: true }, shown)).toBe(true);

    const hidden = withEndpointVisible(emptyModelVisibility, 'OpenCodex', false);
    expect(isEndpointVisible('OpenCodex', { order: 0, keyProvided: true }, hidden)).toBe(false);
  });

  it('keeps a restricted catalog model off until it is enabled', () => {
    expect(isModelVisible(EModelEndpoint.openAI, 'gpt-6-astra', emptyModelVisibility)).toBe(false);
    expect(isModelVisible(EModelEndpoint.openAI, 'gpt-5.6', emptyModelVisibility)).toBe(true);

    const enabled = withModelVisible(
      emptyModelVisibility,
      EModelEndpoint.openAI,
      'gpt-6-astra',
      true,
    );
    expect(isModelVisible(EModelEndpoint.openAI, 'gpt-6-astra', enabled)).toBe(true);

    const disabled = withModelVisible(
      emptyModelVisibility,
      EModelEndpoint.openAI,
      'gpt-5.6',
      false,
    );
    expect(isModelVisible(EModelEndpoint.openAI, 'gpt-5.6', disabled)).toBe(false);
  });

  it('filters a catalog in server order and leaves an unknown list alone', () => {
    expect(
      filterVisibleModels(
        EModelEndpoint.openAI,
        ['gpt-6-astra', 'gpt-5.6', 'gpt-5.5'],
        emptyModelVisibility,
      ),
    ).toEqual(['gpt-5.6', 'gpt-5.5']);
    expect(filterVisibleModels(EModelEndpoint.openAI, undefined, emptyModelVisibility)).toBe(
      undefined,
    );
  });

  it('removes hidden endpoints from the config used to pick a new chat target', () => {
    const config = {
      [EModelEndpoint.openAI]: { order: 0, userProvide: true },
      OpenCodex: { order: 1, keyProvided: true },
    } as TEndpointsConfig;

    expect(Object.keys(visibleEndpointsConfig(config, emptyModelVisibility) ?? {})).toEqual([
      'OpenCodex',
    ]);
  });
});
