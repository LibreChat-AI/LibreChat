import type { ISession } from '@librechat/data-schemas';
import { createFindProviderSessionBinding } from './binding';

function makeFindSession(result: Partial<ISession> | null) {
  return jest.fn().mockResolvedValue(result);
}

describe('createFindProviderSessionBinding', () => {
  it('maps a found session to the binding shape, stringifying the user id', async () => {
    const session = {
      user: { toString: () => 'user-object-id' },
      tenantId: 'tenant-1',
      providerSession: { sid: 'provider-sid' },
    } as unknown as ISession;
    const findSession = makeFindSession(session);

    const findProviderSessionBinding = createFindProviderSessionBinding({ findSession });
    const binding = await findProviderSessionBinding('incoming-refresh-token');

    expect(binding).toEqual({
      userId: 'user-object-id',
      tenantId: 'tenant-1',
      providerSession: { sid: 'provider-sid' },
    });
    expect(findSession).toHaveBeenCalledWith(
      { refreshToken: 'incoming-refresh-token' },
      { lean: true },
    );
  });

  it('returns undefined userId when the session has no user', async () => {
    const session = { tenantId: 'tenant-1' } as unknown as ISession;
    const findSession = makeFindSession(session);

    const findProviderSessionBinding = createFindProviderSessionBinding({ findSession });
    const binding = await findProviderSessionBinding('incoming-refresh-token');

    expect(binding).toEqual({
      userId: undefined,
      tenantId: 'tenant-1',
      providerSession: undefined,
    });
  });

  it('returns null when no session is found, without altering the findSession call', async () => {
    const findSession = makeFindSession(null);

    const findProviderSessionBinding = createFindProviderSessionBinding({ findSession });
    const binding = await findProviderSessionBinding('missing-refresh-token');

    expect(binding).toBeNull();
    expect(findSession).toHaveBeenCalledTimes(1);
    expect(findSession).toHaveBeenCalledWith(
      { refreshToken: 'missing-refresh-token' },
      { lean: true },
    );
  });
});
