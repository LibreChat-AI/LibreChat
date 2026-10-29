import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createResponseStorage, tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { ResponseStorage, StoredResponseRecord } from '@librechat/data-schemas';
import type { Agents } from 'librechat-data-provider';
import type { ResponseDecisionDependencies } from './decision';
import { createBackgroundResponseService, buildPendingBackgroundResponse } from './background';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { createResponseDecisionSubmission } from './decision';
import { enrollAgentExecution } from '../remote/lifecycle';
import { createResponseResumeAdmission } from './resume';
import { GenerationJobManagerClass } from '~/stream';
import { buildPendingAction } from '../hitl/policy';
import { createResponseReview } from './review';

let mongo: MongoMemoryReplSet;
let storage: ResponseStorage;
let jobs: GenerationJobManagerClass;
const owner = { userId: 'decision-owner', tenantId: 'decision-tenant' };
const responseId = 'response-decision';
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run(owner, work);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  storage = createResponseStorage(mongoose);
});
beforeEach(async () => {
  await runAsSystem(() => mongoose.models.StoredResponse.deleteMany({}));
  await runAsSystem(async () => {
    await mongoose.models.ResponseScope?.deleteMany({});
  });
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  jobs.initialize();
});
afterEach(async () => {
  await jobs.destroy();
  jest.restoreAllMocks();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

async function setup(
  payload: Agents.HumanInterruptPayload = {
    type: 'ask_user_question',
    question: { question: 'Which environment?' },
  },
) {
  const execution = await enrollAgentExecution(
    {
      runId: responseId,
      userId: owner.userId,
      conversationId: 'conversation',
      agentId: 'agent',
      protocol: 'responses',
      isPrincipalActive: async () => true,
    },
    { manager: jobs },
  );
  const reserved = await storage.reserve({
    ...owner,
    responseId,
    agentId: 'agent',
    sourceKeyId: 'source-key',
    requestKey: 'request',
    fingerprint: 'request',
    requestJSON: '{"model":"agent","input":"original"}',
    conversationId: 'conversation',
    parentMessageId: 'root',
  });
  if (!reserved.ok) throw new Error('Reservation failed');
  const responseJSON = JSON.stringify({
    ...buildPendingBackgroundResponse(reserved.record),
    status: 'in_progress',
  });
  await storage.publish(owner, responseId, 0, {
    status: 'in_progress',
    responseJSON,
    generationCreatedAt: execution.createdAt,
  });
  await execution.beginProviderExecution();
  const job = (await jobs.getJob(responseId))!;
  const action = buildPendingAction(payload, {
    streamId: responseId,
    responseMessageId: responseId,
    conversationId: 'conversation',
    threadId: 'conversation',
    ttlMs: 60000,
    projectContextKey: 'private-project',
    requestFingerprintV2: 'private-graph',
  });
  expect(
    await execution.pauseForReview(action, async () => {
      const result = await storage.publishReview(
        owner,
        responseId,
        1,
        execution.createdAt,
        {
          actionId: action.actionId,
          providerExecutionId: job.metadata.providerExecutionId!,
          expiresAt: action.expiresAt!,
          partialResponseJSON: '{}',
          pendingActionJSON: JSON.stringify(action),
        },
        responseJSON,
      );
      if (!result.ok) throw new Error('Pause publication failed');
    }),
  ).toBe(true);
  await execution.settle();
  return { action, record: (await storage.read(owner, responseId))! };
}

function fixture(
  options: {
    authorize?: () => boolean;
    validate?: ResponseDecisionDependencies['validate'];
    now?: () => number;
  } = {},
) {
  const enqueue = jest.fn(async (_record: StoredResponseRecord) => {});
  const validate = jest.fn(options.validate ?? (async () => true));
  return {
    enqueue,
    validate,
    submit: createResponseDecisionSubmission({
      storage,
      jobs,
      enqueue,
      authorize: async () => options.authorize?.() ?? true,
      validate,
      now: options.now,
    }),
  };
}

it('stores one immutable question decision under concurrent retries and only queues its saved intent', () =>
  scoped(async () => {
    const { action } = await setup();
    const f = fixture();
    const start = jest.spyOn(jobs, 'beginProviderExecution');
    const resolve = jest.spyOn(jobs.approvals, 'resolve');
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
      ),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const ids = new Set(results.flatMap((result) => (result.ok ? [result.receipt.intentId] : [])));
    expect(ids.size).toBe(1);
    expect(new Set(f.enqueue.mock.calls.map(([record]) => record.resume!.intentId))).toEqual(ids);
    const saved = (await storage.read(owner, responseId))!;
    expect(JSON.parse(saved.resume!.resolutionJSON)).toEqual({ answer: 'staging' });
    expect(JSON.parse(saved.resume!.decisionJSON!)).toEqual({
      actionId: action.actionId,
      answer: 'staging',
    });
    expect(saved.status).toBe('requires_action');
    expect(start).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(JSON.stringify(results)).not.toMatch(/staging|private-project|private-graph/);
  }));

it('preserves tool edits and scope while canonicalizing equivalent object and batch key order', () =>
  scoped(async () => {
    const { action } = await setup({
      type: 'tool_approval',
      action_requests: [
        { name: 'first', tool_call_id: 'a', arguments: {} },
        { name: 'second', tool_call_id: 'b', arguments: {} },
      ],
      review_configs: [
        { action_name: 'first', tool_call_id: 'a', allowed_decisions: ['edit', 'approve'] },
        {
          action_name: 'second',
          tool_call_id: 'b',
          allowed_decisions: ['approve'],
          allow_always: true,
        },
      ],
    });
    const f = fixture();
    const first = await f.submit(owner, responseId, {
      actionId: action.actionId,
      decisions: [
        { tool_call_id: 'b', decision: 'approve', scope: 'session' },
        { tool_call_id: 'a', decision: 'edit', editedArguments: { x: 1, y: 2 } },
      ],
    });
    const again = await f.submit(owner, responseId, {
      decisions: [
        { editedArguments: { y: 2, x: 1 }, decision: 'edit', tool_call_id: 'a' },
        { scope: 'session', decision: 'approve', tool_call_id: 'b' },
      ],
      actionId: action.actionId,
    });
    expect(again).toEqual(first);
    const record = (await storage.read(owner, responseId))!;
    expect(JSON.parse(record.resume!.resolutionJSON)).toEqual({
      a: { type: 'edit', updatedInput: { x: 1, y: 2 } },
      b: { type: 'approve' },
    });
    expect(JSON.parse(record.resume!.decisionJSON!).decisions[1].scope).toBe('session');
  }));

it('rejects a changed decision without replacing or requeueing the original intent', () =>
  scoped(async () => {
    const { action } = await setup();
    const f = fixture();
    await f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' });
    const before = (await storage.read(owner, responseId))!.resume;
    expect(
      await f.submit(owner, responseId, { actionId: action.actionId, answer: 'production' }),
    ).toMatchObject({ ok: false, status: 409 });
    expect((await storage.read(owner, responseId))!.resume).toEqual(before);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  }));

it('recovers a committed reservation whose acknowledgement was lost', () =>
  scoped(async () => {
    const { action } = await setup();
    const reserve = storage.reserveResume.bind(storage);
    jest.spyOn(storage, 'reserveResume').mockImplementationOnce(async (...args) => {
      await reserve(...args);
      throw new Error('lost reservation ACK');
    });
    const f = fixture();
    expect(
      await f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).toMatchObject({ ok: true });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  }));

it('retries queue publication under the same durable decision after a transient queue failure', () =>
  scoped(async () => {
    const { action } = await setup();
    const f = fixture();
    f.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(
      f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).rejects.toThrow('queue unavailable');
    const intentId = (await storage.read(owner, responseId))!.resume!.intentId;
    expect(
      await f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).toMatchObject({ ok: true, receipt: { intentId } });
    expect(f.enqueue.mock.calls.every(([record]) => record.resume!.intentId === intentId)).toBe(
      true,
    );
  }));

it('requires current source authorization and full preflight before accepting a decision', () =>
  scoped(async () => {
    const { action } = await setup();
    const denied = fixture({ authorize: () => false });
    expect(
      await denied.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).toMatchObject({ ok: false, status: 404 });
    expect(denied.validate).not.toHaveBeenCalled();
    const rejected = fixture({ validate: async () => false });
    expect(
      await rejected.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(rejected.enqueue).not.toHaveBeenCalled();
    expect((await storage.read(owner, responseId))!.resume).toBeUndefined();
  }));

it('rejects malformed, overlong, foreign-action and execution-overriding payloads without reserving work', () =>
  scoped(async () => {
    const { action } = await setup();
    const f = fixture();
    for (const body of [
      { actionId: action.actionId, answer: '' },
      { actionId: action.actionId, answer: 'x'.repeat(16001) },
      { actionId: action.actionId, answer: 'staging', model: 'another-agent' },
      { actionId: action.actionId, answer: 'staging', decisions: [] },
      { actionId: action.actionId, answer: 'staging', answers: { other: 'production' } },
      { actionId: 'old-action', answer: 'staging' },
    ])
      expect(await f.submit(owner, responseId, body)).toMatchObject({ ok: false });
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  }));

it('rejects expiry and cancellation without consuming the paused action', () =>
  scoped(async () => {
    const { action, record } = await setup();
    const expired = fixture({ now: () => record.review!.expiresAt });
    expect(
      await expired.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).toMatchObject({ ok: false, status: 409 });
    await storage.requestCancellation(owner, responseId, Date.now());
    const f = fixture();
    expect(
      await f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).toMatchObject({ ok: false, status: 409 });
    expect((await jobs.getJob(responseId))?.status).toBe('requires_action');
    expect((await storage.read(owner, responseId))!.resume).toBeUndefined();
  }));

it('keeps a failed first reservation retryable without queueing or consuming the action', () =>
  scoped(async () => {
    const { action } = await setup();
    const f = fixture();
    jest
      .spyOn(storage, 'reserveResume')
      .mockRejectedValueOnce(new Error('reservation unavailable'));
    await expect(
      f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).rejects.toThrow('reservation unavailable');
    expect(f.enqueue).not.toHaveBeenCalled();
    expect((await storage.read(owner, responseId))!.resume).toBeUndefined();
    expect((await jobs.getJob(responseId))?.status).toBe('requires_action');
  }));

it('does not queue a saved decision if source authority is revoked during preflight', () =>
  scoped(async () => {
    const { action } = await setup();
    let authorized = true;
    const f = fixture({
      authorize: () => authorized,
      validate: async () => {
        authorized = false;
        return true;
      },
    });
    expect(
      await f.submit(owner, responseId, { actionId: action.actionId, answer: 'staging' }),
    ).toMatchObject({ ok: false, status: 404 });
    expect((await storage.read(owner, responseId))!.resume?.state).toBe('reserved');
    expect(f.enqueue).not.toHaveBeenCalled();
    expect((await jobs.getJob(responseId))?.status).toBe('requires_action');
  }));

it('cannot submit to a response owned by another user or tenant', () =>
  scoped(async () => {
    const { action } = await setup();
    const f = fixture();
    for (const other of [
      { ...owner, userId: 'another-user' },
      { ...owner, tenantId: 'another-tenant' },
    ])
      expect(
        await tenantStorage.run(other, () =>
          f.submit(other, responseId, { actionId: action.actionId, answer: 'staging' }),
        ),
      ).toMatchObject({ ok: false, status: 404 });
    expect(f.validate).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect((await storage.read(owner, responseId))!.resume).toBeUndefined();
  }));

it('keeps a submitted decision recoverable through owner review and preserves pause admission during polling', () =>
  scoped(async () => {
    const { action } = await setup();
    const review = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
    const service = createBackgroundResponseService({
      storage,
      authorize: async () => true,
      enqueue: async () => {},
      observe: review.observe,
      cancel: async () => {},
      resolveContinuation: async () => ({
        conversationId: 'conversation',
        parentMessageId: 'root',
      }),
    });
    const first = await service.retrieve(owner, responseId);
    expect(first).toMatchObject({
      ok: true,
      response: { status: 'in_progress', required_action: { kind: 'question' } },
    });
    const submitted = await fixture().submit(owner, responseId, {
      actionId: action.actionId,
      answer: 'staging',
    });
    if (!submitted.ok) throw new Error('Submission failed');
    const polling = await service.retrieve(owner, responseId);
    expect(polling).toMatchObject({ ok: true, response: { status: 'in_progress' } });
    if (polling.ok) expect(polling.response.required_action?.kind).toBe('question');
    const saved = (await storage.read(owner, responseId))!;
    expect((await review.privateView(saved)).pendingDecision).toEqual({
      intentId: submitted.receipt.intentId,
      decision: { actionId: action.actionId, answer: 'staging' },
    });
    expect(JSON.stringify(polling)).not.toContain('staging');
    expect((await storage.read(owner, responseId))?.status).toBe('requires_action');
    const admit = createResponseResumeAdmission({
      storage,
      jobs,
      authorize: async () => true,
      validate: async () => ({ ok: true, provenance: {} }),
    });
    expect(await admit(owner, responseId, submitted.receipt.intentId)).toMatchObject({
      ok: true,
      status: 'ready',
    });
  }));
