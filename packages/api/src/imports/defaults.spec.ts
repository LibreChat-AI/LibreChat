import { EModelEndpoint, openAISettings, anthropicSettings } from 'librechat-data-provider';
import { createImportDefaults } from './defaults';

describe('import defaults remain separate from model discovery', () => {
  const getModelsConfig = jest.fn();
  const defaults = createImportDefaults({ getModelsConfig, getTenantId: () => 'tenant-a' });

  it.each([
    [EModelEndpoint.openAI, openAISettings.model.default],
    [EModelEndpoint.anthropic, anthropicSettings.model.default],
    ['custom-provider', openAISettings.model.default],
  ])('uses the existing import fallback for an empty %s catalog', async (endpoint, expected) => {
    const models = { [endpoint]: [] };
    getModelsConfig.mockResolvedValue(models);
    expect(await defaults.resolveImportDefaultModel({ endpoint, requestUserId: 'a' })).toBe(
      expected,
    );
    expect(models).toEqual({ [endpoint]: [] });
    expect(getModelsConfig).toHaveBeenLastCalledWith({
      user: { id: 'a', role: undefined, tenantId: 'tenant-a' },
    });
  });

  it('uses the runtime model before the import fallback', async () => {
    getModelsConfig.mockResolvedValue({ anthropic: ['account-model'] });
    expect(
      await defaults.resolveImportDefaultModel({ endpoint: 'anthropic', requestUserId: 'a' }),
    ).toBe('account-model');
  });

  it('keeps the existing import fallback after discovery fails', async () => {
    getModelsConfig.mockRejectedValue(new Error('secret-provider-response'));
    expect(
      await defaults.resolveImportDefaultModel({ endpoint: 'anthropic', requestUserId: 'a' }),
    ).toBe(anthropicSettings.model.default);
    expect(await defaults.resolveImportDefaultEndpoint({ requestUserId: 'a' })).toEqual({
      endpoint: 'openAI',
      model: openAISettings.model.default,
    });
  });

  it('chooses an available provider for a shared copy', async () => {
    getModelsConfig.mockResolvedValue({ openAI: [], gateway: ['available'] });
    expect(await defaults.resolveImportDefaultEndpoint({ requestUserId: 'a' })).toEqual({
      endpoint: 'gateway',
      model: 'available',
    });
  });

  it.each([{}, { openAI: [], gateway: [] }, null, undefined])(
    'keeps the OpenAI copy fallback for an empty or absent catalog: %j',
    async (models) => {
      getModelsConfig.mockResolvedValue(models);
      expect(await defaults.resolveImportDefaultEndpoint({ requestUserId: 'a' })).toEqual({
        endpoint: 'openAI',
        model: openAISettings.model.default,
      });
    },
  );
});
