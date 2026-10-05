import type { MediaAccountDeletionRepository } from './account';
import {
  prepareMediaAccountDeletion,
  completeMediaAccountDeletion,
  cancelMediaAccountDeletion,
} from './account';
import { sendAccountDeletionError } from '~/user/deletion';
import { MediaServiceError } from './errors';

describe('media account deletion preflight', () => {
  const scope = { ownerId: 'owner', tenantId: null };
  const session = { scope, token: 'deletion-token' };

  it('returns actionable media errors and preserves the generic response for other failures', () => {
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    sendAccountDeletionError(
      response,
      new MediaServiceError(
        'not_ready',
        409,
        'Media work or accounting must finish before account deletion.',
      ),
    );
    expect(response.status).toHaveBeenLastCalledWith(409);
    expect(response.json).toHaveBeenLastCalledWith({
      code: 'not_ready',
      message: 'Media work or accounting must finish before account deletion.',
    });
    sendAccountDeletionError(response, new Error('Private database details'));
    expect(response.status).toHaveBeenLastCalledWith(500);
    expect(response.json).toHaveBeenLastCalledWith({ message: 'Something went wrong.' });
  });
  let repository: jest.Mocked<MediaAccountDeletionRepository>;
  beforeEach(() => {
    repository = {
      hasMediaActivation: jest.fn().mockResolvedValue(true),
      prepareMediaAccountDeletion: jest.fn().mockResolvedValue(true),
      cancelMediaAccountDeletion: jest.fn().mockResolvedValue(undefined),
      completeMediaAccountDeletion: jest.fn().mockResolvedValue(undefined),
      hasMediaAccountingObligations: jest.fn().mockResolvedValue(false),
    };
  });
  it('holds an admission fence before validating financial obligations', async () => {
    expect(await prepareMediaAccountDeletion({ repository, ...session })).toEqual(session);
    expect(repository.prepareMediaAccountDeletion.mock.invocationCallOrder[0]).toBeLessThan(
      repository.hasMediaAccountingObligations.mock.invocationCallOrder[0],
    );
    expect(repository.cancelMediaAccountDeletion).not.toHaveBeenCalled();
  });
  it.each(['work', 'accounting', 'database'])(
    'releases its fence and aborts before cascade on %s failure',
    async (failure) => {
      if (failure === 'work') {
        repository.prepareMediaAccountDeletion.mockResolvedValue(false);
      }
      if (failure === 'accounting') {
        repository.hasMediaAccountingObligations.mockResolvedValue(true);
      }
      if (failure === 'database') {
        repository.hasMediaAccountingObligations.mockRejectedValue(
          new Error('Database unavailable'),
        );
      }
      await expect(prepareMediaAccountDeletion({ repository, ...session })).rejects.toThrow();
      expect(repository.cancelMediaAccountDeletion).toHaveBeenCalledWith(session);
      expect(repository.completeMediaAccountDeletion).not.toHaveBeenCalled();
    },
  );
  it('leaves a deployment that never activated media out of account deletion', async () => {
    repository.hasMediaActivation.mockResolvedValue(false);
    const log = jest.fn();
    const skipped = await prepareMediaAccountDeletion({ repository, ...session });
    expect(skipped).toBeUndefined();
    await completeMediaAccountDeletion({ repository, session: skipped, log });
    await cancelMediaAccountDeletion({ repository, session: skipped, userDeleted: false, log });
    expect(repository.prepareMediaAccountDeletion).not.toHaveBeenCalled();
    expect(repository.hasMediaAccountingObligations).not.toHaveBeenCalled();
    expect(repository.completeMediaAccountDeletion).not.toHaveBeenCalled();
    expect(repository.cancelMediaAccountDeletion).not.toHaveBeenCalled();
  });
  it('defers a failed completion to reconciliation instead of failing a committed deletion', async () => {
    repository.completeMediaAccountDeletion.mockRejectedValue(new Error('Database unavailable'));
    const log = jest.fn();
    await expect(
      completeMediaAccountDeletion({ repository, session, log }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      '[media] Account deletion cleanup deferred to reconciliation.',
      expect.objectContaining({ message: 'Database unavailable' }),
    );
    expect(repository.cancelMediaAccountDeletion).not.toHaveBeenCalled();
  });
  it('delegates completion to the durable protocol and preserves the fence after User deletion', async () => {
    const log = jest.fn();
    await completeMediaAccountDeletion({ repository, session, log });
    expect(repository.completeMediaAccountDeletion).toHaveBeenCalledWith(session);
    expect(log).not.toHaveBeenCalled();
    await cancelMediaAccountDeletion({ repository, session, userDeleted: true, log });
    expect(repository.cancelMediaAccountDeletion).not.toHaveBeenCalled();
    await cancelMediaAccountDeletion({ repository, session, userDeleted: false, log });
    expect(repository.cancelMediaAccountDeletion).toHaveBeenCalledWith(session);
  });
});
