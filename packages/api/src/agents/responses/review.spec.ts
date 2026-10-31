import { tenantStorage } from '@librechat/data-schemas';
import type { StoredResponseRecord } from '@librechat/data-schemas';
import type { Agents } from 'librechat-data-provider';
import type { AgentExecutionEnrollment } from '../remote/lifecycle';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { buildPendingBackgroundResponse } from './background';
import { enrollAgentExecution } from '../remote/lifecycle';
import { buildPendingAction } from '../hitl/policy';
import { createResponseReview } from './review';

let jobs: GenerationJobManagerClass;
let record: StoredResponseRecord;
let execution: AgentExecutionEnrollment;
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: 'tenant-a' }, work);
beforeEach(async () => {
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  jobs.initialize();
  execution = await scope(() =>
    enrollAgentExecution(
      {
        runId: 'resp_test',
        userId: 'user-a',
        conversationId: 'conversation-a',
        agentId: 'agent-a',
        protocol: 'responses',
        isPrincipalActive: async () => true,
      },
      { manager: jobs },
    ),
  );
  record = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    responseId: 'resp_test',
    requestKey: 'request-a',
    fingerprint: 'hash',
    agentId: 'agent-a',
    requestJSON: JSON.stringify({ model: 'agent-a', input: 'Hello', background: true }),
    conversationId: 'conversation-a',
    parentMessageId: 'parent',
    status: 'in_progress',
    revision: 1,
    generationCreatedAt: execution.createdAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  record.responseJSON = JSON.stringify({
    ...buildPendingBackgroundResponse(record),
    status: 'in_progress',
  });
});
afterEach(() => jobs.destroy());

async function prompt(
  authURL = 'https://oauth.example/authorize?state=private-state',
  expiresAt = Date.now() + 60_000,
) {
  await jobs.emitChunk(record.responseId, {
    event: 'on_run_step',
    data: {
      id: 'oauth-step',
      runId: 'run',
      index: 0,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'call', name: 'oauth_mcp_example', args: '' }],
      },
    },
  });
  await jobs.emitChunk(record.responseId, {
    event: 'on_run_step_delta',
    data: {
      id: 'oauth-step',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ name: 'oauth_mcp_example', args: 'private-arguments' }],
        auth: authURL,
        expires_at: expiresAt,
      },
    },
  });
}

async function question(
  payload: Agents.HumanInterruptPayload = {
    type: 'ask_user_question',
    question: { question: 'private owner question' },
  },
) {
  await execution.beginProviderExecution();
  const job = (await jobs.getJob(record.responseId))!;
  const action = buildPendingAction(payload, {
    streamId: record.responseId,
    responseMessageId: record.responseId,
    conversationId: record.conversationId,
    threadId: record.conversationId,
    ttlMs: 60_000,
    projectContextKey: 'private-project-binding',
    requestFingerprintV2: 'private-graph-binding',
    resumeContext: { model: 'private-replay-value' },
  });
  expect(
    await execution.pauseForReview(action, async () => {
      record.status = 'requires_action';
      record.review = {
        actionId: action.actionId,
        expiresAt: action.expiresAt!,
        providerExecutionId: job.metadata.providerExecutionId!,
        partialResponseJSON: '{}',
        pendingActionJSON: JSON.stringify(action),
      };
    }),
  ).toBe(true);
  await execution.settle();
  return action;
}

it('projects a settled question pause only to its owner view and exposes only an opaque public link', async () => {
  const action = await question();
  const review = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
  const view = await review.privateView(record);
  expect(view.status).toBe('in_progress');
  expect(view.pendingAction).toEqual({
    actionId: action.actionId,
    expiresAt: action.expiresAt,
    payload: action.payload,
  });
  expect(JSON.stringify(view)).not.toMatch(/private-project|private-graph|private-replay/);
  const observed = await review.observe(record);
  expect(observed?.response).toMatchObject({
    status: 'in_progress',
    required_action: {
      kind: 'question',
      action_id: action.actionId,
      review_url: 'https://agents.example/responses/resp_test/review',
    },
  });
  expect(JSON.stringify(observed)).not.toContain('private owner question');
  record.responseJSON = JSON.stringify(observed!.response);
  expect(await review.observe(record)).toBeNull();
});

it('hides paused actions after expiry, replacement, source mismatch, cancellation or decision reservation', async () => {
  await question();
  const review = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
  for (const patch of [
    { userId: 'other-owner' },
    { tenantId: 'other-tenant' },
    { agentId: 'other-agent' },
    { generationCreatedAt: record.generationCreatedAt! + 1 },
    { cancellationRequestedAt: Date.now() },
    { review: { ...record.review!, providerExecutionId: 'another-provider' } },
    { review: undefined },
    { status: 'completed' as const },
    {
      resume: {
        intentId: 'reserved-decision',
        actionId: record.review!.actionId,
        previousProviderExecutionId: record.review!.providerExecutionId,
        providerExecutionId: 'next-provider',
        fingerprint: 'decision',
        resolutionJSON: '{}',
        state: 'reserved' as const,
        reservedAt: Date.now(),
      },
    },
  ])
    expect((await review.privateView({ ...record, ...patch })).pendingAction).toBeUndefined();
  expect(
    (
      await createResponseReview({
        jobs,
        publicBaseURL: 'https://agents.example',
        now: () => record.review!.expiresAt,
      }).privateView(record)
    ).pendingAction,
  ).toBeUndefined();
});

