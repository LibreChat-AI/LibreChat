/**
 * A Stop persists the response from job data alone. The run owner publishes its
 * context meta ahead of each model call and awaits that write, so a publish that
 * lands between the abort's initial read and its terminal claim describes the call
 * whose partial output the abort snapshot carries. The abort must read it back.
 */
import type { IAgentEventActorContextMeta } from '@librechat/data-schemas';

/** Suppress winston Console transport output (survives jest.resetModules) */
jest.spyOn(console, 'log').mockImplementation();

async function configureManager() {
  const { GenerationJobManager } = await import('../GenerationJobManager');
  const { InMemoryJobStore } = await import('../implementations/InMemoryJobStore');
  const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');

  const jobStore = new InMemoryJobStore();
  GenerationJobManager.configure({
    jobStore,
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
    cleanupOnComplete: false,
  });
  GenerationJobManager.initialize();
  return { manager: GenerationJobManager, jobStore };
}

const earlier: IAgentEventActorContextMeta = {
  calibrationRatio: 1.1,
  encoding: 'claude',
  fading: { v: 1, budgetTokens: 50_000, masked: false },
};
const later: IAgentEventActorContextMeta = {
  calibrationRatio: 1.3,
  encoding: 'claude',
  fading: { v: 1, budgetTokens: 25_000, masked: true },
};

describe('abortJob context meta', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('carries the context meta published while the abort was claiming the job', async () => {
    const { manager, jobStore } = await configureManager();
    const streamId = 'abort-context-meta-race';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.updateMetadata(streamId, { contextMeta: earlier }, job.createdAt);

    const original = jobStore.transitionStatusAndDrainSteers.bind(jobStore);
    jest
      .spyOn(jobStore, 'transitionStatusAndDrainSteers')
      .mockImplementationOnce(async (...args) => {
        await jobStore.updateJob(streamId, { contextMeta: later }, job.createdAt);
        return original(...args);
      });

    const result = await manager.abortJob(streamId);

    expect(result.success).toBe(true);
    expect(result.jobData?.contextMeta).toEqual(later);

    await manager.destroy();
  });

  it('keeps the context meta it read when nothing newer was published', async () => {
    const { manager } = await configureManager();
    const streamId = 'abort-context-meta-stable';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.updateMetadata(streamId, { contextMeta: earlier }, job.createdAt);

    const result = await manager.abortJob(streamId);

    expect(result.success).toBe(true);
    expect(result.jobData?.contextMeta).toEqual(earlier);

    await manager.destroy();
  });
});
