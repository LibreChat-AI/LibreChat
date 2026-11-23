import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { withChannelFeedbackAuthority } from './channelFeedbackScope';
import { TransactionUnavailableError } from '~/utils/transactions';
import { createChannelIdentityStorage } from './channelIdentity';
import { createAgentApiKeyMethods } from './agentApiKey';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { retireAgentChannel } from './channelScope';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('transactional channel writes fail before private persistence', () => {
  const standalone = new mongoose.Mongoose();
  const ferret = process.env.FERRETDB_URI ? new mongoose.Mongoose() : undefined;
  const engines: Array<readonly [string, typeof standalone]> = [
    ['standalone', standalone],
    ...(ferret ? [['FerretDB', ferret] as const] : []),
  ];
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await standalone.connect(mongo.getUri(), { autoIndex: false });
    if (ferret)
      await ferret.connect(process.env.FERRETDB_URI!, {
        dbName: `guards_${randomUUID().replace(/-/g, '')}`,
        autoIndex: false,
      });
    for (const [, db] of engines) createModels(db);
  }, 60000);
  afterAll(async () => {
    await Promise.all(engines.map(([, db]) => db.disconnect()));
    await mongo?.stop();
  });

  describe.each(engines)('%s', (_name, db) => {
    it('rejects channel credentials, identity, run, bound-key and feedback writes before payload insertion', async () => {
      const userId = new db.Types.ObjectId();
      const channelId = randomUUID();
      const channels = createAgentChannelMethods(db);
      await expect(
        channels.createAgentChannel({
          channelId,
          agentId: 'agent',
          createdBy: String(userId),
          type: 'slack',
          status: 'active',
          credentialMode: 'shared',
          revision: 'revision',
          encryptedBotToken: 'test-ciphertext',
          encryptedSigningSecret: 'test-ciphertext',
          slack: { teamId: 'team', appId: 'app', botUserId: 'bot' },
        }),
      ).rejects.toBeInstanceOf(TransactionUnavailableError);
      await expect(
        createChannelIdentityStorage(db).saveChannelIdentity(
          {
            tenantId: '_',
            linkId: 'link',
            revision: 'revision',
            state: 'pending',
            ticketHash: 'test-ticket',
            ticketExpiresAtMs: 1000,
            expiresAtMs: 2000,
            identity: {
              tenantId: '_',
              channelId,
              channelRevision: 'revision',
              teamId: 'team',
              externalUserId: 'actor',
              agentId: 'agent',
            },
          },
          null,
        ),
      ).rejects.toBeInstanceOf(TransactionUnavailableError);
      await expect(
        createChannelRunStorage(db).admit(
          {
            tenantId: '_',
            channelId,
            agentId: 'agent',
            principal: { userId: String(userId), channelRevision: 'revision' },
            admission: {
              eventId: 'event',
              externalChannelId: 'channel',
              externalThreadKey: 'thread',
              externalMessageKey: 'message',
              actor: { teamId: 'team', appId: 'app', externalUserId: 'actor' },
              input: 'test private prompt',
            },
          },
          Date.now(),
        ),
      ).rejects.toBeInstanceOf(TransactionUnavailableError);
      await expect(
        createAgentApiKeyMethods(db).createAgentApiKey({
          userId,
          name: 'Bound test key',
          binding: { kind: 'channel', id: channelId },
        }),
      ).rejects.toBeInstanceOf(TransactionUnavailableError);
      const effect = jest.fn();
      await expect(
        withChannelFeedbackAuthority(
          db,
          {
            tenantId: '_',
            channelId,
            channelRevision: 'revision',
            teamId: 'team',
            agentId: 'agent',
            runId: 'run',
            responseId: 'resp_test',
            messageId: 'resp_test',
            conversationId: randomUUID(),
            principalId: String(userId),
            externalMessageKey: 'message',
            traceId: 'trace',
            centralTraceExportEnabled: false,
          },
          effect,
        ),
      ).rejects.toBeInstanceOf(TransactionUnavailableError);
      expect(effect).not.toHaveBeenCalled();
      for (const model of [
        'AgentChannel',
        'ChannelIdentity',
        'ChannelRun',
        'ChannelLane',
        'AgentApiKey',
        'ChannelReply',
        'ChannelFeedback',
        'ChannelFeedbackEvent',
      ]) {
        expect(await db.model(model).countDocuments()).toBe(0);
      }
    });

    it('keeps ordinary personal API keys and missing-channel cleanup available', async () => {
      const userId = new db.Types.ObjectId();
      const keys = createAgentApiKeyMethods(db);
      const created = await keys.createAgentApiKey({ userId, name: 'Personal test key' });
      const validated = await keys.validateAgentApiKey(created.key);
      expect(String(validated?.userId)).toBe(String(userId));
      await db.model('AgentApiKey').deleteOne({ _id: created.id });
      expect(
        await retireAgentChannel(db, {
          channelId: randomUUID(),
          createdBy: String(userId),
        }),
      ).toBeNull();
    });
  });
});

