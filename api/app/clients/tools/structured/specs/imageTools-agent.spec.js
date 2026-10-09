/**
 * Regression tests for image tool agent mode — verifies that invoke() returns
 * a ToolMessage with base64 in artifact.content rather than serialized into content.
 *
 * Root cause: DALLE3/FluxAPI/StableDiffusion extend LangChain's Tool but did not
 * set responseFormat = 'content_and_artifact'. LangChain's invoke() would then
 * JSON.stringify the entire [content, artifact] tuple into ToolMessage.content,
 * dumping base64 into token counting and causing context exhaustion.
 */

const axios = require('axios');
const OpenAI = require('openai');
const undici = require('undici');
const fetch = require('node-fetch');
const { ContentTypes } = require('librechat-data-provider');
const { ToolMessage } = require('@librechat/agents/langchain/messages');
const StableDiffusionAPI = require('../StableDiffusion');
const FluxAPI = require('../FluxAPI');
const DALLE3 = require('../DALLE3');

jest.mock('axios');
jest.mock('openai');
jest.mock('node-fetch');
jest.mock('undici', () => ({
  ProxyAgent: jest.fn(),
  fetch: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('path', () => ({
  resolve: jest.fn(),
  join: jest.fn().mockReturnValue('/mock/path'),
  relative: jest.fn().mockReturnValue('relative/path'),
  extname: jest.fn().mockReturnValue('.png'),
}));
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  promises: { writeFile: jest.fn(), readFile: jest.fn(), unlink: jest.fn() },
}));

const FAKE_BASE64 = 'aGVsbG8=';

const makeToolCall = (name, args) => ({
  id: 'call_test_123',
  name,
  args,
  type: 'tool_call',
});

