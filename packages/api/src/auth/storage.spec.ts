import express from 'express';
import type { SessionRecord, TokenRecord } from '@librechat/data-schemas';
import type { PasswordResetInput, PasswordResetResult } from './passwordReset';
import { createAuthenticationStorage } from './storage';
import { math } from '../utils/math';

const id = { toString: () => '0123456789abcdef01234567' };
const session: SessionRecord = Object.freeze({
  _id: '1123456789abcdef01234567',
  user: id.toString(),
  refreshTokenHash: 'previous-hash',
  expiration: new Date('2030-01-01'),
});
const token: TokenRecord = {
  _id: '2123456789abcdef01234567',
  userId: id.toString(),
  token: 'hashed-token',
  createdAt: new Date(),
  expiresAt: session.expiration,
};

function harness() {
  const user = { _id: { toString: () => 'canonical-user' }, tenantId: 'tenant-a' };
  const deps = {
    sessions: {
      findSession: jest.fn(async (): Promise<SessionRecord | null> => session),
      createSession: jest.fn(async () => ({ session, refreshToken: 'new-refresh' })),
      deleteSession: jest.fn(async () => ({ deletedCount: 1 })),
      generateRefreshToken: jest.fn(async () => 'rotated-refresh'),
      upsertSession: jest.fn(async () => session),
    },
    tokens: {
      findToken: jest.fn(async (): Promise<TokenRecord | null> => token),
      createToken: jest.fn(async () => token),
      deleteTokens: jest.fn(async () => ({ deletedCount: 1 })),
    },
    getUserById: jest.fn(async () => user),
    updateUser: jest.fn(async () => user),
    generateToken: jest.fn(async () => 'access-token'),
    resetPassword: jest.fn(
      async (_input: PasswordResetInput): Promise<PasswordResetResult> => ({ ok: false }),
    ),
    storeOpenIdSession: jest.fn(async () => true),
    setLocalSessionCookies: jest.fn(),
    setCloudFrontAuthCookies: jest.fn(),
    math,
    env: { REFRESH_TOKEN_EXPIRY: '2 * 60000', SESSION_EXPIRY: '30000' },
    defaultRefreshTokenExpiry: 604800000,
    defaultSessionExpiry: 900000,
    logger: { error: jest.fn(), debug: jest.fn() },
  };
  return { deps, user, service: createAuthenticationStorage(deps) };
}

