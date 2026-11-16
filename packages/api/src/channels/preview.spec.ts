import { tenantStorage } from '@librechat/data-schemas';
import { ContentTypes, FileSources, channelConfigSchema } from 'librechat-data-provider';
import type { AppConfig, ChannelRunRecord, StoredResponseRecord } from '@librechat/data-schemas';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { enrollAgentExecution } from '~/agents/remote/lifecycle';
import { createChannelResponsePreview } from './preview';

let jobs: GenerationJobManagerClass;
let record: StoredResponseRecord;
let run: ChannelRunRecord;
let config: AppConfig;
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId: 'tenant-a' }, work);

beforeEach(async () => {
  jobs = new GenerationJobManagerClass();
  jobs.configure({
    jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
    eventTransport: new InMemoryEventTransport(),
    isRedis: false,
  });
  jobs.initialize();
  const execution = await scope(() =>
    enrollAgentExecution(
      {
        runId: 'resp_preview',
        userId: 'user-a',
        conversationId: 'conversation-a',
        agentId: 'agent-a',
        protocol: 'responses',
        isPrincipalActive: async () => true,
      },
      { manager: jobs },
    ),
  );
  await execution.beginProviderExecution();
  record = {
    tenantId: 'tenant-a',
    userId: 'user-a',
    responseId: 'resp_preview',
    requestKey: 'channel:run-a',
    fingerprint: 'hash',
    agentId: 'agent-a',
    requestJSON: '{}',
    conversationId: 'conversation-a',
    parentMessageId: 'parent-a',
    status: 'in_progress',
    revision: 1,
    generationCreatedAt: execution.createdAt,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  run = {
    tenantId: 'tenant-a',
    channelId: 'channel-a',
    agentId: 'agent-a',
    runId: 'run-a',
    laneId: 'lane-a',
    state: 'executing',
    sequence: 1,
    payloadHash: 'payload',
    receivedAt: Date.now(),
    principal: { userId: 'user-a', channelRevision: 'revision-a' },
    admission: {
      eventId: 'event-a',
      externalChannelId: '123456789012345678',
      externalThreadKey: 'thread-a',
      externalMessageKey: 'message-a',
      actor: {
        provider: 'discord',
        applicationId: '123456789012345679',
        guildId: '123456789012345680',
        externalUserId: '123456789012345681',
      },
      input: 'Hello',
    },
    cancellationRequested: false,
    receipts: [],
    leaseEpoch: 1,
    leaseExpiresAt: Date.now() + 60_000,
  };
  config = {
    config: {},
    fileStrategy: FileSources.local,
    imageOutputType: 'png',
    endpoints: {
      agents: {
        channels: channelConfigSchema.parse({
          enabled: true,
          discord: { enabled: true, streaming: { mode: 'partial', maxPreviewChars: 128 } },
        }),
      },
    },
  };
});

afterEach(() => jobs.destroy());

function preview() {
  return createChannelResponsePreview({ jobs, getConfig: async () => config })(run, record);
}

it('reads live assistant text from the authorized generation without returning tool arguments', async () => {
  jobs.setContentParts(record.responseId, [
    { type: ContentTypes.TEXT, text: 'Hello ' },
    { type: ContentTypes.THINK, think: 'private reasoning' },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: { id: 'call-a', name: 'private_tool', args: 'secret' },
    },
    { type: ContentTypes.TEXT, text: 'world' },
  ]);
  await expect(scope(preview)).resolves.toBe('Hello world');
});

it('bounds preview text without splitting a surrogate pair', async () => {
  jobs.setContentParts(record.responseId, [
    { type: ContentTypes.TEXT, text: `${'a'.repeat(127)}😀more` },
  ]);
  await expect(scope(preview)).resolves.toBe('a'.repeat(127));
});

it.each([
  { userId: 'another-user' },
  { tenantId: 'another-tenant' },
  { agentId: 'another-agent' },
  { conversationId: 'another-conversation' },
  { responseId: 'another-response' },
  { generationCreatedAt: 1 },
  { status: 'completed' as const },
  { status: 'requires_action' as const },
  { cancellationRequestedAt: 1 },
])('refuses a mismatched or unavailable generation: %j', async (patch) => {
  jobs.setContentParts(record.responseId, [{ type: ContentTypes.TEXT, text: 'Private answer' }]);
  record = { ...record, ...patch };
  await expect(scope(preview)).resolves.toBeUndefined();
});

it('does not read live content for default status mode, disabled Discord, Slack or cancellation', async () => {
  const read = jest.spyOn(jobs, 'getResumeState');
  const channels = config.endpoints!.agents!.channels!;
  channels.discord!.streaming.mode = 'status';
  await expect(scope(preview)).resolves.toBeUndefined();
  channels.discord!.streaming.mode = 'partial';
  channels.discord!.enabled = false;
  await expect(scope(preview)).resolves.toBeUndefined();
  channels.discord!.enabled = true;
  run.cancellationRequested = true;
  await expect(scope(preview)).resolves.toBeUndefined();
  run.cancellationRequested = false;
  run.admission.actor = { teamId: 'T1', appId: 'A1', externalUserId: 'U1' };
  await expect(scope(preview)).resolves.toBeUndefined();
  run.admission.actor = {
    provider: 'discord',
    applicationId: '123456789012345679',
    guildId: '123456789012345680',
    externalUserId: '123456789012345681',
  };
  delete channels.discord;
  await expect(scope(preview)).resolves.toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});
