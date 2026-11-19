import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import { discordRunControl, parseDiscordControl } from 'librechat-data-provider';
import { createDiscordCommandStorage, createResponseStorage } from '@librechat/data-schemas';
import type {
  Agents,
  DiscordIngressAction,
  ResponseReviewView,
  DiscordPrivateReply,
} from 'librechat-data-provider';
import {
  db,
  tenantId,
  owner,
  otherActor,
  externalChannelId,
  externalUserId,
  scope,
  models,
  channels,
  runs,
  authority,
  channel,
  now,
  linked,
  invoke,
  allRuns,
  claim,
  native,
  unwrap,
  advanceClock,
  inbox,
} from './commands.helper';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { createResponseDecisionSubmission } from '~/agents/responses/decision';
import { buildPendingBackgroundResponse } from '~/agents/responses/background';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createDiscordReviewHandler, projectDiscordReview } from './review';
import { createResponseReview } from '~/agents/responses/review';
import { enrollAgentExecution } from '~/agents/remote/lifecycle';
import { buildPendingAction } from '~/agents/hitl/policy';
import { createDiscordCommandExecutor } from './commands';
import { GenerationJobManagerClass } from '~/stream';

let jobs: GenerationJobManagerClass;
beforeEach(() => {
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  jobs.initialize();
});
afterEach(async () => jobs?.destroy());
const messageId = '890123456789012345';
const tool: Agents.HumanInterruptPayload = {
  type: 'tool_approval',
  action_requests: [
    {
      name: 'send_email',
      tool_call_id: 'call-a',
      arguments: { to: 'recipient@example.test', text: 'Private tool arguments' },
    },
  ],
  review_configs: [
    { action_name: 'send_email', tool_call_id: 'call-a', allowed_decisions: ['approve', 'reject'] },
  ],
};
async function fixture(payload: Agents.HumanInterruptPayload = tool) {
  await linked();
  await invoke({ kind: 'ask', prompt: 'Please work' });
  const [run] = await allRuns();
  const responseId = `response-${run.runId}`;
  const responseOwner = { tenantId, userId: owner };
  const storage = createResponseStorage(db);
  const execution = await enrollAgentExecution(
    {
      runId: responseId,
      userId: owner,
      conversationId: 'conversation',
      agentId: 'agent',
      protocol: 'responses',
      isPrincipalActive: async () => true,
    },
    { manager: jobs },
  );
  const reserved = await storage.reserve({
    ...responseOwner,
    responseId,
    agentId: 'agent',
    requestKey: 'review-request',
    fingerprint: 'request',
    requestJSON: '{}',
    conversationId: 'conversation',
    parentMessageId: 'root',
  });
  if (!reserved.ok) throw new Error('Missing response');
  const responseJSON = JSON.stringify({
    ...buildPendingBackgroundResponse(reserved.record),
    status: 'in_progress',
  });
  await storage.publish(responseOwner, responseId, 0, {
    status: 'in_progress',
    responseJSON,
    generationCreatedAt: execution.createdAt,
  });
  await execution.beginProviderExecution();
  const job = await jobs.getJob(responseId);
  if (!job?.metadata.providerExecutionId) throw new Error('Missing execution');
  const action = buildPendingAction(payload, {
    streamId: responseId,
    responseMessageId: responseId,
    conversationId: 'conversation',
    threadId: 'conversation',
    ttlMs: 60000,
  });
  expect(
    await execution.pauseForReview(action, async () => {
      const published = await storage.publishReview(
        responseOwner,
        responseId,
        { execution: (await storage.read(responseOwner, responseId))! },
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
      if (!published.ok) throw new Error('Pause publication failed');
    }),
  ).toBe(true);
  await execution.settle();
  await models.ChannelRun.updateOne(
    { runId: run.runId },
    {
      $set: {
        state: 'requires_action',
        execution: {
          protocol: 'responses',
          responseId,
          requestId: 'request',
          conversationId: 'conversation',
          parentMessageId: 'root',
        },
        snapshot: {
          responseId,
          status: 'requires_action',
          text: '',
          elapsedMs: 1,
          pendingAction: {
            actionId: action.actionId,
            kind: payload.type,
            expiresAt: Math.floor(action.expiresAt! / 1000) * 1000,
          },
        },
        progress: {
          revision: 1,
          rendererVersion: 'discord-progress-v1',
          text: 'Working',
          outcome: 'confirmed',
          attempts: 1,
          externalMessageKey: `${externalChannelId}:${messageId}`,
        },
      },
    },
  );
  const commands = createDiscordCommandStorage(db);
  const submit = createResponseDecisionSubmission({
    storage,
    jobs,
    authorize: async () => true,
    validate: async () => true,
    enqueue: async () => {},
    now: () => now,
  });
  const reader = createResponseReview({
    jobs,
    publicBaseURL: 'https://chat.example/',
    now: () => now,
  });
  const interactive = {
    readInteractiveReview: async (_scope: object, id: string) => {
      const current = await storage.read(responseOwner, id);
      return current ? { ...(await reader.privateView(current)), canSubmitDecision: true } : null;
    },
    submitInteractiveReview: submit,
  };
  const review = createDiscordReviewHandler({
    commands,
    interactive,
    resolvePrincipal: authority.resolvePrincipal,
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    publicBaseUrl: 'https://chat.example/',
    now: () => now,
  });
  const execute = createDiscordCommandExecutor({
    channels,
    authority,
    runs,
    commands,
    review,
    enabled: async () => true,
    now: () => now,
  });
  async function command(input: DiscordIngressAction, actor = externalUserId) {
    const job = await claim(input, actor);
    const reply = await execute(job.record, job.fence, native(job.record));
    unwrap(await inbox.prepareReply(job.fence, 'sealed-reply', now));
    await inbox.finish(job.fence, 'completed', now);
    return { reply, eventId: job.record.eventId };
  }
  const entry = parseDiscordControl(discordRunControl('review', run.runId), messageId);
  if (!entry) throw new Error('Missing review entry');
  const open = () => command(entry);
  return { run, responseId, storage, responseOwner, action, command, open };
}
function control(reply: DiscordPrivateReply, choice = 0) {
  const button = reply.actions?.[choice];
  const reference = button && 'reference' in button ? button.reference : undefined;
  if (!reference) throw new Error('Missing review control');
  const action = parseDiscordControl(reference);
  if (!action) throw new Error('Invalid review control');
  return action;
}
it('records one canonical once approval and returns its receipt on replay without resubmission', () =>
  scope(async () => {
    const f = await fixture();
    const { reply, eventId } = await f.open();
    expect(reply.content).toContain('Private tool arguments');
    expect(reply.actions?.map((item) => item.label)).toEqual([
      'Approve once',
      'Decline',
      'Open in LibreChat',
    ]);
    const row = await db
      .model('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedReview +encryptedToken +encryptedReply +action')
      .lean();
    expect(row).toHaveProperty('encryptedReview');
    expect(row).not.toHaveProperty('encryptedToken');
    expect(row).not.toHaveProperty('encryptedReply');
    expect(JSON.stringify(row)).not.toContain('Private tool arguments');
    const approval = control(reply);
    expect((await f.command(approval)).reply.content).toContain('queued for processing');
    const saved = await f.storage.read(f.responseOwner, f.responseId);
    expect(JSON.parse(saved!.resume!.decisionJSON!)).toEqual({
      actionId: f.action.actionId,
      decisions: [{ tool_call_id: 'call-a', decision: 'approve', scope: 'once' }],
    });
    expect((await f.command(approval)).reply.content).toContain('already recorded');
    expect((await f.storage.read(f.responseOwner, f.responseId))?.resume?.intentId).toBe(
      saved?.resume?.intentId,
    );
    expect((await f.command(control(reply, 1))).reply.content).toContain('no longer available');
  }));
it('keeps review private from another Discord actor even when the LibreChat account is the same', () =>
  scope(async () => {
    const f = await fixture();
    await linked(otherActor, owner);
    const opened = await f.open();
    const denial = await f.command(control(opened.reply), otherActor);
    expect(denial.reply.content).toContain('no longer available');
    expect(JSON.stringify(denial)).not.toContain('Private tool arguments');
    expect((await f.storage.read(f.responseOwner, f.responseId))?.resume).toBeUndefined();
    const bad = await f.command({
      kind: 'review',
      reference: f.run.runId,
      messageId: '890123456789012346',
    });
    expect(bad.reply.content).toContain('no longer available');
  }));
it.each(['expired', 'stale', 'cancelled', 'revoked'] as const)(
  'refuses a %s private decision without consuming the request',
  (state) =>
    scope(async () => {
      const f = await fixture();
      const opened = await f.open();
      if (state === 'expired') advanceClock(61000);
      if (state === 'stale')
        await db
          .model('StoredResponse')
          .updateOne({ responseId: f.responseId }, { $set: { 'review.actionId': 'replacement' } });
      if (state === 'cancelled')
        await models.ChannelRun.updateOne(
          { runId: f.run.runId },
          { $set: { cancellationRequested: true } },
        );
      if (state === 'revoked')
        await db
          .model('ChannelIdentity')
          .updateOne(
            { 'identity.externalUserId': externalUserId },
            { $set: { state: 'revoked', revision: 'revoked' } },
          );
      expect((await f.command(control(opened.reply))).reply.content).toContain(
        'no longer available',
      );
      expect((await f.storage.read(f.responseOwner, f.responseId))?.resume).toBeUndefined();
    }),
);
it('submits a canonical simple choice answer and keeps OAuth in the browser', () =>
  scope(async () => {
    const f = await fixture({
      type: 'ask_user_question',
      question: {
        question: 'Which environment?',
        options: [
          { label: 'Staging', value: 'staging' },
          { label: 'Production', value: 'production' },
        ],
      },
    });
    const opened = await f.open();
    expect(opened.reply.actions?.[0].label).toBe('Staging');
    await f.command(control(opened.reply));
    expect(
      JSON.parse((await f.storage.read(f.responseOwner, f.responseId))!.resume!.decisionJSON!),
    ).toEqual({ actionId: f.action.actionId, answer: 'staging' });
    const view: ResponseReviewView = {
      responseId: f.responseId,
      status: 'in_progress',
      canSubmitDecision: true,
      oauth: [
        {
          actionId: 'oauth',
          toolName: 'private',
          authURL: 'https://secret.example/token',
          expiresAt: now + 60000,
        },
      ],
      pendingAction: { actionId: 'a', payload: tool, expiresAt: now + 60000 },
    };
    expect(projectDiscordReview(view)).toBeNull();
    expect(
      projectDiscordReview({
        ...view,
        oauth: [],
        pendingAction: {
          ...view.pendingAction!,
          payload: {
            ...tool,
            action_requests: [{ ...tool.action_requests[0], arguments: 'x'.repeat(2000) }],
          },
        },
      }),
    ).toBeNull();
  }));
it.each(['user', 'channel'] as const)(
  'erases retained encrypted reviews with the existing %s privacy cascade',
  (kind) =>
    scope(async () => {
      const f = await fixture();
      const opened = await f.open();
      if (kind === 'user') {
        expect((await channels.deleteUserById(owner)).deletedCount).toBe(1);
      } else {
        await channels.beginAgentChannelDeletion(channel.channelId, owner);
      }
      expect(
        await db
          .model('DiscordInbox')
          .findOne({ eventId: opened.eventId })
          .select('+encryptedReview')
          .lean(),
      ).toBeNull();
    }),
);

it('shows complete tool argument JSON without allowing a request to break its code block', () => {
  const args = { text: 'before```after <@everyone>' };
  const projection = projectDiscordReview({
    responseId: 'response',
    status: 'in_progress',
    oauth: [],
    canSubmitDecision: true,
    pendingAction: {
      actionId: 'action',
      expiresAt: Date.now() + 60000,
      payload: { ...tool, action_requests: [{ ...tool.action_requests[0], arguments: args }] },
    },
  });
  expect(projection).not.toBeNull();
  const json = projection!.content.split('```json\n')[1].split('\n```')[0];
  expect(JSON.parse(json)).toEqual(args);
});

it('uses the browser when distinct option values have indistinguishable sanitized labels', () => {
  expect(
    projectDiscordReview({
      responseId: 'response',
      status: 'in_progress',
      oauth: [],
      canSubmitDecision: true,
      pendingAction: {
        actionId: 'action',
        expiresAt: Date.now() + 60000,
        payload: {
          type: 'ask_user_question',
          question: {
            question: 'Choose',
            options: [
              { label: 'A@', value: 'first' },
              { label: 'A<', value: 'second' },
            ],
          },
        },
      },
    }),
  ).toBeNull();
});
