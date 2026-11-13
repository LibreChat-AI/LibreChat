import { extractEnvVariable, isSensitiveEnvVar } from '../src/utils';

describe('Environment Variable Extraction', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      TEST_API_KEY: 'test-api-key-value',
      ANOTHER_VALUE: 'another-value',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('extractEnvVariable (original tests)', () => {
    test('should return the value of the environment variable', () => {
      process.env.TEST_VAR = 'test_value';
      expect(extractEnvVariable('${TEST_VAR}')).toBe('test_value');
    });

    test('should return the original string if the envrionment variable is not defined correctly', () => {
      process.env.TEST_VAR = 'test_value';
      expect(extractEnvVariable('${ TEST_VAR }')).toBe('${ TEST_VAR }');
    });

    test('should return the original string if environment variable is not set', () => {
      expect(extractEnvVariable('${NON_EXISTENT_VAR}')).toBe('${NON_EXISTENT_VAR}');
    });

    test('should return the original string if it does not contain an environment variable', () => {
      expect(extractEnvVariable('some_string')).toBe('some_string');
    });

    test('should handle empty strings', () => {
      expect(extractEnvVariable('')).toBe('');
    });

    test('should handle strings without variable format', () => {
      expect(extractEnvVariable('no_var_here')).toBe('no_var_here');
    });
  });

  describe('extractEnvVariable function', () => {
    it('should extract environment variables from exact matches', () => {
      expect(extractEnvVariable('${TEST_API_KEY}')).toBe('test-api-key-value');
      expect(extractEnvVariable('${ANOTHER_VALUE}')).toBe('another-value');
    });

    it('should extract environment variables from strings with prefixes', () => {
      expect(extractEnvVariable('prefix-${TEST_API_KEY}')).toBe('prefix-test-api-key-value');
    });

    it('should extract environment variables from strings with suffixes', () => {
      expect(extractEnvVariable('${TEST_API_KEY}-suffix')).toBe('test-api-key-value-suffix');
    });

    it('should extract environment variables from strings with both prefixes and suffixes', () => {
      expect(extractEnvVariable('prefix-${TEST_API_KEY}-suffix')).toBe(
        'prefix-test-api-key-value-suffix',
      );
    });

    it('should not match invalid patterns', () => {
      expect(extractEnvVariable('$TEST_API_KEY')).toBe('$TEST_API_KEY');
      expect(extractEnvVariable('{TEST_API_KEY}')).toBe('{TEST_API_KEY}');
      expect(extractEnvVariable('TEST_API_KEY')).toBe('TEST_API_KEY');
    });
  });

  describe('extractEnvVariable', () => {
    it('should extract environment variable values', () => {
      expect(extractEnvVariable('${TEST_API_KEY}')).toBe('test-api-key-value');
      expect(extractEnvVariable('${ANOTHER_VALUE}')).toBe('another-value');
    });

    it('should return the original string if environment variable is not found', () => {
      expect(extractEnvVariable('${NON_EXISTENT_VAR}')).toBe('${NON_EXISTENT_VAR}');
    });

    it('should return the original string if no environment variable pattern is found', () => {
      expect(extractEnvVariable('plain-string')).toBe('plain-string');
    });
  });

  describe('extractEnvVariable space trimming', () => {
    beforeEach(() => {
      process.env.HELLO = 'world';
      process.env.USER = 'testuser';
    });

    it('should extract the value when string contains only an environment variable with surrounding whitespace', () => {
      expect(extractEnvVariable('        ${HELLO}        ')).toBe('world');
      expect(extractEnvVariable('  ${HELLO}  ')).toBe('world');
      expect(extractEnvVariable('\t${HELLO}\n')).toBe('world');
    });

    it('should preserve content when variable is part of a larger string', () => {
      expect(extractEnvVariable('Hello ${USER}!')).toBe('Hello testuser!');
      expect(extractEnvVariable('  Hello ${USER}!  ')).toBe('Hello testuser!');
    });

    it('should not handle multiple variables', () => {
      expect(extractEnvVariable('${HELLO} ${USER}')).toBe('${HELLO} ${USER}');
      expect(extractEnvVariable('  ${HELLO}   ${USER}  ')).toBe('${HELLO}   ${USER}');
    });

    it('should handle undefined variables', () => {
      expect(extractEnvVariable('        ${UNDEFINED_VAR}        ')).toBe('${UNDEFINED_VAR}');
    });

    it('should handle mixed content correctly', () => {
      expect(extractEnvVariable('Welcome, ${USER}!\nYour message: ${HELLO}')).toBe(
        'Welcome, testuser!\nYour message: world',
      );
    });
  });

  describe('isSensitiveEnvVar', () => {
    it('should flag infrastructure secrets', () => {
      expect(isSensitiveEnvVar('JWT_SECRET')).toBe(true);
      expect(isSensitiveEnvVar('JWT_REFRESH_SECRET')).toBe(true);
      expect(isSensitiveEnvVar('CREDS_KEY')).toBe(true);
      expect(isSensitiveEnvVar('CREDS_IV')).toBe(true);
      expect(isSensitiveEnvVar('MEILI_MASTER_KEY')).toBe(true);
      expect(isSensitiveEnvVar('MONGO_URI')).toBe(true);
      expect(isSensitiveEnvVar('MONGODB_ROOT_PASSWORD')).toBe(true);
      expect(isSensitiveEnvVar('REDIS_URI')).toBe(true);
      expect(isSensitiveEnvVar('REDIS_PASSWORD')).toBe(true);
    });

    it('should allow non-infrastructure vars through (including operator-configured secrets)', () => {
      expect(isSensitiveEnvVar('OPENAI_API_KEY')).toBe(false);
      expect(isSensitiveEnvVar('ANTHROPIC_API_KEY')).toBe(false);
      expect(isSensitiveEnvVar('GOOGLE_KEY')).toBe(false);
      expect(isSensitiveEnvVar('PROXY')).toBe(false);
      expect(isSensitiveEnvVar('DEBUG_LOGGING')).toBe(false);
      expect(isSensitiveEnvVar('DOMAIN_CLIENT')).toBe(false);
      expect(isSensitiveEnvVar('APP_TITLE')).toBe(false);
      expect(isSensitiveEnvVar('OPENID_CLIENT_SECRET')).toBe(false);
      expect(isSensitiveEnvVar('DISCORD_CLIENT_SECRET')).toBe(false);
      expect(isSensitiveEnvVar('MY_CUSTOM_SECRET')).toBe(false);
    });
  });

  describe('extractEnvVariable sensitive var blocklist', () => {
    beforeEach(() => {
      process.env.JWT_SECRET = 'super-secret-jwt';
      process.env.JWT_REFRESH_SECRET = 'super-secret-refresh';
      process.env.CREDS_KEY = 'encryption-key';
      process.env.CREDS_IV = 'encryption-iv';
      process.env.MEILI_MASTER_KEY = 'meili-key';
      process.env.MONGO_URI = 'mongodb://user:pass@host/db';
      process.env.REDIS_URI = 'redis://:pass@host:6379';
      process.env.REDIS_PASSWORD = 'redis-pass';
      process.env.OPENAI_API_KEY = 'sk-legit-key';
    });

    it('should refuse to resolve sensitive vars (single-match path)', () => {
      expect(extractEnvVariable('${JWT_SECRET}')).toBe('${JWT_SECRET}');
      expect(extractEnvVariable('${JWT_REFRESH_SECRET}')).toBe('${JWT_REFRESH_SECRET}');
      expect(extractEnvVariable('${CREDS_KEY}')).toBe('${CREDS_KEY}');
      expect(extractEnvVariable('${CREDS_IV}')).toBe('${CREDS_IV}');
      expect(extractEnvVariable('${MEILI_MASTER_KEY}')).toBe('${MEILI_MASTER_KEY}');
      expect(extractEnvVariable('${MONGO_URI}')).toBe('${MONGO_URI}');
      expect(extractEnvVariable('${REDIS_URI}')).toBe('${REDIS_URI}');
      expect(extractEnvVariable('${REDIS_PASSWORD}')).toBe('${REDIS_PASSWORD}');
    });

    it('should refuse to resolve sensitive vars in composite strings (multi-match path)', () => {
      expect(extractEnvVariable('key=${JWT_SECRET}&more')).toBe('key=${JWT_SECRET}&more');
      expect(extractEnvVariable('db=${MONGO_URI}/extra')).toBe('db=${MONGO_URI}/extra');
    });

    it('should still resolve non-sensitive vars normally', () => {
      expect(extractEnvVariable('${OPENAI_API_KEY}')).toBe('sk-legit-key');
      expect(extractEnvVariable('Bearer ${OPENAI_API_KEY}')).toBe('Bearer sk-legit-key');
    });

    it('should resolve non-sensitive vars while blocking sensitive ones in the same string', () => {
      expect(extractEnvVariable('key=${OPENAI_API_KEY}&secret=${JWT_SECRET}')).toBe(
        'key=sk-legit-key&secret=${JWT_SECRET}',
      );
    });
  });
});