it('keeps tool arguments owner-only while projecting the tool approval kind publicly', async () => {
  await question({
    type: 'tool_approval',
    action_requests: [
      { name: 'lookup', tool_call_id: 'call', arguments: { query: 'private-arguments' } },
    ],
    review_configs: [
      { action_name: 'lookup', tool_call_id: 'call', allowed_decisions: ['approve', 'reject'] },
    ],
  });
  const review = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
  expect((await review.privateView(record)).pendingAction?.payload.type).toBe('tool_approval');
  const publicView = await review.observe(record);
  expect(publicView?.response.required_action?.kind).toBe('tool_approval');
  expect(JSON.stringify(publicView)).not.toContain('private-arguments');
  expect(JSON.stringify(publicView)).not.toContain('lookup');
});

it('projects real durable OAuth events into an opaque review link and clears it after completion', async () => {
  const review = createResponseReview({ jobs, publicBaseURL: 'https://agents.example/base' });
  await prompt();
  const observed = await review.observe(record);
  expect(observed?.response.required_action).toMatchObject({
    type: 'librechat_review',
    kind: 'oauth',
    action_id: expect.stringMatching(/^oauth-[a-f0-9]{64}$/),
    review_url: 'https://agents.example/base/responses/resp_test/review',
  });
  expect(JSON.stringify(observed)).not.toMatch(/private-|oauth.example|oauth_mcp_example/);
  expect((await review.privateView(record)).oauth).toEqual([
    expect.objectContaining({ authURL: 'https://oauth.example/authorize?state=private-state' }),
  ]);
  record.responseJSON = JSON.stringify(observed!.response);
  record.status = 'requires_action';
  expect(await review.observe(record)).toBeNull();
  await jobs.emitChunk(record.responseId, {
    event: 'on_run_step_completed',
    data: {
      result: {
        id: 'oauth-step',
        index: 0,
        tool_call: { id: 'call', name: 'oauth_mcp_example', output: 'private-result' },
      },
    },
  });
  expect((await review.observe(record))?.response.required_action).toBeUndefined();
  expect((await review.privateView(record)).oauth).toHaveLength(0);
});

it('reports lost execution after a restart without stale OAuth actions, false completion or automatic replay', async () => {
  await prompt();
  const before = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
  const waiting = await before.observe(record);
  expect(waiting?.response.required_action?.kind).toBe('oauth');
  record.responseJSON = JSON.stringify(waiting!.response);
  await jobs.destroy();
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  jobs.initialize();
  const restarted = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
  const privateView = await restarted.privateView(record);
  expect(privateView).toMatchObject({
    status: 'in_progress',
    oauth: [],
    recovery: 'execution_state_unavailable',
  });
  expect(privateView.pendingAction).toBeUndefined();
  const publicView = await restarted.observe(record);
  expect(publicView?.response).toMatchObject({
    id: record.responseId,
    status: 'in_progress',
    output: [],
    recovery: 'execution_state_unavailable',
  });
  expect(publicView?.response.required_action).toBeUndefined();
  expect(JSON.stringify(publicView)).not.toMatch(/private-state|oauth.example|private-arguments/);
  expect(await jobs.getJob(record.responseId)).toBeUndefined();
  record.responseJSON = JSON.stringify(publicView!.response);
  expect(await restarted.observe(record)).toBeNull();
});

it.each([
  'javascript:alert(1)',
  'http://external.example/auth',
  'https://user:password@oauth.example',
])('rejects unsafe authorization URL %s', async (url) => {
  await prompt(url);
  const review = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
  expect((await review.privateView(record)).oauth).toEqual([]);
  expect(await review.observe(record)).toBeNull();
});

it('does not disclose prompts for replaced generations, wrong owners/tenants/agents or cancellation', async () => {
  await prompt();
  const review = createResponseReview({ jobs, publicBaseURL: 'https://agents.example' });
  for (const patch of [
    { generationCreatedAt: record.generationCreatedAt! + 1 },
    { userId: 'other' },
    { tenantId: 'other' },
    { agentId: 'other' },
    { conversationId: 'other' },
    { cancellationRequestedAt: Date.now() },
    { status: 'completed' as const },
  ])
    expect((await review.privateView({ ...record, ...patch })).oauth).toEqual([]);
});

it('hides expired prompts and requires a trusted review base URL', async () => {
  await prompt(undefined, Date.now() - 1);
  expect(
    (
      await createResponseReview({ jobs, publicBaseURL: 'https://agents.example' }).privateView(
        record,
      )
    ).oauth,
  ).toEqual([]);
  await prompt();
  expect(await createResponseReview({ jobs }).observe(record)).toBeNull();
  expect(
    await createResponseReview({ jobs, publicBaseURL: 'http://untrusted.example' }).observe(record),
  ).toBeNull();
});
