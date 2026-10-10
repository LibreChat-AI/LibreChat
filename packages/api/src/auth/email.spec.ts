import { hashToken } from '@librechat/data-schemas';
import type { TokenQuery } from '@librechat/data-schemas';
import {
  EMAIL_CHANGE_TOKEN_TYPE,
  createEmailChangeService,
  emailChangeSubmissionKey,
  type EmailChangeDeps,
  type EmailChangeToken,
  type EmailChangeUser,
} from './email';

const user: EmailChangeUser = {
  _id: '507f1f77bcf86cd799439011',
  email: 'old@example.com',
  name: 'Test User',
  password: 'password-hash',
  provider: 'local',
  tenantId: 'tenant-1',
};

function createDeps(overrides: Partial<EmailChangeDeps> = {}) {
  const deps: EmailChangeDeps = {
    findUserByEmail: jest.fn().mockResolvedValue(null),
    getUserById: jest.fn().mockResolvedValue(user),
    updateUser: jest.fn().mockResolvedValue({ ...user, email: 'new@example.com' }),
    findToken: jest.fn().mockResolvedValue(null),
    replaceTokenIfCurrent: jest.fn().mockResolvedValue(true),
    deleteTokens: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    verifyPassword: jest.fn().mockResolvedValue(true),
    resolvePolicy: jest.fn().mockResolvedValue({
      settings: { enabled: true, tokenTTLSeconds: 900 },
      allowedDomains: null,
    }),
    sendEmail: jest.fn().mockResolvedValue(undefined),
    resolveSettings: jest.fn().mockResolvedValue({ enabled: true, tokenTTLSeconds: 900 }),
    clientDomain: 'https://chat.example.com/',
    appName: 'LibreChat',
    ...overrides,
  };
  return { deps, service: createEmailChangeService(deps) };
}

const DEFAULT_SETTINGS = { enabled: true, tokenTTLSeconds: 900 };

describe('emailChangeSubmissionKey', () => {
  it('isolates confirmation attempts by address and by account', () => {
    const first = emailChangeSubmissionKey('203.0.113.10', '507f1f77bcf86cd799439011');
    const second = emailChangeSubmissionKey('203.0.113.10', '507f1f77bcf86cd799439012');

    expect(first).toBe('ip:203.0.113.10:user:507f1f77bcf86cd799439011');
    expect(first).not.toBe(second);
  });

  it('collapses ids that cannot name an account into one bucket', () => {
    /** Otherwise a caller mints a fresh allowance by varying an id it invented. */
    expect(emailChangeSubmissionKey('203.0.113.10', 'not-an-id')).toBe(
      'ip:203.0.113.10:user:invalid',
    );
    expect(emailChangeSubmissionKey('203.0.113.10', undefined)).toBe(
      'ip:203.0.113.10:user:invalid',
    );
    expect(emailChangeSubmissionKey('203.0.113.10', { toString: () => 'x' })).toBe(
      'ip:203.0.113.10:user:invalid',
    );
  });

  it('normalizes the case of an id so one account is one bucket', () => {
    expect(emailChangeSubmissionKey('203.0.113.10', '507F1F77BCF86CD799439011')).toBe(
      'ip:203.0.113.10:user:507f1f77bcf86cd799439011',
    );
  });
});