describe('channel transactions with a secondaryPreferred client default', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri(), { readPreference: 'secondaryPreferred', autoIndex: false });
    createModels(db);
  }, 60000);
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });

  it('commits channel, link, run, credential, feedback and retirement operations', async () => {
    const userId = new db.Types.ObjectId();
    const channelId = randomUUID();
    const channels = createAgentChannelMethods(db);
    await channels.createAgentChannel({
      channelId,
      agentId: 'agent',
      createdBy: String(userId),
      type: 'slack',
      status: 'active',
      credentialMode: 'shared',
      revision: 'revision',
      encryptedBotToken: 'test-ciphertext',
      encryptedSigningSecret: 'test-ciphertext',
      slack: { teamId: 'team', appId: 'app', botUserId: 'bot' },
    });
    expect(
      await channels.updateAgentChannel(channelId, String(userId), { revision: 'revision' }),
    ).toMatchObject({ channelId, status: 'active' });
    const identities = createChannelIdentityStorage(db);
    expect(
      await identities.saveChannelIdentity(
        {
          tenantId: '_',
          linkId: 'link',
          revision: 'revision',
          state: 'pending',
          ticketHash: 'test-ticket',
          ticketExpiresAtMs: Date.now() + 60000,
          expiresAtMs: Date.now() + 120000,
          identity: {
            tenantId: '_',
            channelId,
            channelRevision: 'revision',
            teamId: 'team',
            externalUserId: 'actor',
            agentId: 'agent',
          },
        },
        null,
      ),
    ).toBe(true);
    await identities.revokeChannelIdentities('_', channelId, 'revoked');
    expect(await identities.readChannelLink('_', 'link')).toMatchObject({ state: 'revoked' });
    const runs = createChannelRunStorage(db);
    const { run } = await runs.admit(
      {
        tenantId: '_',
        channelId,
        agentId: 'agent',
        principal: { userId: String(userId), channelRevision: 'revision' },
        admission: {
          eventId: 'event',
          externalChannelId: 'channel',
          externalThreadKey: 'thread',
          externalMessageKey: 'message',
          actor: { teamId: 'team', appId: 'app', externalUserId: 'actor' },
          input: 'test prompt',
        },
      },
      Date.now(),
    );
    expect(await runs.claim('_', channelId, 'worker', Date.now(), 30000)).toMatchObject({
      runId: run.runId,
      leaseOwner: 'worker',
    });
    const keys = createAgentApiKeyMethods(db);
    const key = await keys.createAgentApiKey({
      userId,
      name: 'Bound test key',
      binding: { kind: 'channel', id: channelId },
    });
    expect(await keys.validateAgentApiKey(key.key)).toBeNull();
    expect(await keys.validateBoundAgentApiKey(key.key)).toMatchObject({ userId: String(userId) });
    const conversationId = randomUUID();
    await db.models.Message.create({
      user: String(userId),
      conversationId,
      messageId: 'response',
      isCreatedByUser: false,
      sender: 'Agent',
      endpoint: 'agents',
      model: 'agent',
      text: 'answer',
    });
    const mapping = {
      tenantId: '_',
      channelId,
      channelRevision: 'revision',
      teamId: 'team',
      agentId: 'agent',
      runId: run.runId,
      responseId: 'response',
      messageId: 'response',
      conversationId,
      principalId: String(userId),
      externalMessageKey: 'reply',
      traceId: 'trace',
      centralTraceExportEnabled: false,
    };
    expect(await withChannelFeedbackAuthority(db, mapping, async () => 'authorized')).toBe(
      'authorized',
    );
    expect(
      await retireAgentChannel(db, { channelId, createdBy: String(userId) }, true),
    ).toMatchObject({ status: 'deleting' });
    const retired = await db.models.AgentChannel.findOne({ channelId })
      .select('+encryptedBotToken +encryptedSigningSecret')
      .lean();
    expect(retired).not.toHaveProperty('encryptedBotToken');
    expect(retired).not.toHaveProperty('encryptedSigningSecret');
  });
});
