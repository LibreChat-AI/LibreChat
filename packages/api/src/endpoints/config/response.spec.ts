import type { TModelsConfig } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import { loadModelsResponse } from './response';

type ModelLabels = Record<string, Record<string, string>>;

const makeRequest = (query?: Record<string, string | undefined>) => ({ query }) as ServerRequest;

function setup() {
  const loadDefaultModels = jest.fn(
    async (_req: ServerRequest): Promise<TModelsConfig> => ({
      openAI: ['native-id'],
    }),
  );
  const loadConfigModels = jest.fn(
    async (_req: ServerRequest, labels?: ModelLabels): Promise<TModelsConfig> => {
      if (labels) {
        labels.Custom = { 'model-id': 'Friendly model' };
      }
      return { Custom: ['model-id'] };
    },
  );
  return { loadDefaultModels, loadConfigModels };
}

describe('loadModelsResponse', () => {
  it.each([undefined, {}, { includeLabels: 'false' }, { includeLabels: 'TRUE' }])(
    'preserves the legacy response when labels are not requested: %j',
    async (query) => {
      const req = makeRequest(query);
      const deps = setup();

      expect(await loadModelsResponse(req, deps)).toEqual({
        openAI: ['native-id'],
        Custom: ['model-id'],
      });
      expect(deps.loadDefaultModels).toHaveBeenCalledWith(req);
      expect(deps.loadConfigModels).toHaveBeenCalledWith(req, undefined);
    },
  );

  it('returns names separately from model IDs when includeLabels is true', async () => {
    const req = makeRequest({ includeLabels: 'true' });
    const deps = setup();

    expect(await loadModelsResponse(req, deps)).toEqual({
      models: { openAI: ['native-id'], Custom: ['model-id'] },
      modelLabels: { Custom: { 'model-id': 'Friendly model' } },
    });
    expect(deps.loadConfigModels).toHaveBeenCalledWith(req, {
      Custom: { 'model-id': 'Friendly model' },
    });
  });

  it('lets custom model lists override defaults for the same endpoint', async () => {
    const deps = setup();
    const defaults = { Custom: ['old-id'], openAI: ['native-id'] };
    const custom = { Custom: ['new-id'] };
    deps.loadDefaultModels.mockResolvedValueOnce(defaults);
    deps.loadConfigModels.mockResolvedValueOnce(custom);

    expect(await loadModelsResponse(makeRequest(), deps)).toEqual({
      Custom: ['new-id'],
      openAI: ['native-id'],
    });
    expect(defaults.Custom).toEqual(['old-id']);
    expect(custom.Custom).toEqual(['new-id']);
  });

  it('returns an empty label map when no names are provided', async () => {
    const deps = setup();
    deps.loadConfigModels.mockResolvedValueOnce({ Custom: ['model-id'] });

    expect(await loadModelsResponse(makeRequest({ includeLabels: 'true' }), deps)).toEqual({
      models: { openAI: ['native-id'], Custom: ['model-id'] },
      modelLabels: {},
    });
  });

  it('returns empty maps when no models are configured', async () => {
    const deps = setup();
    deps.loadDefaultModels.mockResolvedValueOnce({});
    deps.loadConfigModels.mockResolvedValueOnce({});

    expect(await loadModelsResponse(makeRequest({ includeLabels: 'true' }), deps)).toEqual({
      models: {},
      modelLabels: {},
    });
  });

  it('creates a new label map for each request', async () => {
    const deps = setup();
    const first = await loadModelsResponse(makeRequest({ includeLabels: 'true' }), deps);
    deps.loadConfigModels.mockResolvedValueOnce({ Other: ['next-id'] });

    const second = await loadModelsResponse(makeRequest({ includeLabels: 'true' }), deps);

    expect(first).toEqual({
      models: { openAI: ['native-id'], Custom: ['model-id'] },
      modelLabels: { Custom: { 'model-id': 'Friendly model' } },
    });
    expect(second).toEqual({
      models: { openAI: ['native-id'], Other: ['next-id'] },
      modelLabels: {},
    });
    expect(deps.loadConfigModels.mock.calls[0][1]).not.toBe(deps.loadConfigModels.mock.calls[1][1]);
  });

  it.each(['loadDefaultModels', 'loadConfigModels'] as const)(
    'propagates a failure from %s to the controller',
    async (loader) => {
      const deps = setup();
      const error = new Error('Load failed');
      deps[loader].mockRejectedValueOnce(error);

      await expect(loadModelsResponse(makeRequest({ includeLabels: 'true' }), deps)).rejects.toBe(
        error,
      );
    },
  );

  it('starts both loaders before waiting for either to finish', async () => {
    const deps = setup();
    let resolveDefaults!: (models: TModelsConfig) => void;
    let resolveCustom!: (models: TModelsConfig) => void;
    deps.loadDefaultModels.mockReturnValueOnce(
      new Promise<TModelsConfig>((resolve) => {
        resolveDefaults = resolve;
      }),
    );
    deps.loadConfigModels.mockReturnValueOnce(
      new Promise<TModelsConfig>((resolve) => {
        resolveCustom = resolve;
      }),
    );

    const pending = loadModelsResponse(makeRequest(), deps);
    try {
      expect(deps.loadDefaultModels).toHaveBeenCalledTimes(1);
      expect(deps.loadConfigModels).toHaveBeenCalledTimes(1);
    } finally {
      resolveDefaults({ openAI: ['native-id'] });
      resolveCustom?.({ Custom: ['model-id'] });
    }
    expect(await pending).toEqual({ openAI: ['native-id'], Custom: ['model-id'] });
  });
});
