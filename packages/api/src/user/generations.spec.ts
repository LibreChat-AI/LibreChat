import type { OwnedGenerationControl, UserGenerationControl } from './generations';
import { abortOwnedGeneration, stopUserGenerations } from './generations';

/** Methods read `this`, as the real GenerationJobManager does, so an unbound call throws. */
class FakeJobManager {
  private jobs = new Map([
    ['s1', { createdAt: 7, metadata: { userId: 'u1', terminalPersistencePending: false } }],
    ['s2', { createdAt: 8, metadata: { userId: 'other' } }],
    ['s3', { createdAt: 9, metadata: { userId: 'u1', tenantId: 't1' } }],
  ]);

  readonly abortOptions: unknown[] = [];

  readonly aborted: string[] = [];

  async getAccountCleanupJobIdsForUser() {
    return [...this.jobs.keys()];
  }

  async getCleanupJob(streamId: string) {
    return this.jobs.get(streamId);
  }

  async getJob(streamId: string) {
    return this.jobs.get(streamId);
  }

  async abortJob(streamId: string, options?: unknown) {
    this.aborted.push(streamId);
    this.abortOptions.push(options);
    return { success: true };
  }
}

describe('stopUserGenerations', () => {
  it('stops only the user jobs using a manager whose methods depend on this', async () => {
    const manager = new FakeJobManager();

    await expect(
      stopUserGenerations('u1', undefined, manager as unknown as UserGenerationControl),
    ).resolves.toBeUndefined();

    expect(manager.aborted).toEqual(['s1']);
  });

  it('throws when a stop is not confirmed', async () => {
    const manager = new FakeJobManager();
    manager.abortJob = async function (this: FakeJobManager, streamId: string) {
      this.aborted.push(streamId);
      return { success: false };
    };

    await expect(
      stopUserGenerations('u1', undefined, manager as unknown as UserGenerationControl),
    ).rejects.toThrow('could not be confirmed stopped');
  });
});

describe('abortOwnedGeneration', () => {
  const control = (manager: FakeJobManager) => manager as unknown as OwnedGenerationControl;

  it("stops the caller's own run, fenced to the epoch it read", async () => {
    const manager = new FakeJobManager();

    const result = await abortOwnedGeneration('s1', { id: 'u1' }, control(manager));

    expect(result.success).toBe(true);
    expect(manager.aborted).toEqual(['s1']);
    expect(manager.abortOptions).toEqual([{ expectedCreatedAt: 7 }]);
  });

  it.each([
    ['another user', 's2', { id: 'u1' }],
    ['another tenant', 's3', { id: 'u1', tenantId: 't2' }],
    ['a missing run', 'missing', { id: 'u1' }],
  ])('reports %s as not found without stopping anything', async (_case, streamId, user) => {
    const manager = new FakeJobManager();

    const result = await abortOwnedGeneration(streamId, user, control(manager));

    expect(result).toMatchObject({ success: false, failureReason: 'job_not_found', jobData: null });
    expect(manager.aborted).toEqual([]);
  });
});
