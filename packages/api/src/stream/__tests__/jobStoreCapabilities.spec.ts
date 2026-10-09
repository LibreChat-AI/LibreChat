import type { IJobStore } from '../interfaces/IJobStore';
import {
  assertJobStoreV2,
  getMissingJobStoreV2Methods,
  JOB_STORE_V2_REQUIRED_METHODS,
} from '../jobStoreCapabilities';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';

/**
 * Deliberately implements only the public pre-v2 contract. In particular,
 * appendChunk returns Promise<void>, proving older custom stores remain
 * source-assignable to IJobStore.
 */
const legacyStore = {
  async initialize() {},
  async createJob(streamId, userId, conversationId, tenantId) {
    return {
      streamId,
      userId,
      ...(tenantId != null && { tenantId }),
      status: 'running' as const,
      createdAt: 1,
      ...(conversationId != null && { conversationId }),
      syncSent: false,
    };
  },
  async getJob() {
    return null;
  },
  async updateJob() {},
  async transitionStatus() {
    return false;
  },
  async claimIdempotencyKey() {
    return { claimed: true };
  },
  async releaseIdempotencyKey() {},
  async deleteJob() {
    return false;
  },
  async hasJob() {
    return false;
  },
  async getRunningJobs() {
    return [];
  },
  async cleanup() {
    return 0;
  },
  async getJobCount() {
    return 0;
  },
  async getJobCountByStatus() {
    return 0;
  },
  async destroy() {},
  async getActiveJobIdsByUser() {
    return [];
  },
  setGraph() {},
  setContentParts() {},
  async getContentParts() {
    return null;
  },
  async getRunSteps() {
    return [];
  },
  async appendChunk() {},
  clearContentState() {},
  setCollectedUsage() {},
  getCollectedUsage() {
    return [];
  },
  async enqueueSteer() {
    return 1;
  },
  async drainSteers() {
    return [];
  },
  async closeAndDrainSteers() {
    return [];
  },
  async peekSteers() {
    return [];
  },
  async removeSteer() {
    return false;
  },
  async parkSteers() {},
  async claimParkedSteers() {
    return undefined;
  },
  async clearSteers() {},
} satisfies IJobStore;

describe('job-store v2 capability boundary', () => {
  test('keeps a legacy-shaped custom store type-assignable', async () => {
    const store: IJobStore = legacyStore;

    await expect(store.appendChunk('legacy-stream', { event: 'chunk' })).resolves.toBeUndefined();
  });

  test('reports every v2 capability missing from a legacy store', () => {
    expect(getMissingJobStoreV2Methods(legacyStore)).toEqual(JOB_STORE_V2_REQUIRED_METHODS);
    expect(() => assertJobStoreV2(legacyStore)).toThrow(
      `Invalid generation job store: missing required IJobStoreV2 method(s): ${JOB_STORE_V2_REQUIRED_METHODS.join(
        ', ',
      )}`,
    );
  });

  test('accepts the built-in v2 store', () => {
    expect(() => assertJobStoreV2(new InMemoryJobStore())).not.toThrow();
  });

  test('rejects a legacy store before mutating manager configuration', () => {
    const manager = new GenerationJobManagerClass();
    const originalStore = manager.getJobStore();

    expect(() =>
      manager.configure({
        jobStore: legacyStore,
        eventTransport: new InMemoryEventTransport(),
      }),
    ).toThrow('Invalid generation job store: missing required IJobStoreV2 method(s)');
    expect(manager.getJobStore()).toBe(originalStore);
  });

  test('rejects a legacy store passed to the manager constructor', () => {
    expect(() => new GenerationJobManagerClass({ jobStore: legacyStore })).toThrow(
      'Invalid generation job store: missing required IJobStoreV2 method(s)',
    );
  });
});
