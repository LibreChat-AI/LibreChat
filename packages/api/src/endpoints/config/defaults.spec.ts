import { FileSources } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import { loadDefaultEndpointModels } from './defaults';

function loaders() {
  return {
    getOpenAIModels: jest.fn().mockResolvedValue(['gpt']),
    getAnthropicModels: jest.fn().mockResolvedValue(['claude']),
    getGoogleModels: jest.fn().mockReturnValue(['gemini']),
    getBedrockModels: jest.fn().mockReturnValue(['nova']),
  };
}
const req = { user: { id: 'user-1', tenantId: 'tenant-1' } } as ServerRequest;
const config: AppConfig = {
  config: {},
  fileStrategy: FileSources.local,
  imageOutputType: 'png',
  endpoints: {},
};

describe('scoped default model discovery', () => {
  it.each([
    ['openAI', 'getOpenAIModels', 'gpt'],
    ['anthropic', 'getAnthropicModels', 'claude'],
    ['google', 'getGoogleModels', 'gemini'],
    ['bedrock', 'getBedrockModels', 'nova'],
    ['assistants', 'getOpenAIModels', 'gpt'],
    ['azureOpenAI', 'getOpenAIModels', 'gpt'],
    ['azureAssistants', 'getOpenAIModels', 'gpt'],
  ])('invokes only the %s source', async (endpoint, source, model) => {
    const deps = loaders();
    await expect(loadDefaultEndpointModels(req, config, endpoint, deps)).resolves.toEqual({
      [endpoint]: [model],
    });
    for (const [name, loader] of Object.entries(deps)) {
      expect(loader).toHaveBeenCalledTimes(name === source ? 1 : 0);
    }
  });

  it('layers endpoint headers over global headers and forwards the authenticated user', async () => {
    const deps = loaders();
    const configured = Object.assign({}, config, {
      endpoints: {
        all: { headers: { authorization: 'global', 'X-Gateway': 'trusted' } },
        openAI: {
          headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}' },
          models: ['narrowed'],
        },
      },
    });
    await loadDefaultEndpointModels(req, configured, 'openAI', deps);
    expect(deps.getOpenAIModels).toHaveBeenCalledWith({
      user: 'user-1',
      userObject: req.user,
      configuredModels: ['narrowed'],
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}', 'X-Gateway': 'trusted' },
    });
  });

  it('retains configured Anthropic and Vertex precedence', async () => {
    const deps = loaders();
    const configured = Object.assign({}, config, {
      endpoints: {
        anthropic: {
          models: ['configured'],
          vertexConfig: { region: 'us-central1', modelNames: ['vertex'] },
        },
      },
    });
    await loadDefaultEndpointModels(req, configured, 'anthropic', deps);
    expect(deps.getAnthropicModels).toHaveBeenCalledWith(
      expect.objectContaining({ configuredModels: ['configured'], vertexModels: ['vertex'] }),
    );
  });

  it('never falls through to OpenAI discovery for Azure Assistants', async () => {
    const deps = loaders();
    await loadDefaultEndpointModels(req, config, 'azureAssistants', deps);
    expect(deps.getOpenAIModels).toHaveBeenCalledWith({ azure: true });
  });

  it('keeps the existing empty-list fallback when a provider fails', async () => {
    const deps = loaders();
    deps.getOpenAIModels.mockRejectedValue(new Error('private upstream failure'));
    await expect(loadDefaultEndpointModels(req, config, 'openAI', deps)).resolves.toEqual({
      openAI: [],
    });
    expect(deps.getAnthropicModels).not.toHaveBeenCalled();
  });

  it.each(['custom', '__proto__', 'constructor'])(
    'does not discover unknown source %s',
    async (endpoint) => {
      const deps = loaders();
      await expect(loadDefaultEndpointModels(req, config, endpoint, deps)).resolves.toEqual({});
      for (const loader of Object.values(deps)) {
        expect(loader).not.toHaveBeenCalled();
      }
    },
  );
});
