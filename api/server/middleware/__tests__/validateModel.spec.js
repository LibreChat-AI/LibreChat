const { EModelEndpoint, Providers, ViolationTypes } = require('librechat-data-provider');

jest.mock('@librechat/api', () => ({
  handleError: jest.fn(),
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getEndpointsConfig: jest.fn(),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

const { handleError } = require('@librechat/api');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { getEndpointsConfig } = require('~/server/services/Config');
const { logViolation } = require('~/cache');
const validateModel = require('../validateModel');

describe('validateModel', () => {
  let req, res, next;

  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: { model: 'gpt-4o', endpoint: 'openAI' } };
    res = {};
    next = jest.fn();
    getEndpointsConfig.mockResolvedValue({
      openAI: { userProvide: false },
    });
    getModelsConfig.mockResolvedValue({
      openAI: ['gpt-4o', 'gpt-4o-mini'],
    });
  });

  describe('format validation', () => {
    it('rejects missing model', async () => {
      req.body.model = undefined;
      await validateModel(req, res, next);
      expect(handleError).toHaveBeenCalledWith(res, { text: 'Model not provided' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects non-string model', async () => {
      req.body.model = 12345;
      await validateModel(req, res, next);
      expect(handleError).toHaveBeenCalledWith(res, { text: 'Model not provided' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects model exceeding 256 chars', async () => {
      req.body.model = 'a'.repeat(257);
      await validateModel(req, res, next);
      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid model identifier' });
    });

    it('rejects model with leading special character', async () => {
      req.body.model = '.bad-model';
      await validateModel(req, res, next);
      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid model identifier' });
    });

    it('rejects model with script injection', async () => {
      req.body.model = '<script>alert(1)</script>';
      await validateModel(req, res, next);
      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid model identifier' });
    });

    it('trims whitespace before validation', async () => {
      req.body.model = '  gpt-4o  ';
      getModelsConfig.mockResolvedValue({ openAI: ['gpt-4o'] });
      await validateModel(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
    });

    it('rejects model with spaces in the middle', async () => {
      req.body.model = 'gpt 4o';
      await validateModel(req, res, next);
      expect(handleError).toHaveBeenCalledWith(res, { text: 'Invalid model identifier' });
    });

    it('accepts standard model IDs', async () => {
      const validModels = [
        'gpt-4o',
        'claude-3-5-sonnet-20241022',
        'us.amazon.nova-pro-v1:0',
        'qwen/qwen3.6-plus-preview:free',
        'Meta-Llama-3-8B-Instruct-4bit',
      ];
      for (const model of validModels) {
        jest.clearAllMocks();
        req.body.model = model;
        getEndpointsConfig.mockResolvedValue({ openAI: { userProvide: false } });
        getModelsConfig.mockResolvedValue({ openAI: [model] });
        next.mockClear();

        await validateModel(req, res, next);
        expect(next).toHaveBeenCalled();
        expect(handleError).not.toHaveBeenCalled();
      }
    });
  });

  describe('userProvide early-return', () => {
    it('calls next() immediately for userProvide endpoints without checking model list', async () => {
      getEndpointsConfig.mockResolvedValue({
        openAI: { userProvide: true },
      });
      req.body.model = 'any-model-from-user-key';

      await validateModel(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(getModelsConfig).not.toHaveBeenCalled();
    });

    it('does not call getModelsConfig for userProvide endpoints', async () => {
      getEndpointsConfig.mockResolvedValue({
        CustomEndpoint: { userProvide: true },
      });
      req.body = { model: 'custom-model', endpoint: 'CustomEndpoint' };

      await validateModel(req, res, next);

      expect(getModelsConfig).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });
  });

  describe('system endpoint list validation', () => {
    it('rejects a model not in the available list', async () => {
      req.body.model = 'not-in-list';

      await validateModel(req, res, next);

      expect(logViolation).toHaveBeenCalledWith(
        req,
        res,
        ViolationTypes.ILLEGAL_MODEL_REQUEST,
        expect.any(Object),
        expect.anything(),
      );
      expect(handleError).toHaveBeenCalledWith(res, { text: 'Illegal model request' });
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts a model in the available list', async () => {
      req.body.model = 'gpt-4o';

      await validateModel(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
    });

    it('accepts a Vertex model from the shared Google catalog', async () => {
      req.body = { model: 'gemini-3.7-flash', endpoint: Providers.VERTEXAI };
      getEndpointsConfig.mockResolvedValue({ [Providers.VERTEXAI]: { userProvide: false } });
      getModelsConfig.mockResolvedValue({ [EModelEndpoint.google]: ['gemini-3.7-flash'] });

      await validateModel(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
    });

    it('accepts a model from an exact Vertex AI catalog', async () => {
      req.body = { model: 'custom-vertex-model', endpoint: Providers.VERTEXAI };
      getEndpointsConfig.mockResolvedValue({ [Providers.VERTEXAI]: { userProvide: false } });
      getModelsConfig.mockResolvedValue({
        [EModelEndpoint.google]: ['gemini-3.7-flash'],
        [Providers.VERTEXAI]: ['custom-vertex-model'],
      });

      await validateModel(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(handleError).not.toHaveBeenCalled();
    });

    it('rejects a Vertex model absent from the shared Google catalog', async () => {
      req.body = { model: 'gemini-not-available', endpoint: Providers.VERTEXAI };
      getEndpointsConfig.mockResolvedValue({ [Providers.VERTEXAI]: { userProvide: false } });
      getModelsConfig.mockResolvedValue({ [EModelEndpoint.google]: ['gemini-3.7-flash'] });

      await validateModel(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Illegal model request' });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects when endpoint has no models loaded', async () => {
      getModelsConfig.mockResolvedValue({ openAI: undefined });

      await validateModel(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Endpoint models not loaded' });
    });

    it('rejects when modelsConfig is null', async () => {
      getModelsConfig.mockResolvedValue(null);

      await validateModel(req, res, next);

      expect(handleError).toHaveBeenCalledWith(res, { text: 'Models not loaded' });
    });
  });
});
