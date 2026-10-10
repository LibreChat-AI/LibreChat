jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  extractVariableName: jest.fn(),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { handleRateLimits } from './limits';
import { checkVariables, checkWebSearchConfig, validateHexSecret } from './checks';
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

describe('validateHexSecret', () => {
  const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('should return null for a valid 64-character hex key', () => {
    expect(validateHexSecret('CREDS_KEY', validKey, 32)).toBeNull();
  });

  it('should return null for a valid 32-character hex IV', () => {
    expect(validateHexSecret('CREDS_IV', '0123456789abcdef0123456789abcdef', 16)).toBeNull();
  });

  it('should accept uppercase hex', () => {
    expect(validateHexSecret('CREDS_KEY', validKey.toUpperCase(), 32)).toBeNull();
  });

  it('should report 0 bytes for a passphrase', () => {
    const result = validateHexSecret('CREDS_KEY', 'my-secret-passphrase', 32);

    expect(result).toContain('CREDS_KEY');
    expect(result).toContain('decodes to 0 bytes');
    expect(result).toContain('Invalid key length');
  });

  it('should report the decoded prefix length for partially valid hex', () => {
    const result = validateHexSecret('CREDS_KEY', 'abc123XYZabc', 32);

    expect(result).toContain('decodes to 3 bytes');
  });

  it('should report 4 bytes for hex interrupted by invalid characters', () => {
    const result = validateHexSecret('CREDS_KEY', 'deadbeefZZdeadbeef', 32);

    expect(result).toContain('decodes to 4 bytes');
  });

  it('should report 31 bytes for a 63-character hex string', () => {
    const result = validateHexSecret('CREDS_KEY', validKey.slice(0, 63), 32);

    expect(result).toContain('decodes to 31 bytes');
    expect(result).toContain('Invalid key length');
  });

  it('should warn about the legacy AES-128 downgrade and v3 failure for a 32-character hex key', () => {
    const result = validateHexSecret('CREDS_KEY', '0123456789abcdef0123456789abcdef', 32);

    expect(result).toContain('decodes to 16 bytes');
    expect(result).toContain('silently use AES-128');
    expect(result).toContain('AES-256');
    expect(result).toContain('v3 encryption');
    expect(result).toContain('expected 32 bytes, got 16 bytes');
  });

  it('should warn about the legacy AES-192 downgrade and v3 failure for a 48-character hex key', () => {
    const result = validateHexSecret('CREDS_KEY', validKey.slice(0, 48), 32);

    expect(result).toContain('decodes to 24 bytes');
    expect(result).toContain('silently use AES-192');
    expect(result).toContain('expected 32 bytes, got 24 bytes');
  });

  it('should not claim a downgrade or failure when a trailing-garbage prefix decodes to the expected length', () => {
    const result = validateHexSecret('CREDS_KEY', `${validKey}"`, 32);

    expect(result).toContain('decodes to 32 bytes');
    expect(result).toContain('Encryption currently works');
    expect(result).not.toContain('silently use');
    expect(result).not.toContain('Invalid key length');
  });

  it('should report the IV constraint failure for a 32-character CREDS_IV mismatch', () => {
    const result = validateHexSecret('CREDS_IV', validKey, 16);

    expect(result).toContain('CREDS_IV');
    expect(result).toContain('decodes to 32 bytes');
    expect(result).toContain('algorithm.iv must contain exactly 16 bytes');
    expect(result).not.toContain('Invalid key length');
  });

  it('should report unset values distinctly', () => {
    const result = validateHexSecret('CREDS_KEY', undefined, 32);

    expect(result).toContain('CREDS_KEY is not set');
    expect(result).not.toContain('decodes to');
  });

  it('should report empty values as unset', () => {
    expect(validateHexSecret('CREDS_KEY', '', 32)).toContain('CREDS_KEY is not set');
  });

  it('should never include the secret value in the message', () => {
    const secret = 'supersecretvalue';
    const result = validateHexSecret('CREDS_KEY', secret, 32);

    expect(result).not.toContain(secret);
  });

  it('should include remediation guidance', () => {
    const result = validateHexSecret('CREDS_KEY', 'bad', 32);

    expect(result).toContain('https://www.librechat.ai/toolkit/creds_generator');
    expect(result).toContain('openssl rand -hex 32');
  });
});

describe('checkVariables - hex secret validation', () => {
  const validKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const validIv = '0123456789abcdef0123456789abcdef';
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    jest.clearAllMocks();
    originalEnv = process.env;
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should not log an error when both secrets are valid', () => {
    process.env.CREDS_KEY = validKey;
    process.env.CREDS_IV = validIv;

    checkVariables();

    expect(logger.error).not.toHaveBeenCalled();
  });

  it('should log an error mentioning CREDS_KEY when it is a passphrase', () => {
    process.env.CREDS_KEY = 'not-a-hex-key';
    process.env.CREDS_IV = validIv;

    checkVariables();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('CREDS_KEY'));
  });

  it('should log an error mentioning CREDS_IV when it is invalid', () => {
    process.env.CREDS_KEY = validKey;
    process.env.CREDS_IV = 'nope';

    checkVariables();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('CREDS_IV'));
  });

  it('should log errors for both secrets when both are unset', () => {
    delete process.env.CREDS_KEY;
    delete process.env.CREDS_IV;

    checkVariables();

    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('CREDS_KEY is not set'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('CREDS_IV is not set'));
  });

  it('should log the AES downgrade warning for a 32-character CREDS_KEY', () => {
    process.env.CREDS_KEY = validIv;
    process.env.CREDS_IV = validIv;

    checkVariables();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('silently use AES-128'));
  });

  it('should not log an error for the documented default secrets (shape is valid)', () => {
    process.env.CREDS_KEY = 'f34be427ebb29de8d88c107a71546019685ed8b241d8f2ed00c3df97ad2566f0';
    process.env.CREDS_IV = 'e2341419ec3dd3d19b13a1a87fafcbfb';

    checkVariables();

    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'Legacy default value for CREDS_KEY is being used. Generate and configure a unique value.',
    );
  });
});
