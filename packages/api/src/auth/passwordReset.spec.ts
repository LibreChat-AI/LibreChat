import type { PasswordResetDeps, PasswordResetToken, PasswordResetUser } from './passwordReset';
import { commitPasswordReset, resetTokenBindsToAccount } from './passwordReset';

const RESET_HASH = 'hashed-reset-token';

function createDeps(overrides: Partial<PasswordResetDeps> = {}): jest.Mocked<PasswordResetDeps> {
  return {
    findResetToken: jest.fn().mockResolvedValue(null),
    getUserById: jest.fn().mockResolvedValue(null),
    updateUser: jest.fn().mockResolvedValue({ email: 'user@example.com' }),
    deleteTokens: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    compareToken: jest.fn((candidate: string) => candidate === 'reset-token'),
    hashPassword: jest.fn(() => 'hashed-password'),
    ...overrides,
  } as jest.Mocked<PasswordResetDeps>;
}

function typedToken(overrides: Partial<PasswordResetToken> = {}): PasswordResetToken {
  return { token: RESET_HASH, email: 'user@example.com', type: 'password_reset', ...overrides };
}

function legacyToken(): PasswordResetToken {
  return { token: RESET_HASH, email: null, type: null };
}

function account(overrides: Partial<PasswordResetUser> = {}): PasswordResetUser {
  return { _id: 'user-reset', email: 'user@example.com', ...overrides };
}

const input = { userId: 'user-reset', token: 'reset-token', password: 'new-password' };

describe('commitPasswordReset', () => {
  it('reads the token and the account together', async () => {
    /** Both depend only on the supplied id, and neither is acted on before its own check. */
    const order: string[] = [];
    const deps = createDeps({
      findResetToken: jest.fn(async () => {
        order.push('token:start');
        await Promise.resolve();
        order.push('token:end');
        return typedToken();
      }),
      getUserById: jest.fn(async () => {
        order.push('user:start');
        return account();
      }),
    });

    await commitPasswordReset(deps, input);

    expect(order.slice(0, 2)).toEqual(['token:start', 'user:start']);
  });

  it('refuses when no reset token exists', async () => {
    const deps = createDeps();

    await expect(commitPasswordReset(deps, input)).resolves.toEqual({ ok: false });
    expect(deps.updateUser).not.toHaveBeenCalled();
    expect(deps.deleteTokens).not.toHaveBeenCalled();
  });

  it('refuses a token whose secret does not match', async () => {
    const deps = createDeps({ findResetToken: jest.fn().mockResolvedValue(typedToken()) });

    await expect(commitPasswordReset(deps, { ...input, token: 'wrong-token' })).resolves.toEqual({
      ok: false,
    });
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('commits against the address the account holds now', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(typedToken()),
      getUserById: jest.fn().mockResolvedValue(account()),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toMatchObject({ ok: true });
    expect(deps.updateUser).toHaveBeenCalledWith(
      'user-reset',
      { password: 'hashed-password', credentialsChangedAt: expect.any(Date) },
      { email: 'user@example.com' },
    );
  });

  it('accepts a typed token issued before addresses were bound', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(typedToken({ email: undefined })),
      getUserById: jest.fn().mockResolvedValue(account()),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toMatchObject({ ok: true });
  });

  it('refuses a typed token issued to a previous address', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(typedToken({ email: 'old@example.com' })),
      getUserById: jest.fn().mockResolvedValue(account({ email: 'new@example.com' })),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toEqual({ ok: false });
    expect(deps.updateUser).not.toHaveBeenCalled();
    expect(deps.deleteTokens).not.toHaveBeenCalled();
  });

  it('refuses an address-less token once the account has moved', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(typedToken({ email: undefined })),
      getUserById: jest
        .fn()
        .mockResolvedValue(account({ email: 'new@example.com', emailChangedAt: new Date() })),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toEqual({ ok: false });
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('accepts an untyped legacy token for an account that never moved', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(legacyToken()),
      getUserById: jest.fn().mockResolvedValue(account()),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toMatchObject({ ok: true });
  });

  it('refuses an untyped legacy token once the account has moved', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(legacyToken()),
      getUserById: jest
        .fn()
        .mockResolvedValue(account({ email: 'new@example.com', emailChangedAt: new Date() })),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toEqual({ ok: false });
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('refuses when the account cannot be read', async () => {
    const deps = createDeps({ findResetToken: jest.fn().mockResolvedValue(typedToken()) });

    await expect(commitPasswordReset(deps, input)).resolves.toEqual({ ok: false });
    expect(deps.updateUser).not.toHaveBeenCalled();
  });

  it('refuses when the compare-and-set finds the address already moved', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(typedToken()),
      getUserById: jest.fn().mockResolvedValue(account()),
      updateUser: jest.fn().mockResolvedValue(null),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toEqual({ ok: false });
    expect(deps.deleteTokens).not.toHaveBeenCalled();
  });

  it('revokes pending email changes once the password is committed', async () => {
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(typedToken()),
      getUserById: jest.fn().mockResolvedValue(account()),
    });

    await commitPasswordReset(deps, input);

    expect(deps.deleteTokens).toHaveBeenCalledWith({
      userId: 'user-reset',
      type: 'email_change',
    });
  });

  it('still reports success when the email change sweep fails', async () => {
    /** The password is already committed; a failed cleanup must not hand the caller an
     *  error that invites a retry against a token this reset consumed. */
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(typedToken()),
      getUserById: jest.fn().mockResolvedValue(account()),
      deleteTokens: jest.fn().mockRejectedValue(new Error('mongo unavailable')),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toMatchObject({ ok: true });
  });

  it('returns the token it consumed so the caller can delete exactly that one', async () => {
    const resetToken = typedToken();
    const deps = createDeps({
      findResetToken: jest.fn().mockResolvedValue(resetToken),
      getUserById: jest.fn().mockResolvedValue(account()),
    });

    await expect(commitPasswordReset(deps, input)).resolves.toMatchObject({ resetToken });
  });
});

describe('resetTokenBindsToAccount', () => {
  it('compares addresses without regard to case', () => {
    expect(resetTokenBindsToAccount(typedToken({ email: 'User@Example.com' }), account())).toBe(
      true,
    );
  });

  it('refuses when there is no account', () => {
    expect(resetTokenBindsToAccount(typedToken(), null)).toBe(false);
  });
});
