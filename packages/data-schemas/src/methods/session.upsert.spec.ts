import { createHash } from 'node:crypto';
import type * as t from '~/types';
import { createSessionMethods } from './session';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

describe('upsertSession', () => {
  it('stores an externally issued refresh token as a revocable hash', async () => {
    const storedSession = { _id: 'session-id' };
    const createIndexes = jest.fn().mockResolvedValue(undefined);
    const exec = jest.fn().mockResolvedValue(storedSession);
    const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
    const mongoose = {
      models: { Session: { modelName: 'Session', createIndexes, findOneAndUpdate } },
    } as unknown as typeof import('mongoose');
    const methods = createSessionMethods(mongoose);
    const expiration = new Date(Date.now() + 60_000);

    const result = await methods.upsertSession('user-id', 'external-refresh', {
      expiration,
      tenantId: 'tenant-a',
    });

    const refreshTokenHash = createHash('sha256').update('external-refresh').digest('hex');
    expect(createIndexes).toHaveBeenCalledTimes(1);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { user: 'user-id', refreshTokenHash },
      {
        $set: {
          user: 'user-id',
          refreshTokenHash,
          expiration,
          tenantId: 'tenant-a',
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    expect(result).toBe(storedSession);
  });

  it('omits tenantId, providerSession, and authMethod from the update when not supplied', async () => {
    const storedSession = { _id: 'session-id' };
    const createIndexes = jest.fn().mockResolvedValue(undefined);
    const exec = jest.fn().mockResolvedValue(storedSession);
    const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
    const mongoose = {
      models: { Session: { modelName: 'Session', createIndexes, findOneAndUpdate } },
    } as unknown as typeof import('mongoose');
    const methods = createSessionMethods(mongoose);
    const expiration = new Date(Date.now() + 60_000);

    await methods.upsertSession('user-id', 'external-refresh', { expiration });

    const refreshTokenHash = createHash('sha256').update('external-refresh').digest('hex');
    // `toHaveBeenCalledWith`/`toEqual` ignore keys whose value is `undefined`, so a mutant that
    // always assigns `update.tenantId = options.tenantId` (i.e. `undefined`) would still pass a
    // plain `toHaveBeenCalledWith` assertion here. `toStrictEqual` does not ignore them, so it
    // distinguishes "key present with value undefined" from "key never assigned".
    expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filterArg, updateArg, optionsArg] = findOneAndUpdate.mock.calls[0];
    expect(filterArg).toStrictEqual({ user: 'user-id', refreshTokenHash });
    expect(updateArg).toStrictEqual({
      $set: {
        user: 'user-id',
        refreshTokenHash,
        expiration,
      },
    });
    expect('tenantId' in updateArg.$set).toBe(false);
    expect('providerSession' in updateArg.$set).toBe(false);
    expect('authMethod' in updateArg.$set).toBe(false);
    expect(optionsArg).toStrictEqual({ upsert: true, new: true, setDefaultsOnInsert: true });
  });

  describe('input validation', () => {
    const buildMethods = () => {
      const createIndexes = jest.fn().mockResolvedValue(undefined);
      const exec = jest.fn().mockResolvedValue({ _id: 'session-id' });
      const findOneAndUpdate = jest.fn().mockReturnValue({ exec });
      const mongoose = {
        models: { Session: { modelName: 'Session', createIndexes, findOneAndUpdate } },
      } as unknown as typeof import('mongoose');
      return { methods: createSessionMethods(mongoose), findOneAndUpdate };
    };
    const expiration = new Date(Date.now() + 60_000);

    it('rejects a missing userId even when refreshToken and expiration are present', async () => {
      const { methods, findOneAndUpdate } = buildMethods();
      await expect(methods.upsertSession('', 'refresh', { expiration })).rejects.toMatchObject({
        name: 'SessionError',
        code: 'INVALID_SESSION',
      });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a missing refreshToken even when userId and expiration are present', async () => {
      const { methods, findOneAndUpdate } = buildMethods();
      await expect(methods.upsertSession('user-id', '', { expiration })).rejects.toMatchObject({
        name: 'SessionError',
        code: 'INVALID_SESSION',
      });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('rejects a missing expiration even when userId and refreshToken are present', async () => {
      const { methods, findOneAndUpdate } = buildMethods();
      await expect(
        methods.upsertSession('user-id', 'refresh', {} as t.UpsertSessionOptions),
      ).rejects.toMatchObject({ name: 'SessionError', code: 'INVALID_SESSION' });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('accepts the call once userId, refreshToken, and expiration are all present', async () => {
      const { methods, findOneAndUpdate } = buildMethods();
      await expect(
        methods.upsertSession('user-id', 'refresh', { expiration }),
      ).resolves.toBeDefined();
      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
  });
});

describe('createSession', () => {
  it('rejects a missing userId before touching the database', async () => {
    const createIndexes = jest.fn().mockResolvedValue(undefined);
    const mongoose = {
      models: { Session: { modelName: 'Session', createIndexes } },
    } as unknown as typeof import('mongoose');
    const methods = createSessionMethods(mongoose);

    await expect(methods.createSession('')).rejects.toMatchObject({
      name: 'SessionError',
      code: 'INVALID_USER_ID',
    });
    expect(createIndexes).not.toHaveBeenCalled();
  });
});
