jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  extractVariableName: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

import { handleRateLimits } from './limits';
import { checkWebSearchConfig } from './checks';
import { logger } from '@librechat/data-schemas';
import { extractVariableName as extract } from 'librechat-data-provider';

const extractVariableName = extract as jest.MockedFunction<typeof extract>;

describe('checkWebSearchConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Store original environment
    originalEnv = process.env;

    // Reset process.env
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('when webSearchConfig is undefined or null', () => {
    it('should return early without logging when config is undefined', () => {
      checkWebSearchConfig(undefined);

      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should return early without logging when config is null', () => {
      checkWebSearchConfig(null);

      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('when config values are proper environment variable references', () => {
    it('should log debug message for each valid environment variable with value set', () => {
      const config = {
        serperApiKey: '${SERPER_API_KEY}',
        jinaApiKey: '${JINA_API_KEY}',
      };

      extractVariableName.mockReturnValueOnce('SERPER_API_KEY').mockReturnValueOnce('JINA_API_KEY');

      process.env.SERPER_API_KEY = 'test-serper-key';
      process.env.JINA_API_KEY = 'test-jina-key';

      checkWebSearchConfig(config);

      expect(extractVariableName).toHaveBeenCalledWith('${SERPER_API_KEY}');
      expect(extractVariableName).toHaveBeenCalledWith('${JINA_API_KEY}');
      expect(logger.debug).toHaveBeenCalledWith(
        'Web search serperApiKey: Using environment variable SERPER_API_KEY with value set',
      );
      expect(logger.debug).toHaveBeenCalledWith(
        'Web search jinaApiKey: Using environment variable JINA_API_KEY with value set',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should log debug message for environment variables not set in environment', () => {
      const config = {
        cohereApiKey: '${COHERE_API_KEY}',
      };

      extractVariableName.mockReturnValue('COHERE_API_KEY');

      delete process.env.COHERE_API_KEY;

      checkWebSearchConfig(config);

      expect(logger.debug).toHaveBeenCalledWith(
        'Web search cohereApiKey: Using environment variable COHERE_API_KEY (not set in environment, user provided value)',
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('when config values are actual values instead of environment variable references', () => {
    it('should warn when serperApiKey contains actual API key', () => {
      const config = {
        serperApiKey: 'sk-1234567890abcdef',
      };

      extractVariableName.mockReturnValue(null);

      checkWebSearchConfig(config);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '❗ Web search configuration error: serperApiKey contains an actual value',
        ),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Current value: "sk-1234567..."'),
      );
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('should warn when firecrawlApiUrl contains actual URL', () => {
      const config = {
        firecrawlApiUrl: 'https://api.firecrawl.dev',
      };

      extractVariableName.mockReturnValue(null);

      checkWebSearchConfig(config);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          '❗ Web search configuration error: firecrawlApiUrl contains an actual value',
        ),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Current value: "https://ap..."'),
      );
    });

    it('should include documentation link in warning message', () => {
      const config = {
        firecrawlApiKey: 'fc-actual-key',
      };

      extractVariableName.mockReturnValue(null);

      checkWebSearchConfig(config);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'More info: https://www.librechat.ai/docs/configuration/librechat_yaml/web_search',
        ),
      );
    });
  });

  describe('when config contains mixed value types', () => {
    it('should only process string values and ignore non-string values', () => {
      const config = {
        serperApiKey: '${SERPER_API_KEY}',
        safeSearch: 1,
        scraperTimeout: 7500,
        jinaApiKey: 'actual-key',
      };

      extractVariableName.mockReturnValueOnce('SERPER_API_KEY').mockReturnValueOnce(null);

      process.env.SERPER_API_KEY = 'test-key';

      checkWebSearchConfig(config);

      expect(extractVariableName).toHaveBeenCalledTimes(2);
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('edge cases', () => {
    it('should handle config with no web search keys', () => {
      const config = {
        someOtherKey: 'value',
        anotherKey: '${SOME_VAR}',
      };

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      /** @ts-expect-error */
      checkWebSearchConfig(config);

      expect(extractVariableName).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('should truncate long values in warning messages', () => {
      const config = {
        serperApiKey: 'this-is-a-very-long-api-key-that-should-be-truncated-in-the-warning-message',
      };

      extractVariableName.mockReturnValue(null);

      checkWebSearchConfig(config);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Current value: "this-is-a-..."'),
      );
    });
  });
});

describe('handleRateLimits', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Store original environment
    originalEnv = process.env;

    // Reset process.env
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  it('should correctly set FILE_UPLOAD environment variables based on rate limits', () => {
    const rateLimits = {
      fileUploads: {
        ipMax: 100,
        ipWindowInMinutes: 60,
        userMax: 50,
        userWindowInMinutes: 30,
      },
    };

    handleRateLimits(rateLimits);

    // Verify that process.env has been updated according to the rate limits config
    expect(process.env.FILE_UPLOAD_IP_MAX).toEqual('100');
    expect(process.env.FILE_UPLOAD_IP_WINDOW).toEqual('60');
    expect(process.env.FILE_UPLOAD_USER_MAX).toEqual('50');
    expect(process.env.FILE_UPLOAD_USER_WINDOW).toEqual('30');
  });

  it('should correctly set IMPORT environment variables based on rate limits', () => {
    const rateLimits = {
      conversationsImport: {
        ipMax: 150,
        ipWindowInMinutes: 60,
        userMax: 50,
        userWindowInMinutes: 30,
      },
    };

    handleRateLimits(rateLimits);

    // Verify that process.env has been updated according to the rate limits config
    expect(process.env.IMPORT_IP_MAX).toEqual('150');
    expect(process.env.IMPORT_IP_WINDOW).toEqual('60');
    expect(process.env.IMPORT_USER_MAX).toEqual('50');
    expect(process.env.IMPORT_USER_WINDOW).toEqual('30');
  });

  it('should not modify FILE_UPLOAD environment variables without rate limits', () => {
    // Setup initial environment variables
    process.env.FILE_UPLOAD_IP_MAX = '10';
    process.env.FILE_UPLOAD_IP_WINDOW = '15';
    process.env.FILE_UPLOAD_USER_MAX = '5';
    process.env.FILE_UPLOAD_USER_WINDOW = '20';

    const initialEnv = { ...process.env };

    handleRateLimits({});

    // Expect environment variables to remain unchanged
    expect(process.env.FILE_UPLOAD_IP_MAX).toEqual(initialEnv.FILE_UPLOAD_IP_MAX);
    expect(process.env.FILE_UPLOAD_IP_WINDOW).toEqual(initialEnv.FILE_UPLOAD_IP_WINDOW);
    expect(process.env.FILE_UPLOAD_USER_MAX).toEqual(initialEnv.FILE_UPLOAD_USER_MAX);
    expect(process.env.FILE_UPLOAD_USER_WINDOW).toEqual(initialEnv.FILE_UPLOAD_USER_WINDOW);
  });

  it('should not modify IMPORT environment variables without rate limits', () => {
    // Setup initial environment variables
    process.env.IMPORT_IP_MAX = '10';
    process.env.IMPORT_IP_WINDOW = '15';
    process.env.IMPORT_USER_MAX = '5';
    process.env.IMPORT_USER_WINDOW = '20';

    const initialEnv = { ...process.env };

    handleRateLimits({});

    // Expect environment variables to remain unchanged
    expect(process.env.IMPORT_IP_MAX).toEqual(initialEnv.IMPORT_IP_MAX);
    expect(process.env.IMPORT_IP_WINDOW).toEqual(initialEnv.IMPORT_IP_WINDOW);
    expect(process.env.IMPORT_USER_MAX).toEqual(initialEnv.IMPORT_USER_MAX);
    expect(process.env.IMPORT_USER_WINDOW).toEqual(initialEnv.IMPORT_USER_WINDOW);
  });

  it('should handle undefined rateLimits parameter', () => {
    // Setup initial environment variables
    process.env.FILE_UPLOAD_IP_MAX = 'initial';
    process.env.IMPORT_IP_MAX = 'initial';

    handleRateLimits(undefined);

    // Should not modify any environment variables
    expect(process.env.FILE_UPLOAD_IP_MAX).toEqual('initial');
    expect(process.env.IMPORT_IP_MAX).toEqual('initial');
  });

  it('should handle partial rate limit configurations', () => {
    const rateLimits = {
      fileUploads: {
        ipMax: 200,
        // Only setting ipMax, other properties undefined
      },
    };

    handleRateLimits(rateLimits);

    expect(process.env.FILE_UPLOAD_IP_MAX).toEqual('200');
    // Other FILE_UPLOAD env vars should not be set
    expect(process.env.FILE_UPLOAD_IP_WINDOW).toBeUndefined();
    expect(process.env.FILE_UPLOAD_USER_MAX).toBeUndefined();
    expect(process.env.FILE_UPLOAD_USER_WINDOW).toBeUndefined();
  });

  it('should correctly set TTS and STT environment variables based on rate limits', () => {
    const rateLimits = {
      tts: {
        ipMax: 75,
        ipWindowInMinutes: 45,
        userMax: 25,
        userWindowInMinutes: 15,
      },
      stt: {
        ipMax: 80,
        ipWindowInMinutes: 50,
        userMax: 30,
        userWindowInMinutes: 20,
      },
    };

    handleRateLimits(rateLimits);

    // Verify TTS environment variables
    expect(process.env.TTS_IP_MAX).toEqual('75');
    expect(process.env.TTS_IP_WINDOW).toEqual('45');
    expect(process.env.TTS_USER_MAX).toEqual('25');
    expect(process.env.TTS_USER_WINDOW).toEqual('15');

    // Verify STT environment variables
    expect(process.env.STT_IP_MAX).toEqual('80');
    expect(process.env.STT_IP_WINDOW).toEqual('50');
    expect(process.env.STT_USER_MAX).toEqual('30');
    expect(process.env.STT_USER_WINDOW).toEqual('20');
  });

  it('should set authenticated agent-event admission limits', () => {
    handleRateLimits({
      agentEvents: {
        userMax: 80,
        userWindowInMinutes: 2,
      },
    });

    expect(process.env.AGENT_EVENT_USER_MAX).toEqual('80');
    expect(process.env.AGENT_EVENT_USER_WINDOW).toEqual('2');
  });
});
