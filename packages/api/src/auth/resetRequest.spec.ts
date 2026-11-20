import { logger } from '@librechat/data-schemas';
import type { PasswordResetRequestDeps, PasswordResetRequestInput } from './resetRequest';
import { issuePasswordReset, PASSWORD_RESET_REQUEST_MESSAGE } from './resetRequest';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), error: jest.fn() },
}));

const secret = 'private-reset-secret';
const hash = 'private-reset-hash';
const input: PasswordResetRequestInput = {
  user: { _id: 'user-reset', email: 'User@example.com', name: 'User' },
  emailEnabled: true,
  clientUrl: 'https://chat.example.com',
  appName: 'LibreChat',
};
const response = { message: PASSWORD_RESET_REQUEST_MESSAGE };

function createDeps(): jest.Mocked<PasswordResetRequestDeps> {
  return {
    deleteTokens: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    createToken: jest.fn().mockResolvedValue({}),
    createTokenHash: jest.fn().mockResolvedValue([secret, hash]),
    sendEmail: jest.fn().mockResolvedValue(undefined),
  };
}

function loggedText(): string {
  return JSON.stringify([
    jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.error).mock.calls,
  ]);
}

beforeEach(() => jest.clearAllMocks());

describe('issuePasswordReset', () => {
  it.each([input.user, null])('does nothing without email delivery (account: %p)', async (user) => {
    const deps = createDeps();

    await expect(
      issuePasswordReset(deps, { ...input, user, emailEnabled: false }),
    ).resolves.toEqual(response);

    expect(deps.createTokenHash).not.toHaveBeenCalled();
    expect(deps.createToken).not.toHaveBeenCalled();
    expect(deps.deleteTokens).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(secret);
    expect(loggedText()).not.toContain(hash);
  });

  it('answers an unknown account identically without issuing credentials', async () => {
    const deps = createDeps();

    await expect(issuePasswordReset(deps, { ...input, user: null })).resolves.toEqual(response);

    expect(deps.createTokenHash).not.toHaveBeenCalled();
    expect(deps.createToken).not.toHaveBeenCalled();
    expect(deps.deleteTokens).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('stores only a hash and sends the link exclusively by email', async () => {
    const deps = createDeps();

    await expect(issuePasswordReset(deps, input)).resolves.toEqual(response);

    expect(deps.createToken).toHaveBeenCalledWith({
      userId: 'user-reset',
      email: 'user@example.com',
      type: 'password_reset',
      token: hash,
      createdAt: expect.any(Number),
      expiresIn: 900,
    });
    expect(deps.sendEmail).toHaveBeenCalledWith({
      email: 'User@example.com',
      subject: 'Password Reset Request',
      payload: {
        appName: 'LibreChat',
        name: 'User',
        link: `https://chat.example.com/reset-password?token=${secret}&userId=user-reset`,
        year: new Date().getFullYear(),
      },
      template: 'requestPasswordReset.handlebars',
    });
    expect(deps.createToken.mock.invocationCallOrder[0]).toBeLessThan(
      deps.sendEmail.mock.invocationCallOrder[0],
    );
    expect(deps.deleteTokens.mock.calls).toEqual([
      [{ userId: 'user-reset', type: 'password_reset' }],
      [{ userId: 'user-reset', email: null, identifier: null, type: null }],
    ]);
    expect(loggedText()).not.toContain(secret);
    expect(loggedText()).not.toContain(hash);
  });

  it('revokes only the undelivered token and hides provider error content', async () => {
    const deps = createDeps();
    deps.sendEmail.mockRejectedValue(
      Object.assign(new Error(`SMTP rejected token=${secret}`), {
        response: { status: 503, data: { secret, hash } },
        config: { headers: { Authorization: secret } },
      }),
    );

    await expect(issuePasswordReset(deps, input)).resolves.toEqual(response);

    expect(deps.deleteTokens).toHaveBeenLastCalledWith({
      userId: 'user-reset',
      type: 'password_reset',
      token: hash,
    });
    expect(logger.error).toHaveBeenCalledWith('[requestPasswordReset] Email delivery failed', {
      type: 'Error',
      status: 503,
    });
    expect(logger.info).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(secret);
    expect(loggedText()).not.toContain(hash);
  });

  it('does not enumerate accounts or log secrets when delivery cleanup also fails', async () => {
    const deps = createDeps();
    deps.sendEmail.mockRejectedValue(new Error(secret));
    deps.deleteTokens
      .mockResolvedValueOnce({ deletedCount: 0 })
      .mockResolvedValueOnce({ deletedCount: 0 })
      .mockRejectedValueOnce(new Error(hash));

    await expect(issuePasswordReset(deps, input)).resolves.toEqual(response);

    expect(logger.error).toHaveBeenCalledWith(
      '[requestPasswordReset] Undelivered token cleanup failed',
      { type: 'Error' },
    );
    expect(loggedText()).not.toContain(secret);
    expect(loggedText()).not.toContain(hash);
  });
});