describe('authentication persistence adaptation', () => {
  it.each([id.toString(), id])(
    'normalizes storage IDs without changing token filters or absence selectors',
    async (userId) => {
      const { service, deps } = harness();
      const options = { sort: { createdAt: -1 as const } };
      await service.findToken({ userId, type: null, email: null, identifier: null }, options);
      expect(deps.tokens.findToken).toHaveBeenCalledWith(
        { userId: id.toString(), type: null, email: null, identifier: null },
        options,
      );
      await service.createToken({ userId, token: 'hash', expiresIn: 900 });
      expect(deps.tokens.createToken).toHaveBeenCalledWith({
        userId: id.toString(),
        token: 'hash',
        expiresIn: 900,
      });
      await service.deleteTokens({ userId, token: 'hash' });
      expect(deps.tokens.deleteTokens).toHaveBeenCalledWith({
        userId: id.toString(),
        token: 'hash',
      });
      await service.verifyEmail(userId);
      expect(deps.updateUser).toHaveBeenCalledWith(id.toString(), { emailVerified: true });
      await service.resetPassword(userId, 'reset-token', 'password');
      expect(deps.resetPassword).toHaveBeenCalledWith({
        userId: id.toString(),
        token: 'reset-token',
        password: 'password',
      });
    },
  );

  it('preserves token-only lookup and deletion without introducing a user selector', async () => {
    const { service, deps } = harness();
    await service.findToken({ token: 'hash' });
    await service.deleteTokens({ token: 'hash' });
    expect(deps.tokens.findToken).toHaveBeenCalledWith({ token: 'hash' }, undefined);
    expect(deps.tokens.deleteTokens).toHaveBeenCalledWith({ token: 'hash' });
  });

  it('adapts OpenID session ownership and retains the previous credential', async () => {
    const { service, deps } = harness();
    await service.storeOpenIDSession(id, 'new', 'tenant-a', 'old');
    expect(deps.storeOpenIdSession).toHaveBeenCalledWith(
      {
        userId: id.toString(),
        refreshToken: 'new',
        tenantId: 'tenant-a',
        previousRefreshToken: 'old',
      },
      { upsertSession: deps.sessions.upsertSession, deleteSession: deps.sessions.deleteSession },
    );
  });

  it('creates a native session, reads the user once and uses its canonical cookie scope', async () => {
    const { service, deps, user } = harness();
    await expect(service.setAuthTokens(id, express.response)).resolves.toBe('access-token');
    expect(deps.sessions.createSession).toHaveBeenCalledWith(id.toString(), { expiresIn: 120000 });
    expect(deps.getUserById).toHaveBeenCalledTimes(1);
    expect(deps.getUserById).toHaveBeenCalledWith(id.toString());
    expect(deps.generateToken).toHaveBeenCalledWith(user, 30000);
    expect(deps.setLocalSessionCookies).toHaveBeenCalledWith(express.response, {
      refreshToken: 'new-refresh',
      expires: session.expiration,
      userId: 'canonical-user',
      tenantId: 'tenant-a',
    });
    expect(deps.setCloudFrontAuthCookies).toHaveBeenCalledWith(null, express.response, user, {
      userId: 'canonical-user',
    });
  });

  it('rotates an immutable plain snapshot without creating a replacement or mutating it', async () => {
    const { service, deps } = harness();
    await service.setAuthTokens(id, express.response, session);
    expect(deps.sessions.generateRefreshToken).toHaveBeenCalledWith(session);
    expect(deps.sessions.createSession).not.toHaveBeenCalled();
    expect(session.refreshTokenHash).toBe('previous-hash');
  });

  it('issues no cookies or access token when rotation fails and logs bounded metadata only', async () => {
    const { service, deps } = harness();
    const error = new Error('private refresh credential and SQL');
    deps.sessions.generateRefreshToken.mockRejectedValueOnce(error);
    await expect(service.setAuthTokens(id, express.response, session)).rejects.toBe(error);
    expect(deps.sessions.createSession).not.toHaveBeenCalled();
    expect(deps.generateToken).not.toHaveBeenCalled();
    expect(deps.setLocalSessionCookies).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[setAuthTokens] Error in setting authentication tokens:',
      { type: 'Error' },
    );
    expect(JSON.stringify(deps.logger.error.mock.calls)).not.toContain('private');
  });

  it('normalizes logout ownership and deletes the stored session before destroying the browser session', async () => {
    const { service, deps } = harness();
    const destroy = jest.fn();
    await expect(
      service.logoutUser({ user: { _id: id }, session: { destroy } }, 'refresh'),
    ).resolves.toEqual({ status: 200, message: 'Logout successful' });
    expect(deps.sessions.findSession).toHaveBeenCalledWith({
      userId: id.toString(),
      refreshToken: 'refresh',
    });
    expect(deps.sessions.deleteSession).toHaveBeenCalledWith({ sessionId: session._id });
    expect(deps.sessions.deleteSession.mock.invocationCallOrder[0]).toBeLessThan(
      destroy.mock.invocationCallOrder[0],
    );
  });

  it('does not destroy the browser session when durable revocation fails', async () => {
    const { service, deps } = harness();
    deps.sessions.deleteSession.mockRejectedValueOnce(new Error('private SQL'));
    const destroy = jest.fn();
    await expect(
      service.logoutUser({ user: { _id: id }, session: { destroy } }, 'refresh'),
    ).resolves.toEqual({ status: 500, message: 'Failed to delete session.' });
    expect(destroy).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith('[logoutUser] Failed to delete session.', {
      type: 'Error',
    });
  });

  it('keeps logout response codes and redacts lookup and browser-destruction failures', async () => {
    const { service, deps } = harness();
    deps.sessions.findSession.mockRejectedValueOnce(new Error('private SQL'));
    await expect(service.logoutUser({ user: { _id: id } }, 'refresh')).resolves.toEqual({
      status: 500,
      message: 'Failed to logout.',
    });
    const destroy = jest.fn(() => {
      throw new Error('private cookie');
    });
    await expect(
      service.logoutUser({ user: { _id: id }, session: { destroy } }, 'refresh'),
    ).resolves.toEqual({ status: 200, message: 'Logout successful' });
    expect(deps.logger.debug).toHaveBeenCalledWith('[logoutUser] Failed to destroy session.', {
      type: 'Error',
    });
  });
});
