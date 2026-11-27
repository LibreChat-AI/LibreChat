const nodemailer = require('nodemailer');
const { readFileAsString } = require('@librechat/api');

jest.mock('nodemailer');
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../../../packages/api/src/utils/email'),
  logAxiosError: jest.fn(),
  isEnabled: jest.fn((val) => val === 'true' || val === true),
  readFileAsString: jest.fn(),
  serviceRequestBudget: jest.fn(() => ({ timeout: 10000 })),
}));

const savedEnv = { ...process.env };

const mockSendMail = jest.fn().mockResolvedValue({ messageId: 'test-id' });

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...savedEnv };
  process.env.EMAIL_HOST = 'smtp.example.com';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_FROM = 'noreply@example.com';
  process.env.APP_TITLE = 'TestApp';
  delete process.env.EMAIL_USERNAME;
  delete process.env.EMAIL_PASSWORD;
  delete process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_DOMAIN;
  delete process.env.EMAIL_SERVICE;
  delete process.env.EMAIL_ENCRYPTION;
  delete process.env.EMAIL_ENCRYPTION_HOSTNAME;
  delete process.env.EMAIL_ALLOW_SELFSIGNED;

  readFileAsString.mockResolvedValue({ content: '<p>{{name}}</p>' });
  nodemailer.createTransport.mockReturnValue({ sendMail: mockSendMail });
});

afterAll(() => {
  process.env = savedEnv;
});

/** Loads a fresh copy of sendEmail so process.env reads are re-evaluated. */
function loadSendEmail() {
  jest.resetModules();
  jest.mock('nodemailer', () => ({
    createTransport: jest.fn().mockReturnValue({ sendMail: mockSendMail }),
  }));
  jest.mock('@librechat/data-schemas', () => ({
    logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  }));
  jest.mock('@librechat/api', () => ({
    ...jest.requireActual('../../../../packages/api/src/utils/email'),
    logAxiosError: jest.fn(),
    isEnabled: jest.fn((val) => val === 'true' || val === true),
    readFileAsString: jest.fn().mockResolvedValue({ content: '<p>{{name}}</p>' }),
    serviceRequestBudget: jest.fn(() => ({ timeout: 10000 })),
  }));
  return require('../sendEmail');
}

const baseParams = {
  email: 'user@example.com',
  subject: 'Test',
  payload: { name: 'User' },
  template: 'test.handlebars',
};

describe('sendEmail SMTP auth assembly', () => {
  it('includes auth when both EMAIL_USERNAME and EMAIL_PASSWORD are set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');

    await sendEmail(baseParams);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toEqual({
      user: 'smtp_user',
      pass: 'smtp_pass',
    });
  });

  it('omits auth when both EMAIL_USERNAME and EMAIL_PASSWORD are absent', async () => {
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');

    await sendEmail(baseParams);

    expect(createTransport).toHaveBeenCalledTimes(1);
    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
  });

  it('omits auth and logs a warning when only EMAIL_USERNAME is set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
    expect(freshLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
    );
  });

  it('omits auth and logs a warning when only EMAIL_PASSWORD is set', async () => {
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions.auth).toBeUndefined();
    expect(freshLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EMAIL_USERNAME and EMAIL_PASSWORD must both be set'),
    );
  });

  it('does not log a warning when both credentials are properly set', async () => {
    process.env.EMAIL_USERNAME = 'smtp_user';
    process.env.EMAIL_PASSWORD = 'smtp_pass';
    const sendEmail = loadSendEmail();
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    expect(freshLogger.warn).not.toHaveBeenCalled();
  });

  it('does not log a warning when both credentials are absent', async () => {
    const sendEmail = loadSendEmail();
    const { logger: freshLogger } = require('@librechat/data-schemas');

    await sendEmail(baseParams);

    expect(freshLogger.warn).not.toHaveBeenCalled();
  });
});

describe('sendEmail SMTP encryption options', () => {
  it('requires STARTTLS when EMAIL_ENCRYPTION=starttls', async () => {
    process.env.EMAIL_ENCRYPTION = 'starttls';
    const sendEmail = loadSendEmail();
    const { createTransport } = require('nodemailer');

    await sendEmail(baseParams);

    const transporterOptions = createTransport.mock.calls[0][0];
    expect(transporterOptions).toMatchObject({ secure: false, requireTLS: true });
  });
});

describe('sendEmail Mailgun failures', () => {
  it.each([true, false])('sanitizes provider errors (throwError: %s)', async (throwError) => {
    process.env.MAILGUN_API_KEY = 'test-key';
    process.env.MAILGUN_DOMAIN = 'mail.example.com';
    const sendEmail = loadSendEmail();
    const axios = require('axios');
    const { logger } = require('@librechat/data-schemas');
    const { logAxiosError } = require('@librechat/api');
    const secret = 'private-recovery-secret';
    const error = Object.assign(new Error(secret), {
      isAxiosError: true,
      response: { status: 503, data: { html: secret } },
    });
    const post = jest.spyOn(axios, 'post').mockRejectedValueOnce(error);
    try {
      let failure;
      try {
        failure = await sendEmail({ ...baseParams, throwError });
        expect(throwError).toBe(false);
      } catch (caught) {
        failure = caught;
        expect(throwError).toBe(true);
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBe(error);
      expect(failure.message).toBe('Email delivery failed');
      expect(failure.status).toBe(503);
      expect(failure).not.toHaveProperty('cause');
      expect(failure).not.toHaveProperty('response');
      expect(failure).not.toHaveProperty('config');
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(failure.stack).not.toContain(secret);
      expect(logAxiosError).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(secret);
    } finally {
      post.mockRestore();
    }
  });
});