describe('image tools - agent mode ToolMessage format', () => {
  const ENV_KEYS = ['DALLE_API_KEY', 'FLUX_API_KEY', 'SD_WEBUI_URL', 'PROXY'];
  let savedEnv = {};

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
    process.env.DALLE_API_KEY = 'test-dalle-key';
    process.env.FLUX_API_KEY = 'test-flux-key';
    process.env.SD_WEBUI_URL = 'http://localhost:7860';
    delete process.env.PROXY;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    savedEnv = {};
  });

  describe('DALLE3', () => {
    beforeEach(() => {
      OpenAI.mockImplementation(() => ({
        images: {
          generate: jest.fn().mockResolvedValue({
            data: [{ url: 'https://example.com/image.png' }],
          }),
        },
      }));
      undici.fetch.mockResolvedValue({
        arrayBuffer: () => Promise.resolve(Buffer.from(FAKE_BASE64, 'base64')),
      });
    });

    it('sets responseFormat to content_and_artifact when isAgent is true', () => {
      const dalle = new DALLE3({ isAgent: true });
      expect(dalle.responseFormat).toBe('content_and_artifact');
    });

    it('does not set responseFormat when isAgent is false', () => {
      const dalle = new DALLE3({ isAgent: false, processFileURL: jest.fn() });
      expect(dalle.responseFormat).not.toBe('content_and_artifact');
    });

    it('keeps tenant context without retaining the request object', () => {
      const req = {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-1', isTemporary: 'true' },
        config: { interfaceConfig: { retentionMode: 'all' } },
        socket: {},
      };
      const dalle = new DALLE3({ isAgent: false, processFileURL: jest.fn(), req });

      expect(dalle.tenantId).toBe('tenant-a');
      expect(dalle.req).toBeUndefined();
      expect(dalle.retentionRequest).toEqual({
        user: { id: 'user-1', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-1', isTemporary: 'true' },
        config: { interfaceConfig: { retentionMode: 'all' } },
      });
    });

    it('invoke() returns ToolMessage with base64 in artifact, not serialized in content', async () => {
      const dalle = new DALLE3({ isAgent: true });
      const result = await dalle.invoke(
        makeToolCall('dalle', {
          prompt: 'a box',
          quality: 'standard',
          size: '1024x1024',
          style: 'vivid',
        }),
      );

      expect(result).toBeInstanceOf(ToolMessage);

      const contentStr =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      expect(contentStr).not.toContain(FAKE_BASE64);

      expect(result.artifact).toBeDefined();
      const artifactContent = result.artifact?.content;
      expect(Array.isArray(artifactContent)).toBe(true);
      expect(artifactContent[0].type).toBe(ContentTypes.IMAGE_URL);
      expect(artifactContent[0].image_url.url).toContain('base64');
    });

    it('invoke() returns ToolMessage with error string in content when API fails', async () => {
      OpenAI.mockImplementation(() => ({
        images: { generate: jest.fn().mockRejectedValue(new Error('API error')) },
      }));

      const dalle = new DALLE3({ isAgent: true });
      const result = await dalle.invoke(
        makeToolCall('dalle', {
          prompt: 'a box',
          quality: 'standard',
          size: '1024x1024',
          style: 'vivid',
        }),
      );

      expect(result).toBeInstanceOf(ToolMessage);
      const contentStr =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      expect(contentStr).toContain('Something went wrong');
      expect(result.artifact).toBeDefined();
    });
  });

  describe('FluxAPI', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      axios.post.mockResolvedValue({ data: { id: 'task-123' } });
      axios.get.mockResolvedValue({
        data: { status: 'Ready', result: { sample: 'https://example.com/image.png' } },
      });
      fetch.mockResolvedValue({
        arrayBuffer: () => Promise.resolve(Buffer.from(FAKE_BASE64, 'base64')),
      });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('sets responseFormat to content_and_artifact when isAgent is true', () => {
      const flux = new FluxAPI({ isAgent: true });
      expect(flux.responseFormat).toBe('content_and_artifact');
    });

    it('does not set responseFormat when isAgent is false', () => {
      const flux = new FluxAPI({ isAgent: false, processFileURL: jest.fn() });
      expect(flux.responseFormat).not.toBe('content_and_artifact');
    });

    it('keeps tenant context without retaining the request object', () => {
      const req = {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-1', isTemporary: 'true' },
        config: { interfaceConfig: { retentionMode: 'all' } },
        socket: {},
      };
      const flux = new FluxAPI({ isAgent: false, processFileURL: jest.fn(), req });

      expect(flux.tenantId).toBe('tenant-a');
      expect(flux.req).toBeUndefined();
      expect(flux.retentionRequest).toEqual({
        user: { id: 'user-1', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-1', isTemporary: 'true' },
        config: { interfaceConfig: { retentionMode: 'all' } },
      });
    });

    it('passes minimal retention context when saving generated images', async () => {
      const processFileURL = jest.fn().mockResolvedValue({ filepath: '/images/generated.png' });
      const req = {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-1', isTemporary: 'true' },
        config: { interfaceConfig: { retentionMode: 'all' } },
        socket: {},
      };
      const flux = new FluxAPI({
        isAgent: false,
        processFileURL,
        req,
        userId: 'user-1',
        fileStrategy: 'local',
      });
      const invokePromise = flux.invoke(
        makeToolCall('flux', { prompt: 'a box', endpoint: '/v1/flux-dev' }),
      );
      await jest.runAllTimersAsync();
      await invokePromise;

      expect(processFileURL).toHaveBeenCalledWith(
        expect.objectContaining({
          req: {
            user: { id: 'user-1', tenantId: 'tenant-a' },
            body: { conversationId: 'convo-1', isTemporary: 'true' },
            config: { interfaceConfig: { retentionMode: 'all' } },
          },
        }),
      );
    });

    it('passes minimal retention context when saving finetuned generated images', async () => {
      const processFileURL = jest.fn().mockResolvedValue({ filepath: '/images/generated.png' });
      const req = {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        body: { conversationId: 'convo-1', isTemporary: 'true' },
        config: { interfaceConfig: { retentionMode: 'all' } },
        socket: {},
      };
      const flux = new FluxAPI({
        isAgent: false,
        processFileURL,
        req,
        userId: 'user-1',
        fileStrategy: 'local',
      });
      const invokePromise = flux.invoke(
        makeToolCall('flux', {
          action: 'generate_finetuned',
          prompt: 'a box',
          finetune_id: 'ft-abc123',
          endpoint: '/v1/flux-pro-finetuned',
        }),
      );
      await jest.runAllTimersAsync();
      await invokePromise;

      expect(processFileURL).toHaveBeenCalledWith(
        expect.objectContaining({
          req: {
            user: { id: 'user-1', tenantId: 'tenant-a' },
            body: { conversationId: 'convo-1', isTemporary: 'true' },
            config: { interfaceConfig: { retentionMode: 'all' } },
          },
        }),
      );
    });

    it('invoke() returns ToolMessage with base64 in artifact, not serialized in content', async () => {
      const flux = new FluxAPI({ isAgent: true });
      const invokePromise = flux.invoke(
        makeToolCall('flux', { prompt: 'a box', endpoint: '/v1/flux-dev' }),
      );
      await jest.runAllTimersAsync();
      const result = await invokePromise;

      expect(result).toBeInstanceOf(ToolMessage);
      const contentStr =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      expect(contentStr).not.toContain(FAKE_BASE64);

      expect(result.artifact).toBeDefined();
      const artifactContent = result.artifact?.content;
      expect(Array.isArray(artifactContent)).toBe(true);
      expect(artifactContent[0].type).toBe(ContentTypes.IMAGE_URL);
      expect(artifactContent[0].image_url.url).toContain('base64');
    });

    it('invoke() returns ToolMessage with base64 in artifact for generate_finetuned action', async () => {
      const flux = new FluxAPI({ isAgent: true });
      const invokePromise = flux.invoke(
        makeToolCall('flux', {
          action: 'generate_finetuned',
          prompt: 'a box',
          finetune_id: 'ft-abc123',
          endpoint: '/v1/flux-pro-finetuned',
        }),
      );
      await jest.runAllTimersAsync();
      const result = await invokePromise;

      expect(result).toBeInstanceOf(ToolMessage);
      const contentStr =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      expect(contentStr).not.toContain(FAKE_BASE64);

      expect(result.artifact).toBeDefined();
      const artifactContent = result.artifact?.content;
      expect(Array.isArray(artifactContent)).toBe(true);
      expect(artifactContent[0].type).toBe(ContentTypes.IMAGE_URL);
      expect(artifactContent[0].image_url.url).toContain('base64');
    });

    it('invoke() returns ToolMessage with error string in content when task submission fails', async () => {
      axios.post.mockRejectedValue(new Error('Network error'));

      const flux = new FluxAPI({ isAgent: true });
      const invokePromise = flux.invoke(
        makeToolCall('flux', { prompt: 'a box', endpoint: '/v1/flux-dev' }),
      );
      await jest.runAllTimersAsync();
      const result = await invokePromise;

      expect(result).toBeInstanceOf(ToolMessage);
      const contentStr =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      expect(contentStr).toContain('Something went wrong');
      expect(result.artifact).toBeDefined();
    });

    it('routes a finetuned endpoint through generateFinetunedImage even when action is left as "generate"', async () => {
      const flux = new FluxAPI({ isAgent: true });
      const invokePromise = flux.invoke(
        makeToolCall('flux', {
          prompt: 'a box',
          endpoint: '/v1/flux-pro-finetuned',
          finetune_id: 'ft-abc123',
          finetune_strength: 0.8,
          guidance: 3,
        }),
      );
      await jest.runAllTimersAsync();
      const result = await invokePromise;

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('/v1/flux-pro-finetuned'),
        expect.objectContaining({
          finetune_id: 'ft-abc123',
          finetune_strength: 0.8,
          guidance: 3,
        }),
        expect.anything(),
      );

      expect(result).toBeInstanceOf(ToolMessage);
      expect(result.artifact).toBeDefined();
      const artifactContent = result.artifact?.content;
      expect(Array.isArray(artifactContent)).toBe(true);
      expect(artifactContent[0].type).toBe(ContentTypes.IMAGE_URL);
      expect(artifactContent[0].image_url.url).toContain('base64');
    });

    it('rejects a finetuned endpoint without finetune_id even when action is left as "generate"', async () => {
      const flux = new FluxAPI({ isAgent: true });

      await expect(
        flux.invoke(
          makeToolCall('flux', {
            prompt: 'a box',
            endpoint: '/v1/flux-pro-finetuned',
          }),
        ),
      ).rejects.toThrow(/finetune_id/);
    });
  });

  describe('StableDiffusion', () => {
    beforeEach(() => {
      axios.post.mockResolvedValue({
        data: {
          images: [FAKE_BASE64],
          info: JSON.stringify({ height: 1024, width: 1024, seed: 42, infotexts: [] }),
        },
      });
    });

    it('sets responseFormat to content_and_artifact when isAgent is true', () => {
      const sd = new StableDiffusionAPI({ isAgent: true, override: true });
      expect(sd.responseFormat).toBe('content_and_artifact');
    });

    it('does not set responseFormat when isAgent is false', () => {
      const sd = new StableDiffusionAPI({
        isAgent: false,
        override: true,
        uploadImageBuffer: jest.fn(),
      });
      expect(sd.responseFormat).not.toBe('content_and_artifact');
    });

    it('invoke() returns ToolMessage with base64 in artifact, not serialized in content', async () => {
      const sd = new StableDiffusionAPI({ isAgent: true, override: true, userId: 'user-1' });
      const result = await sd.invoke(
        makeToolCall('stable-diffusion', { prompt: 'a box', negative_prompt: '' }),
      );

      expect(result).toBeInstanceOf(ToolMessage);
      const contentStr =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      expect(contentStr).not.toContain(FAKE_BASE64);

      expect(result.artifact).toBeDefined();
      const artifactContent = result.artifact?.content;
      expect(Array.isArray(artifactContent)).toBe(true);
      expect(artifactContent[0].type).toBe(ContentTypes.IMAGE_URL);
      expect(artifactContent[0].image_url.url).toContain('base64');
    });

    it('invoke() returns ToolMessage with error string in content when API fails', async () => {
      axios.post.mockRejectedValue(new Error('Connection refused'));

      const sd = new StableDiffusionAPI({ isAgent: true, override: true, userId: 'user-1' });
      const result = await sd.invoke(
        makeToolCall('stable-diffusion', { prompt: 'a box', negative_prompt: '' }),
      );

      expect(result).toBeInstanceOf(ToolMessage);
      const contentStr =
        typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
      expect(contentStr).toContain('Error making API request');
    });
  });
});
