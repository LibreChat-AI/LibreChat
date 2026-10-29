import { tenantStorage } from '@librechat/data-schemas';
import type { StoredResponseRecord, ResponseTerminalReceipt } from '@librechat/data-schemas';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createResponseExecutionRelease } from './completion';

const owner = { userId: 'release-owner', tenantId: 'release-tenant' };
const scope = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);
let jobs: GenerationJobManagerClass;
beforeEach(() => {
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  jobs.initialize();
});
afterEach(async () => {
  await jobs.destroy();
  jest.restoreAllMocks();
});

async function fixture() {
  const responseId = 'resp_release';
  const job = await jobs.createJob(responseId, owner.userId, 'conversation', {
    initialMetadata: { endpoint: 'responses', agent_id: 'agent', responseMessageId: responseId },
  });
  const providerExecutionId = job.metadata.providerExecutionId!;
  await jobs.beginProviderExecution(responseId, job.createdAt, providerExecutionId);
  await jobs.completeJob(responseId, undefined, job.createdAt, {
    expectedProviderExecutionId: providerExecutionId,
    persistencePending: true,
  });
  await jobs.markProviderExecutionDrained(responseId, job.createdAt, providerExecutionId, true);
  const record: StoredResponseRecord = {
    ...owner,
    responseId,
    agentId: 'agent',
    sourceKeyId: 'source',
    requestKey: 'request',
    requestJSON: '{}',
    fingerprint: 'fingerprint',
    conversationId: 'conversation',
    parentMessageId: 'parent',
    status: 'completed',
    generationCreatedAt: job.createdAt,
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    responseJSON: '{}',
  };
  const receipt: ResponseTerminalReceipt = {
    generationCreatedAt: job.createdAt,
    providerExecutionId,
    status: 'completed',
    responseJSON: '{}',
  };
  expect((await jobs.getJob(responseId))?.metadata.terminalPersistencePending).toBe(true);
  return { record, receipt, release: createResponseExecutionRelease(jobs) };
}

it('releases exact post-publication terminal proof with production default cleanup enabled', () =>
  scope(async () => {
    const f = await fixture();
    await f.release(f.record, f.receipt);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
    await expect(f.release(f.record, f.receipt)).resolves.toBeUndefined();
  }));

it('recovers cleanup when Mongo already published and removed its pending receipt', () =>
  scope(async () => {
    const f = await fixture();
    expect(f.record.pendingTerminal).toBeUndefined();
    await f.release(f.record);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
  }));

it.each([
  { userId: 'another-owner' },
  { tenantId: 'another-tenant' },
  { agentId: 'another-agent' },
  { conversationId: 'another-conversation' },
  { generationCreatedAt: 1 },
])('does not release another execution for mismatched record %j', (change) =>
  scope(async () => {
    const f = await fixture();
    await expect(f.release({ ...f.record, ...change }, f.receipt)).rejects.toThrow(
      'identity changed',
    );
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
  }),
);

it('does not release proof for another provider attempt', () =>
  scope(async () => {
    const f = await fixture();
    await expect(
      f.release(f.record, { ...f.receipt, providerExecutionId: 'another-provider' }),
    ).rejects.toThrow('identity changed');
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
  }));

it('does not treat a rejected release acknowledgement as success', () =>
  scope(async () => {
    const f = await fixture();
    jest.spyOn(jobs, 'finishProviderTerminalPersistence').mockResolvedValueOnce(false);
    await expect(f.release(f.record, f.receipt)).rejects.toThrow('release is unavailable');
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).toBe(
      true,
    );
    await f.release(f.record, f.receipt);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
  }));

it('retries job cleanup after the marker was cleared but deletion failed', () =>
  scope(async () => {
    const f = await fixture();
    jest
      .spyOn(jobs.getJobStore(), 'deleteJob')
      .mockRejectedValueOnce(new Error('transient deletion failure'));
    await expect(f.release(f.record, f.receipt)).rejects.toThrow('transient deletion failure');
    expect((await jobs.getJob(f.record.responseId))?.metadata.terminalPersistencePending).not.toBe(
      true,
    );
    await f.release(f.record);
    expect(await jobs.getJob(f.record.responseId)).toBeUndefined();
  }));
