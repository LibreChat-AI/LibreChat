const axios = require('axios');

const mockApplySSRFSafeAgentIfDirect = jest.fn();

jest.mock('axios', () => ({ post: jest.fn() }), { virtual: true });
jest.mock('sharp', () => jest.fn(), { virtual: true });
jest.mock('uuid', () => ({ v4: jest.fn() }), { virtual: true });
jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));
jest.mock(
  '@librechat/agents/langchain/tools',
  () => ({
    Tool: class {},
  }),
  { virtual: true },
);
jest.mock(
  'librechat-data-provider',
  () => ({
    ContentTypes: {},
    FileContext: {},
  }),
  { virtual: true },
);
jest.mock('@librechat/api', () => ({
  applySSRFSafeAgentIfDirect: (...args) => mockApplySSRFSafeAgentIfDirect(...args),
  getBasePath: jest.fn(),
}));
jest.mock('~/config/paths', () => ({}), { virtual: true });

const StableDiffusionAPI = require('../StableDiffusion');

describe('StableDiffusionAPI', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses a connect-time SSRF guard for a user-provided endpoint', async () => {
    const error = new Error('SSRF protection: blocked address');
    mockApplySSRFSafeAgentIfDirect.mockImplementation(() => {
      throw error;
    });
    const tool = new StableDiffusionAPI({
      SD_WEBUI_URL: 'http://127.0.0.1:9000',
      userProvidedAuthFields: new Set(['SD_WEBUI_URL']),
    });

    const result = await tool._call({
      prompt: 'test prompt',
      negative_prompt: 'test negative',
    });

    expect(mockApplySSRFSafeAgentIfDirect).toHaveBeenCalledWith(
      {},
      'http://127.0.0.1:9000/sdapi/v1/txt2img',
    );
    expect(axios.post).not.toHaveBeenCalled();
    expect(result).toBe('Error making API request.');
  });
});
