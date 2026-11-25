import { createHash } from 'node:crypto';
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
});
