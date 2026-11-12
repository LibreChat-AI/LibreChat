import {
  GenerationAdmissionDeniedError,
  GenerationAdmissionUnavailableError,
} from '~/stream/interfaces/IJobStore';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { stopUserGenerations } from '~/user/generations';

describe('GenerationJobManager admission guard', () => {
  let manager: GenerationJobManagerClass;
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: new InMemoryEventTransport() });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('refuses before creating any job state while the account deletion has begun', async () => {
    manager.setAdmissionGuard(async () => false);

    await expect(manager.createJob('denied', 'user-1', 'denied')).rejects.toBeInstanceOf(
      GenerationAdmissionDeniedError,
    );
    await expect(manager.createJob('denied', 'user-1', 'denied')).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
      status: 409,
      message: 'Account deletion is in progress',
    });
    expect(await store.getJob('denied')).toBeNull();
  });

  it('refuses with a sanitized code when the guard fails and creates nothing', async () => {
    manager.setAdmissionGuard(async () => {
      throw new Error('mongodb://internal-host:27017 lookup down');
    });

    const error = await manager.createJob('failed', 'user-1', 'failed').catch((e) => e);

    expect(error).toBeInstanceOf(GenerationAdmissionUnavailableError);
    expect(error).toMatchObject({
      code: 'GENERATION_ADMISSION_UNAVAILABLE',
      message: 'Generation admission could not be verified',
    });
    expect(await store.getJob('failed')).toBeNull();
  });

  it('uses a per-job admission check in place of the installed guard', async () => {
    const guard = jest.fn(async () => true);
    manager.setAdmissionGuard(guard);

    await expect(
      manager.createJob('own-check', 'user-1', 'own-check', { admissionCheck: async () => false }),
    ).rejects.toBeInstanceOf(GenerationAdmissionDeniedError);
    expect(guard).not.toHaveBeenCalled();
  });

  it('admits jobs while the account is active', async () => {
    manager.setAdmissionGuard(async () => true);

    await expect(manager.createJob('ok', 'user-1', 'ok')).resolves.toMatchObject({
      streamId: 'ok',
    });
  });

  it('retires a job committed after the marker was set and fails with the stable code', async () => {
    let marker = false;
    manager.setAdmissionGuard(async () => !marker);
    const created = jest.spyOn(store, 'createJob');
    created.mockImplementationOnce(async (...args) => {
      marker = true;
      return InMemoryJobStore.prototype.createJob.apply(store, args);
    });

    await expect(manager.createJob('late', 'user-1', 'late')).rejects.toBeInstanceOf(
      GenerationAdmissionDeniedError,
    );
    expect((await store.getJob('late'))?.status).toBe('error');
  });

  it('maps a retirement failure after a refused commit to the sanitized error', async () => {
    let marker = false;
    manager.setAdmissionGuard(async () => !marker);
    jest.spyOn(store, 'createJob').mockImplementationOnce(async (...args) => {
      marker = true;
      return InMemoryJobStore.prototype.createJob.apply(store, args);
    });
    jest.spyOn(manager, 'completeJob').mockRejectedValueOnce(new Error('redis://internal:6379'));

    await expect(manager.createJob('retire-fail', 'user-1', 'retire-fail')).rejects.toMatchObject({
      code: 'GENERATION_ADMISSION_UNAVAILABLE',
      message: 'Generation admission could not be verified',
    });
  });

  it('stops a job committed before the deletion listing', async () => {
    let marker = false;
    manager.setAdmissionGuard(async () => !marker);
    await manager.createJob('before', 'user-1', 'before');

    marker = true;
    await stopUserGenerations('user-1', undefined, manager);

    expect((await store.getJob('before'))?.status).not.toBe('running');
  });
});