describe('email change service', () => {
  describe('requestEmailChange', () => {
    it('rejects requests when email changes are disabled', async () => {
      const { deps, service } = createDeps({});

      const response = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'new@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: { enabled: false, tokenTTLSeconds: 900 },
        emailEnabled: true,
      });

      expect(response).toEqual({
        status: 403,
        message: 'Email changes are disabled',
        code: 'email_change_disabled',
      });
      expect(deps.getUserById).not.toHaveBeenCalled();
      expect(deps.sendEmail).not.toHaveBeenCalled();
    });

    it('verifies the password, records the IP, alerts the old address, and verifies the new one', async () => {
      const { deps, service } = createDeps();

      const response = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: ' New@Example.com ' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        allowedDomains: ['example.com'],
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
        ip: '203.0.113.8',
      });

      expect(response).toEqual({
        status: 200,
        message: 'Verification link sent to your new email address',
      });
      expect(deps.verifyPassword).toHaveBeenCalledWith(user, 'correct-password');
      expect(deps.replaceTokenIfCurrent).toHaveBeenCalledWith(
        'email_change:507f1f77bcf86cd799439011',
        null,
        expect.objectContaining({
          userId: '507f1f77bcf86cd799439011',
          email: 'new@example.com',
          scope: 'email_change:507f1f77bcf86cd799439011',
          identifier: 'old@example.com',
          type: EMAIL_CHANGE_TOKEN_TYPE,
          expiresIn: 900,
          metadata: {
            requestIp: '203.0.113.8',
            passwordFingerprint: expect.any(String),
          },
        }),
        'tenant-1',
      );
      expect(deps.sendEmail).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          email: 'old@example.com',
          template: 'emailChangeAttempt.handlebars',
        }),
      );
      expect(deps.sendEmail).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          email: 'new@example.com',
          template: 'verifyEmailChange.handlebars',
          payload: expect.objectContaining({
            verificationLink: expect.stringMatching(
              /^https:\/\/chat\.example\.com\/verify\?type=email-change&userId=507f1f77bcf86cd799439011&email=new%40example\.com&token=/,
            ),
            linkLifetime: '15 minutes',
          }),
        }),
      );
    });

    it('never says a link lasts longer than it does', async () => {
      const { deps, service } = createDeps();

      await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'new@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        /** Ninety minutes is not two hours; rounding up would outlive the token. */
        settings: { enabled: true, tokenTTLSeconds: 5400 },
        emailEnabled: true,
      });

      expect(deps.sendEmail).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          template: 'verifyEmailChange.handlebars',
          payload: expect.objectContaining({ linkLifetime: '90 minutes' }),
        }),
      );
    });

    it('states the lifetime the link was actually issued with', async () => {
      const { deps, service } = createDeps();

      await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'new@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: { enabled: true, tokenTTLSeconds: 3600 },
        emailEnabled: true,
      });

      expect(deps.replaceTokenIfCurrent).toHaveBeenCalledWith(
        expect.any(String),
        null,
        expect.objectContaining({ expiresIn: 3600 }),
        expect.anything(),
      );
      expect(deps.sendEmail).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          template: 'verifyEmailChange.handlebars',
          payload: expect.objectContaining({ linkLifetime: '1 hour' }),
        }),
      );
    });

    it('stores the link when the observed token expires away during delivery', async () => {
      /** The expiry monitor can sweep an already-expired token while the message is in
       *  flight; the recipient holds a live link, so the request must not report a race. */
      const swept = { token: 'expired-token' };
      const findToken: EmailChangeDeps['findToken'] = jest.fn(async () => ({
        userId: '507f1f77bcf86cd799439011',
        email: 'stale@example.com',
        token: swept.token,
      }));
      const replaceTokenIfCurrent: EmailChangeDeps['replaceTokenIfCurrent'] = jest.fn(
        async (_scope, expectedToken) => expectedToken === null,
      );
      const { deps, service } = createDeps({ findToken, replaceTokenIfCurrent });

      const response = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'new@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
      });

      expect(response).toMatchObject({ status: 200 });
      expect(deps.replaceTokenIfCurrent).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        'expired-token',
        expect.anything(),
        expect.anything(),
      );
      expect(deps.replaceTokenIfCurrent).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        null,
        expect.anything(),
        expect.anything(),
      );
    });

    it('still reports a race when another request holds the scope', async () => {
      const findToken: EmailChangeDeps['findToken'] = jest.fn(async () => ({
        userId: '507f1f77bcf86cd799439011',
        email: 'stale@example.com',
        token: 'observed-token',
      }));
      /** A competitor replaced the scoped token, so neither the observed hash nor an empty
       *  scope is available to claim. */
      const replaceTokenIfCurrent: EmailChangeDeps['replaceTokenIfCurrent'] = jest.fn(
        async () => false,
      );
      const { deps, service } = createDeps({ findToken, replaceTokenIfCurrent });

      const response = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'new@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
      });

      expect(response).toMatchObject({ status: 409, code: 'request_in_progress' });
      expect(deps.replaceTokenIfCurrent).toHaveBeenCalledTimes(2);
    });

    it('notifies the old address but does not disclose conflicts until the password is valid', async () => {
      const { deps, service } = createDeps({
        verifyPassword: jest.fn().mockResolvedValue(false),
        findUserByEmail: jest.fn().mockResolvedValue({ ...user, _id: '507f1f77bcf86cd799439012' }),
      });

      const response = await service.requestEmailChange({
        body: { currentPassword: 'wrong-password', newEmail: 'taken@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
        ip: '203.0.113.9',
      });

      expect(response).toMatchObject({ status: 403, code: 'current_password_invalid' });
      expect(deps.sendEmail).toHaveBeenCalledTimes(1);
      expect(deps.findUserByEmail).not.toHaveBeenCalled();
      expect(deps.replaceTokenIfCurrent).not.toHaveBeenCalled();
    });

    it('returns an explicit conflict when the verified new address belongs to another account', async () => {
      const { deps, service } = createDeps({
        findUserByEmail: jest.fn().mockResolvedValue({
          ...user,
          _id: '507f1f77bcf86cd799439012',
          email: 'taken@example.com',
        }),
      });

      const response = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'taken@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
      });

      expect(response).toMatchObject({ status: 409, code: 'email_in_use' });
      expect(deps.replaceTokenIfCurrent).not.toHaveBeenCalled();
    });

    it('does not issue a link when a concurrent confirmation moves the account', async () => {
      const { deps, service } = createDeps({
        getUserById: jest
          .fn()
          .mockResolvedValueOnce(user)
          .mockResolvedValueOnce({ ...user, email: 'confirmed@example.com' }),
      });

      const response = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'new@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
      });

      expect(response).toMatchObject({ status: 409, code: 'account_modified' });
      expect(deps.replaceTokenIfCurrent).not.toHaveBeenCalled();
      expect(deps.deleteTokens).not.toHaveBeenCalled();
      expect(deps.sendEmail).not.toHaveBeenCalledWith(
        expect.objectContaining({ template: 'verifyEmailChange.handlebars' }),
      );
    });

    it('does not replace the pending token if verification delivery fails', async () => {
      const sendEmail = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('SMTP unavailable'));
      const { deps, service } = createDeps({ sendEmail });

      const response = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'new@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
      });

      expect(response).toMatchObject({ status: 500, code: 'email_delivery_failed' });
      expect(deps.replaceTokenIfCurrent).not.toHaveBeenCalled();
      expect(deps.deleteTokens).not.toHaveBeenCalled();
    });

    it('preserves a successful overlapping request when the replacing delivery fails', async () => {
      type StoredToken = Pick<
        Parameters<EmailChangeDeps['replaceTokenIfCurrent']>[2],
        'email' | 'token'
      >;
      let storedToken: StoredToken | undefined = {
        email: 'existing@example.com',
        token: 'existing-token',
      };
      const findToken: EmailChangeDeps['findToken'] = jest.fn(async () =>
        storedToken
          ? {
              userId: '507f1f77bcf86cd799439011',
              email: storedToken.email,
              token: storedToken.token,
            }
          : null,
      );
      const replaceTokenIfCurrent: EmailChangeDeps['replaceTokenIfCurrent'] = jest.fn(
        async (_scope, expectedToken, data) => {
          if ((storedToken?.token ?? null) !== expectedToken) {
            return false;
          }
          storedToken = { email: data.email, token: data.token };
          return true;
        },
      );
      const deleteTokens: EmailChangeDeps['deleteTokens'] = jest.fn(async (query) => {
        if (storedToken?.token === query.token) {
          storedToken = undefined;
        }
        return { deletedCount: 1 };
      });
      let markFirstDeliveryStarted: () => void = () => undefined;
      const firstDeliveryStarted = new Promise<void>((resolve) => {
        markFirstDeliveryStarted = resolve;
      });
      let completeFirstDelivery: () => void = () => undefined;
      const firstDelivery = new Promise<void>((resolve) => {
        completeFirstDelivery = resolve;
      });
      const sendEmail: EmailChangeDeps['sendEmail'] = jest.fn((data) => {
        if (data.template !== 'verifyEmailChange.handlebars') {
          return Promise.resolve();
        }
        if (data.email === 'first@example.com') {
          markFirstDeliveryStarted();
          return firstDelivery;
        }
        return Promise.reject(new Error('SMTP unavailable'));
      });
      const { service } = createDeps({
        findToken,
        replaceTokenIfCurrent,
        deleteTokens,
        sendEmail,
      });

      const firstRequest = service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'first@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
      });
      await firstDeliveryStarted;

      const secondResponse = await service.requestEmailChange({
        body: { currentPassword: 'correct-password', newEmail: 'second@example.com' },
        userId: '507f1f77bcf86cd799439011',
        tenantId: 'tenant-1',
        settings: DEFAULT_SETTINGS,
        emailEnabled: true,
      });

      expect(secondResponse).toMatchObject({ status: 500, code: 'email_delivery_failed' });
      expect(storedToken).toEqual({
        email: 'existing@example.com',
        token: 'existing-token',
      });

      completeFirstDelivery();
      await expect(firstRequest).resolves.toMatchObject({ status: 200 });
      expect(storedToken).toEqual({
        email: 'first@example.com',
        token: expect.any(String),
      });
    });

    it('returns success only for the token that wins an overlapping replacement', async () => {
      type StoredToken = { email?: string; token: string };
      let storedToken: StoredToken | undefined;
      let releaseReads: () => void = () => undefined;
      const bothPredecessorsRead = new Promise<void>((resolve) => {
        releaseReads = resolve;
      });
      let reads = 0;
      const findToken: EmailChangeDeps['findToken'] = jest.fn(async () => {
        const snapshot = storedToken;
        reads += 1;
        if (reads === 2) {
          releaseReads();
        }
        await bothPredecessorsRead;
        return snapshot
          ? {
              userId: '507f1f77bcf86cd799439011',
              email: snapshot.email,
              token: snapshot.token,
            }
          : null;
      });
      const replaceTokenIfCurrent: EmailChangeDeps['replaceTokenIfCurrent'] = jest.fn(
        async (_scope, expectedToken, data) => {
          if ((storedToken?.token ?? null) !== expectedToken) {
            return false;
          }
          storedToken = { email: data.email, token: data.token };
          return true;
        },
      );
      const { service } = createDeps({
        findToken,
        replaceTokenIfCurrent,
      });

      const responses = await Promise.all([
        service.requestEmailChange({
          body: { currentPassword: 'correct-password', newEmail: 'first@example.com' },
          userId: '507f1f77bcf86cd799439011',
          tenantId: 'tenant-1',
          settings: DEFAULT_SETTINGS,
          emailEnabled: true,
        }),
        service.requestEmailChange({
          body: { currentPassword: 'correct-password', newEmail: 'second@example.com' },
          userId: '507f1f77bcf86cd799439011',
          tenantId: 'tenant-1',
          settings: DEFAULT_SETTINGS,
          emailEnabled: true,
        }),
      ]);

      expect(
        responses.map(({ status, code }) => ({ status, code })).sort((a, b) => a.status - b.status),
      ).toEqual([
        { status: 200, code: undefined },
        { status: 409, code: 'request_in_progress' },
      ]);
      const winningEmail = responses[0].status === 200 ? 'first@example.com' : 'second@example.com';
      expect(storedToken).toEqual({ email: winningEmail, token: expect.any(String) });
    });
  });

  describe('confirmEmailChange', () => {
    async function pendingToken(): Promise<EmailChangeToken> {
      return {
        userId: '507f1f77bcf86cd799439011',
        email: 'new@example.com',
        scope: 'email_change:507f1f77bcf86cd799439011',
        identifier: 'old@example.com',
        token: await hashToken('raw-token'),
        expiresAt: new Date(Date.now() + 60_000),
        metadata: new Map([['passwordFingerprint', await hashToken(user.password!)]]),
        tenantId: 'tenant-1',
      };
    }

    it('rejects a pending confirmation the owner scope has since disabled', async () => {
      /** The deployment still allows changes; the tenant, role, group or user that owns the
       *  link does not, and that is the scope the link was issued under. */
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        resolvePolicy: jest.fn().mockResolvedValue({
          settings: { enabled: false, tokenTTLSeconds: 900 },
          allowedDomains: null,
        }),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 403, code: 'email_change_disabled' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('reports an unavailable endpoint, not a bad token, when a link names no owner', async () => {
      /** I3: a deployment that disabled changes answers for a link there is no owner to ask,
       *  so the confirmation endpoint stays visibly unavailable rather than reporting on the
       *  token a caller supplied. */
      const { deps, service } = createDeps({
        resolveSettings: jest.fn().mockResolvedValue({ enabled: false, tokenTTLSeconds: 900 }),
        findToken: jest.fn().mockResolvedValue(null),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'unused-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toEqual({
        status: 403,
        message: 'Email changes are disabled',
        code: 'email_change_disabled',
      });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('still reports an invalid token when the deployment allows changes', async () => {
      const { service } = createDeps({ findToken: jest.fn().mockResolvedValue(null) });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'unused-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
    });

    it('confirms a link an override enabled even when the deployment default is off', async () => {
      /** Issuance read the requesting user's effective configuration, so a link exists only
       *  because that scope allowed it; a second read of the deployment default would refuse
       *  a link the account can legitimately complete. */
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        resolvePolicy: jest.fn().mockResolvedValue({
          settings: { enabled: true, tokenTTLSeconds: 900 },
          allowedDomains: null,
        }),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 200 });
      expect(deps.updateUser).toHaveBeenCalled();
    });

    it('rejects malformed user IDs before querying the database', async () => {
      const { deps, service } = createDeps();

      const response = await service.confirmEmailChange({
        body: { email: 'new@example.com', token: 'raw-token', userId: 'not-an-object-id' },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.findToken).not.toHaveBeenCalled();
    });

    it('consumes the token, changes the verified email, and confirms to both addresses', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'NEW@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
        ip: '198.51.100.4',
      });

      expect(response).toEqual({ status: 200, message: 'Email address changed successfully' });
      expect(deps.deleteTokens).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: '507f1f77bcf86cd799439011',
          type: EMAIL_CHANGE_TOKEN_TYPE,
        }),
        'tenant-1',
      );
      expect(deps.updateUser).toHaveBeenCalledWith(
        '507f1f77bcf86cd799439011',
        { email: 'new@example.com', emailVerified: true, emailChangedAt: expect.any(Date) },
        { email: 'old@example.com', password: 'password-hash', provider: 'local' },
        'tenant-1',
      );
      expect(deps.sendEmail).toHaveBeenCalledTimes(2);
      expect(deps.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'old@example.com',
          template: 'emailChanged.handlebars',
        }),
      );
      expect(deps.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@example.com',
          template: 'emailChanged.handlebars',
        }),
      );
    });

    it('revokes leftover reset tokens only after the commit', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 200 });
      const deleteMock = deps.deleteTokens as jest.Mock;
      const updateOrder = (deps.updateUser as jest.Mock).mock.invocationCallOrder[0];
      const resetCleanups = deleteMock.mock.calls
        .map((call, index) => ({
          query: call[0] as TokenQuery,
          order: deleteMock.mock.invocationCallOrder[index],
        }))
        .filter(({ query }) => query.type === 'password_reset');
      expect(resetCleanups.map(({ query }) => query.email).sort()).toEqual([
        null,
        'old@example.com',
      ]);
      expect(resetCleanups.every(({ order }) => order > updateOrder)).toBe(true);
    });

    it('leaves an email change token issued after the commit intact', async () => {
      const pending = await pendingToken();
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(pending),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 200 });
      const emailChangeDeletes = (deps.deleteTokens as jest.Mock).mock.calls.filter(
        ([query]) => query.type === EMAIL_CHANGE_TOKEN_TYPE,
      );
      expect(emailChangeDeletes).toHaveLength(1);
      expect(emailChangeDeletes[0][0]).toMatchObject({
        scope: pending.scope,
        token: pending.token,
      });
    });

    it('leaves a reset issued for the committed address intact', async () => {
      const resetTokens: Array<string | null> = ['old@example.com'];
      const deleteTokens: EmailChangeDeps['deleteTokens'] = jest.fn(async (query: TokenQuery) => {
        if (query.type !== 'password_reset') {
          return { deletedCount: 1 };
        }
        const before = resetTokens.length;
        for (let index = resetTokens.length - 1; index >= 0; index--) {
          if (query.email === undefined || resetTokens[index] === query.email) {
            resetTokens.splice(index, 1);
          }
        }
        return { deletedCount: before - resetTokens.length };
      });
      /** Stands in for another replica observing the committed address and issuing a
       * correctly bound reset before this request's post-commit sweep reaches Mongo. */
      const updateUser: EmailChangeDeps['updateUser'] = jest.fn(async () => {
        resetTokens.push('new@example.com');
        return { ...user, email: 'new@example.com' };
      });
      const { service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        deleteTokens,
        updateUser,
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 200 });
      expect(resetTokens).toEqual(['new@example.com']);
    });

    it('leaves the link usable when the update fails transiently', async () => {
      const pending = await pendingToken();
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(pending),
        updateUser: jest.fn().mockRejectedValue(new Error('connection reset')),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 500 });
      const emailChangeDeletes = (deps.deleteTokens as jest.Mock).mock.calls.filter(
        ([query]) => query.type === EMAIL_CHANGE_TOKEN_TYPE,
      );
      expect(emailChangeDeletes).toHaveLength(1);
      expect(emailChangeDeletes[0][0]).toMatchObject({
        scope: pending.scope,
        token: pending.token,
      });
      expect(deps.replaceTokenIfCurrent).toHaveBeenCalledWith(
        pending.scope,
        null,
        expect.objectContaining({
          scope: pending.scope,
          token: pending.token,
          type: EMAIL_CHANGE_TOKEN_TYPE,
          email: 'new@example.com',
          identifier: 'old@example.com',
        }),
        'tenant-1',
      );
      expect(
        (deps.deleteTokens as jest.Mock).mock.calls.some(
          ([query]) => query.type === 'password_reset' || query.type == null,
        ),
      ).toBe(false);
    });

    it('leaves an existing password reset intact when the update fails transiently', async () => {
      const resetTokens = ['pending-reset'];
      const deleteTokens = jest.fn(async (query: TokenQuery) => {
        if (query.type === 'password_reset' || query.type == null) {
          const deletedCount = resetTokens.length;
          resetTokens.length = 0;
          return { deletedCount };
        }
        return { deletedCount: 1 };
      });
      const { service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        deleteTokens: deleteTokens as EmailChangeDeps['deleteTokens'],
        updateUser: jest.fn().mockRejectedValue(new Error('connection reset')),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 500 });
      expect(resetTokens).toEqual(['pending-reset']);
    });

    it('refuses a confirmation superseded mid-flight and leaves the newer link intact', async () => {
      const pending = await pendingToken();
      const supersedingToken = await hashToken('superseding-token');
      let storedToken: string | null = pending.token;
      const deleteTokens = jest.fn(async (query: TokenQuery) => {
        if (query.type !== EMAIL_CHANGE_TOKEN_TYPE) {
          return { deletedCount: 0 };
        }
        if (query.token !== undefined && query.token !== storedToken) {
          return { deletedCount: 0 };
        }
        const deletedCount = storedToken === null ? 0 : 1;
        storedToken = null;
        return { deletedCount };
      });
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(pending),
        /** A second request replaces the scoped token after this confirmation read it. */
        findUserByEmail: jest.fn(async () => {
          storedToken = supersedingToken;
          return null;
        }),
        deleteTokens: deleteTokens as EmailChangeDeps['deleteTokens'],
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.updateUser).not.toHaveBeenCalled();
      expect(storedToken).toBe(supersedingToken);
    });

    it('leaves password resets alone when the confirmation is superseded', async () => {
      const pending = await pendingToken();
      const supersedingToken = await hashToken('superseding-token');
      let storedToken: string | null = pending.token;
      const resetTokens = ['pending-reset'];
      const deleteTokens = jest.fn(async (query: TokenQuery) => {
        if (query.type === 'password_reset') {
          const deletedCount = resetTokens.length;
          resetTokens.length = 0;
          return { deletedCount };
        }
        if (query.type !== EMAIL_CHANGE_TOKEN_TYPE) {
          return { deletedCount: 0 };
        }
        if (query.token !== undefined && query.token !== storedToken) {
          return { deletedCount: 0 };
        }
        const deletedCount = storedToken === null ? 0 : 1;
        storedToken = null;
        return { deletedCount };
      });
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(pending),
        /** A second request replaces the scoped token after this confirmation read it. */
        findUserByEmail: jest.fn(async () => {
          storedToken = supersedingToken;
          return null;
        }),
        deleteTokens: deleteTokens as EmailChangeDeps['deleteTokens'],
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.updateUser).not.toHaveBeenCalled();
      expect(resetTokens).toEqual(['pending-reset']);
    });

    it('reports a failed claim as a server error instead of an invalid link', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        deleteTokens: jest.fn(async (query: TokenQuery) => {
          if (query.token !== undefined) {
            throw new Error('token store unavailable');
          }
          return { deletedCount: 1 };
        }) as EmailChangeDeps['deleteTokens'],
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toEqual({ status: 500, message: 'Failed to change email address' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('rejects confirmation when the allowlist stopped permitting the pending address', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        resolvePolicy: jest.fn().mockResolvedValue({
          settings: { enabled: true, tokenTTLSeconds: 900 },
          allowedDomains: ['allowed.com'],
        }),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 403, code: 'email_domain_not_allowed' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('rejects confirmation when the account moved to a federated provider', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        getUserById: jest.fn().mockResolvedValue({ ...user, provider: 'openid' }),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('rejects an invalid token without updating the user', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'wrong-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('rejects an expired token even before the TTL cleanup removes it', async () => {
      const token = await pendingToken();
      token.expiresAt = new Date(Date.now() - 1);
      const { deps, service } = createDeps({ findToken: jest.fn().mockResolvedValue(token) });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('rejects a stale token after the account email has changed', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        getUserById: jest.fn().mockResolvedValue({ ...user, email: 'other@example.com' }),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('rejects a pending token after the account password has changed', async () => {
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        getUserById: jest.fn().mockResolvedValue({ ...user, password: 'new-password-hash' }),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 400, code: 'invalid_token' });
      expect(deps.deleteTokens).not.toHaveBeenCalled();
      expect(deps.updateUser).not.toHaveBeenCalled();
    });

    it('allows only one competing confirmation to update the original account state', async () => {
      const firstToken = {
        ...(await pendingToken()),
        email: 'first@example.com',
        token: await hashToken('first-token'),
      };
      const secondToken = {
        ...(await pendingToken()),
        email: 'second@example.com',
        token: await hashToken('second-token'),
      };
      let accountEmail = user.email;
      let updateCallCount = 0;
      let releaseUpdates: (() => void) | undefined;
      const updatesReady = new Promise<void>((resolve) => {
        releaseUpdates = resolve;
      });
      const updateUser = jest.fn(
        async (
          _userId: string,
          update: { email: string; emailVerified: boolean },
          expected: { email: string; password: string },
        ) => {
          updateCallCount += 1;
          if (updateCallCount === 2) {
            releaseUpdates?.();
          }
          await updatesReady;
          if (expected?.email !== accountEmail || expected?.password !== user.password) {
            return null;
          }
          accountEmail = update.email;
          return { ...user, ...update };
        },
      );
      const { service } = createDeps({
        findToken: jest.fn(async ({ email }) =>
          email === firstToken.email ? firstToken : secondToken,
        ),
        getUserById: jest.fn().mockResolvedValue(user),
        updateUser: updateUser as EmailChangeDeps['updateUser'],
      });

      const responses = await Promise.all([
        service.confirmEmailChange({
          body: {
            email: 'first@example.com',
            token: 'first-token',
            userId: '507f1f77bcf86cd799439011',
          },
        }),
        service.confirmEmailChange({
          body: {
            email: 'second@example.com',
            token: 'second-token',
            userId: '507f1f77bcf86cd799439011',
          },
        }),
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([200, 400]);
      expect(['first@example.com', 'second@example.com']).toContain(accountEmail);
    });

    it('still succeeds and sends confirmations when post-commit cleanup fails', async () => {
      const deleteTokens = jest
        .fn()
        .mockResolvedValueOnce({ deletedCount: 1 })
        .mockResolvedValueOnce({ deletedCount: 1 })
        .mockResolvedValueOnce({ deletedCount: 1 })
        .mockRejectedValueOnce(new Error('cleanup unavailable'));
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        deleteTokens,
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toEqual({ status: 200, message: 'Email address changed successfully' });
      expect(deps.updateUser).toHaveBeenCalledTimes(1);
      expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    });

    it('surfaces a uniqueness race during the final update', async () => {
      const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
      const { deps, service } = createDeps({
        findToken: jest.fn().mockResolvedValue(await pendingToken()),
        updateUser: jest.fn().mockRejectedValue(duplicateError),
      });

      const response = await service.confirmEmailChange({
        body: {
          email: 'new@example.com',
          token: 'raw-token',
          userId: '507f1f77bcf86cd799439011',
        },
      });

      expect(response).toMatchObject({ status: 409, code: 'email_in_use' });
      expect(deps.sendEmail).not.toHaveBeenCalled();
      expect(deps.replaceTokenIfCurrent).not.toHaveBeenCalled();
    });
  });
});
