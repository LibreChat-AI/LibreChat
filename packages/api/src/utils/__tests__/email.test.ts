import { logger } from '@librechat/data-schemas';
import { checkEmailConfig, handleEmailError } from '../email';

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

const savedEnv = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv };
  delete process.env.EMAIL_SERVICE;
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_USERNAME;
  delete process.env.EMAIL_PASSWORD;
  delete process.env.EMAIL_FROM;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
});

afterAll(() => {
  process.env = savedEnv;
});

describe('checkEmailConfig', () => {
  describe('SMTP configuration', () => {
    it('returns true with EMAIL_HOST and EMAIL_FROM (no credentials)', () => {
      process.env.EMAIL_HOST = 'smtp.example.com';
      process.env.EMAIL_FROM = 'noreply@example.com';
      expect(checkEmailConfig()).toBe(true);
    });

    it('returns true with EMAIL_SERVICE and EMAIL_FROM (no credentials)', () => {
      process.env.EMAIL_SERVICE = 'gmail';
      process.env.EMAIL_FROM = 'noreply@example.com';
      expect(checkEmailConfig()).toBe(true);
    });

    it('returns true with EMAIL_HOST, EMAIL_FROM, and full credentials', () => {
      process.env.EMAIL_HOST = 'smtp.example.com';
      process.env.EMAIL_FROM = 'noreply@example.com';
      process.env.EMAIL_USERNAME = 'user';
      process.env.EMAIL_PASSWORD = 'pass';
      expect(checkEmailConfig()).toBe(true);
    });

    it('returns false when EMAIL_FROM is missing', () => {
      process.env.EMAIL_HOST = 'smtp.example.com';
      expect(checkEmailConfig()).toBe(false);
    });

    it('returns false when neither EMAIL_HOST nor EMAIL_SERVICE is set', () => {
      process.env.EMAIL_FROM = 'noreply@example.com';
      expect(checkEmailConfig()).toBe(false);
    });

    it('returns false when no email env vars are set', () => {
      expect(checkEmailConfig()).toBe(false);
    });
  });

  describe('partial credential warning', () => {
    it('logs a warning when only EMAIL_USERNAME is set', () => {
      process.env.EMAIL_HOST = 'smtp.example.com';
      process.env.EMAIL_FROM = 'noreply@example.com';
      process.env.EMAIL_USERNAME = 'user';
      checkEmailConfig();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
      );
    });

    it('logs a warning when only EMAIL_PASSWORD is set', () => {
      process.env.EMAIL_HOST = 'smtp.example.com';
      process.env.EMAIL_FROM = 'noreply@example.com';
      process.env.EMAIL_PASSWORD = 'pass';
      checkEmailConfig();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
      );
    });

    it('does not warn when both credentials are set', () => {
      process.env.EMAIL_HOST = 'smtp.example.com';
      process.env.EMAIL_FROM = 'noreply@example.com';
      process.env.EMAIL_USERNAME = 'user';
      process.env.EMAIL_PASSWORD = 'pass';
      checkEmailConfig();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not warn when neither credential is set', () => {
      process.env.EMAIL_HOST = 'smtp.example.com';
      process.env.EMAIL_FROM = 'noreply@example.com';
      checkEmailConfig();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('does not warn for partial credentials when SMTP is not configured', () => {
      process.env.EMAIL_USERNAME = 'user';
      checkEmailConfig();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('Mailgun configuration', () => {
    it('returns true with Mailgun API key, domain, and EMAIL_FROM', () => {
      process.env.MAILGUN_API_KEY = 'key-abc123';
      process.env.MAILGUN_DOMAIN = 'mg.example.com';
      process.env.EMAIL_FROM = 'noreply@example.com';
      expect(checkEmailConfig()).toBe(true);
    });

    it('returns false when Mailgun is partially configured', () => {
      process.env.MAILGUN_API_KEY = 'key-abc123';
      expect(checkEmailConfig()).toBe(false);
    });
  });
});

describe('handleEmailError', () => {
  const secret = 'private-recovery-content';
  const providerError = Object.assign(new Error(secret), {
    response: { status: 503, headers: { secret }, data: { html: secret } },
    config: { headers: { Authorization: secret } },
  });

  it('throws only a new fixed-message error with safe metadata', () => {
    let failure;
    try {
      handleEmailError(providerError, true);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBe(providerError);
    expect(failure).toMatchObject({ message: 'Email delivery failed', type: 'Error', status: 503 });
    expect(failure).not.toHaveProperty('cause');
    expect(failure).not.toHaveProperty('response');
    expect(failure).not.toHaveProperty('config');
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns only the sanitized error when throwing is disabled', () => {
    const failure = handleEmailError(providerError, false);
    expect(failure.message).toBe('Email delivery failed');
    expect(failure.stack).not.toContain(secret);
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(logger.error).toHaveBeenCalledWith('[sendEmail]', { type: 'Error', status: 503 });
    expect(JSON.stringify(jest.mocked(logger.error).mock.calls)).not.toContain(secret);
  });
});
