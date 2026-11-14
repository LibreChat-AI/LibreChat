import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { isChildThreadJob, isListedChatJob } from '~/stream/metadata';

jest.spyOn(console, 'log').mockImplementation();

describe('child-thread jobs in the active chat list', () => {
  const userId = 'owner';
  const chatId = 'chat-conversation';
  const childId = 'child-thread-conversation';
  let manager: GenerationJobManagerClass;
  let jobStore: InMemoryJobStore;

  beforeEach(async () => {
    jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.createJob(chatId, userId, chatId);
    await manager.createJob(childId, userId, childId, {
      initialMetadata: { agentEventBindingId: 'binding-1' },
    });
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('leaves a running child thread out of the active chat list', async () => {
    await expect(manager.getActiveJobIdsForUser(userId)).resolves.toEqual([chatId]);
  });

  it('keeps the child thread in the unfiltered store read', async () => {
    const active = await jobStore.getActiveJobIdsByUser(userId);
    expect(active.sort()).toEqual([chatId, childId].sort());
  });

  it('still serves the child thread job to its own status and stream reads', async () => {
    const job = await manager.getJob(childId);
    expect(job).toMatchObject({ status: 'running' });
    expect(job?.metadata.userId).toBe(userId);
  });

  it('still counts the child thread for owner cleanup', async () => {
    const blocking = await manager.getCleanupBlockingJobIdsForUser(userId);
    expect(blocking).toContain(childId);
    expect(blocking).toContain(chatId);
  });

  it('lists nothing when only a child thread is running', async () => {
    await manager.completeJob(chatId);
    await expect(manager.getActiveJobIdsForUser(userId)).resolves.toEqual([]);
  });

  it('reads the child-thread marker from the event binding', () => {
    expect(isChildThreadJob({ agentEventBindingId: 'binding-1' })).toBe(true);
    expect(isChildThreadJob({ agentEventBindingId: '' })).toBe(false);
    expect(isChildThreadJob({})).toBe(false);
    expect(isListedChatJob({})).toBe(true);
    expect(isListedChatJob({ agentEventBindingId: 'binding-1' })).toBe(false);
  });
});
