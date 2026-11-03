import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import { RetentionMode, Tools, MCP_APP_MIME_TYPE, EModelEndpoint } from 'librechat-data-provider';
import type { ManagedTarget } from '~/types/managed';
import {
  allocateManagedTarget,
  discardManagedAllocation,
  managedTargetFilter,
  pinManagedTarget,
  ManagedAllocationUnavailableError,
  beginManagedTargetRegistration,
  markManagedTargetRegistered,
  sweepManagedAllocations,
} from './managed';
import { createManagedConversationId, createManagedMessageId } from '~/utils/managed';
import { registerResponseTarget, settleResponseTarget } from './registration';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { applyManagedStorage } from '~/models/plugins/managed';
import { createChatProjectModel } from '~/models/chatProject';
import { includeManagedAllocations } from '~/utils/managed';
import { createConversationMethods } from './conversation';
import { createConversationModel } from '~/models/convo';
import { createMessageModel } from '~/models/message';
import { responseScopeKeys } from './responseScope';
import { createMessageMethods } from './message';

describe('managed target allocation on real storage', () => {
  const standalone = new mongoose.Mongoose();
  const replica = new mongoose.Mongoose();
  const ferret = process.env.FERRETDB_URI ? new mongoose.Mongoose() : undefined;
  const engines: Array<readonly [string, typeof standalone]> = [
    ['standalone', standalone],
    ['replica', replica],
    ...(ferret ? [['FerretDB', ferret] as const] : []),
  ];
  let mongo: MongoMemoryServer;
  let repl: MongoMemoryReplSet;

  beforeAll(async () => {
    [mongo, repl] = await Promise.all([
      MongoMemoryServer.create({ instance: { args: ['--setParameter', 'enableTestCommands=1'] } }),
      MongoMemoryReplSet.create({
        replSet: { count: 1 },
        instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
      }),
    ]);
    await Promise.all([
      standalone.connect(mongo.getUri(), { monitorCommands: true, retryWrites: true }),
      replica.connect(repl.getUri(), {
        monitorCommands: true,
        retryWrites: true,
        readPreference: 'secondaryPreferred',
      }),
    ]);
    if (ferret)
      await ferret.connect(process.env.FERRETDB_URI!, {
        dbName: `managed_${randomUUID().replace(/-/g, '')}`,
        retryWrites: true,
      });
    for (const [, db] of engines) {
      const Message = createMessageModel(db);
      const Conversation = createConversationModel(db);
      await createChatProjectModel(db).init();
      await Promise.all([Message.init(), Conversation.init()]);
      await Promise.all([Message.createIndexes(), Conversation.createIndexes()]);
    }
  }, 60000);

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(engines.map(([, db]) => db.disconnect()));
    await Promise.all([mongo?.stop(), repl?.stop()]);
  });

  describe.each(engines)('%s', (_name, db) => {
    const mongoOnly = db === ferret ? describe.skip : describe;
    it.each(['message', 'conversation'] as const)(
      'sweeps unclaimed %s allocations with keyset pages and preserves pinned rows',
      async (kind) => {
        const tenantId = randomUUID();
        await tenantStorage.run({ tenantId }, async () => {
          for (let i = 0; i < 3; i++) await allocateManagedTarget(db, kind, tenantId);
          const pinned = await allocateManagedTarget(db, kind, tenantId);
          expect(await pinManagedTarget(db, pinned, new db.Types.ObjectId().toHexString())).toBe(
            true,
          );
          const first = await sweepManagedAllocations(db, kind, { limit: 2, tenantId });
          expect(first.deleted).toBe(2);
          expect(first.next).toMatch(/^[a-f\d]{24}$/);
          expect(
            await sweepManagedAllocations(db, kind, { limit: 2, tenantId, after: first.next }),
          ).toEqual({ deleted: 1 });
          expect(
            await db
              .model(kind === 'message' ? 'Message' : 'Conversation')
              .collection.findOne(managedTargetFilter(db, pinned)),
          ).toMatchObject({ _managed: { phase: 'pinned' } });
        });
      },
    );

    it('serializes orphan disposal against pinning without deleting the winner', async () => {
      const target = await allocateManagedTarget(db, 'message');
      const [pinned, discarded] = await Promise.all([
        pinManagedTarget(db, target, new db.Types.ObjectId().toHexString()),
        discardManagedAllocation(db, target),
      ]);
      expect([pinned, discarded].filter(Boolean)).toHaveLength(1);
      const row = await db.model('Message').collection.findOne(managedTargetFilter(db, target));
      if (pinned) expect(row).toMatchObject({ _managed: { phase: 'pinned' } });
      else expect(row).toBeNull();
    });
    it.each(['legacy', 'managed'] as const)(
      'pins %s Conversation append/reply updates to the captured physical record',
      async (kind) => {
        const userId = randomUUID();
        const conversationId = kind === 'legacy' ? randomUUID() : createManagedConversationId();
        const Conversation = db.model('Conversation');
        const row = await Conversation.create({
          conversationId,
          user: userId,
          title: 'Original',
          endpoint: EModelEndpoint.agents,
        });
        const messages = createMessageMethods(db);
        const methods = createConversationMethods(db, {
          ...messages,
          conversationTarget: { id: String(row._id), conversationId, userId },
        });
        const messageId = new db.Types.ObjectId().toHexString();
        expect(
          await methods.saveConvo(
            { userId },
            { conversationId, title: 'Appended' },
            {
              appendMessageIds: [messageId],
              stampReply: true,
              replyMessageId: 'resp_confirmed',
            },
          ),
        ).toMatchObject({ title: 'Appended', lastResponseMessageId: 'resp_confirmed' });
        const beforeDelete = await db
          .model('Conversation')
          .collection.findOne({ conversationId, user: userId });
        expect(beforeDelete?.messages.map(String)).toEqual([messageId]);
        await db.model('Conversation').collection.deleteOne({ _id: row._id });
        const replacement = await Conversation.create({
          conversationId,
          user: userId,
          title: 'Replacement',
          endpoint: EModelEndpoint.agents,
        });
        expect(
          await methods.saveConvo(
            { userId },
            { conversationId, title: 'Stale writer' },
            {
              appendMessageIds: [messageId],
              stampReply: true,
              replyMessageId: 'resp_stale',
            },
          ),
        ).toBeNull();
        expect(await db.model('Conversation').findById(replacement._id)).toMatchObject({
          title: 'Replacement',
          messages: [],
        });
        await expect(methods.saveConvo({ userId: 'other' }, { conversationId })).rejects.toThrow(
          'target mismatch',
        );
      },
    );

    it.each([false, true])(
      'publishes canonical Conversation creation fields (archived: %s)',
      async (archived) => {
        const userId = randomUUID();
        const conversationId = createManagedConversationId();
        const target = await allocateManagedTarget(db, 'conversation');
        const parentId = new db.Types.ObjectId().toHexString();
        const [ownerKey, conversationKey] = responseScopeKeys({ userId }, conversationId);
        const publication = {
          target,
          parentId,
          ownerKey,
          conversationKey,
          logicalId: conversationId,
          receipt: createHash('sha256').update(randomUUID()).digest('hex'),
        };
        expect(await pinManagedTarget(db, target, parentId)).toBe(true);
        expect(await beginManagedTargetRegistration(db, target, parentId)).toBe(true);
        const entry = { key: publication.receipt, target, retentionEpoch: 0 };
        await registerResponseTarget(db, { userId }, undefined, entry);
        await registerResponseTarget(db, { userId }, conversationId, entry);
        expect(await markManagedTargetRegistered(db, publication)).toBe(true);
        const project = await db
          .model('ChatProject')
          .create({ user: userId, name: 'Managed project' });
        const deadline = new Date(Date.now() + 60000);
        await db.model('Conversation').collection.updateOne(managedTargetFilter(db, target), {
          $set: { expiredAt: deadline },
        });
        const messages = createMessageMethods(db);
        const conversations = createConversationMethods(db, {
          ...messages,
          managedPublication: publication,
        });
        const createdAt = new Date('2026-01-01T00:00:00Z');
        const messageId = new db.Types.ObjectId().toHexString();
        const params = {
          conversationId,
          title: 'Confirmed title',
          codeEnvironmentMode: 'without_attached',
          chatProjectId: String(project._id),
          isArchived: archived,
        };
        const saved = await conversations.saveConvo({ userId }, params, {
          createdAtOnInsert: createdAt,
          initialAgentId: 'initial-agent',
          appendMessageIds: [messageId],
        });
        expect(saved).toMatchObject({
          conversationId,
          title: params.title,
          codeEnvironmentMode: 'without_attached',
          createdAt,
          chatProjectId: String(project._id),
          isTemporary: false,
          isArchived: archived,
          expiredAt: deadline,
        });
        expect(saved && '_id' in saved ? String(saved._id) : undefined).toBe(target.id);
        expect(saved).not.toHaveProperty('_managed');
        const raw = await db
          .model('Conversation')
          .collection.findOne(managedTargetFilter(db, target));
        expect(raw?.initial_agent_id).toBe('initial-agent');
        expect(raw?.messages.map(String)).toEqual([messageId]);
        expect(await settleResponseTarget(db, { userId }, undefined, entry)).toBe(true);
        expect(await settleResponseTarget(db, { userId }, conversationId, entry)).toBe(true);
        expect(
          await conversations.saveConvo({ userId }, { ...params, title: 'stale retry' }),
        ).toMatchObject({ title: params.title });
        const ordinary = createConversationMethods(db, messages);
        await ordinary.saveConvo(
          { userId, isTemporary: false },
          { conversationId, title: 'Edited' },
          {
            unsetFields: { expiredAt: 1, '_managed.phase': 1 },
          },
        );
        await ordinary.bulkSaveConvos([
          { conversationId, user: userId, title: 'Bulk edited', expiredAt: null },
        ]);
        expect(
          await db.model('Conversation').collection.findOne(managedTargetFilter(db, target)),
        ).toMatchObject({ expiredAt: deadline, _managed: { phase: 'published' } });
        await db.model('Conversation').collection.deleteOne(managedTargetFilter(db, target));
        expect(await conversations.saveConvo({ userId }, params)).toBeNull();
        await ordinary.bulkSaveConvos([{ conversationId, user: userId, title: 'Recreate' }]);
        await expect(
          ordinary.reserveSubagentThread({
            user: userId,
            conversationId,
            conversation: { title: 'Recreate' },
          }),
        ).rejects.toThrow('Unable to reserve');
        expect(await db.model('Conversation').collection.findOne({ conversationId })).toBeNull();
      },
    );

    it('preserves native reservation in the existing host subagent UUID namespace', async () => {
      const userId = randomUUID();
      const conversationId = '33333333-3333-8333-b333-333333333333';
      const methods = createConversationMethods(db, createMessageMethods(db));
      const reserved = await methods.reserveSubagentThread({
        user: userId,
        conversationId,
        conversation: { title: 'Native child thread' },
      });
      expect(reserved).toMatchObject({
        created: true,
        conversation: { conversationId, user: userId },
      });
      expect(
        await methods.reserveSubagentThread({
          user: userId,
          conversationId,
          conversation: { title: 'Retry' },
        }),
      ).toMatchObject({ created: false, conversation: { title: 'Native child thread' } });
    });

    it.each(['fast', 'provenance', 'apps', 'apps-erased-during-budget'] as const)(
      'publishes a registered target through the canonical %s Message writer',
      async (path) => {
        const userId = randomUUID();
        const conversationId = createManagedConversationId();
        const target = await allocateManagedTarget(db, 'message');
        const parentId = new db.Types.ObjectId().toHexString();
        const [ownerKey, conversationKey] = responseScopeKeys({ userId }, conversationId);
        const publication = {
          target,
          parentId,
          ownerKey,
          conversationKey,
          logicalId: createManagedMessageId(),
          receipt: createHash('sha256').update(randomUUID()).digest('hex'),
        };
        expect(await pinManagedTarget(db, target, parentId)).toBe(true);
        expect(await beginManagedTargetRegistration(db, target, parentId)).toBe(true);
        const entry = { key: publication.receipt, target, retentionEpoch: 0 };
        expect(await registerResponseTarget(db, { userId }, undefined, entry)).toMatchObject({
          status: 'registered',
        });
        expect(await registerResponseTarget(db, { userId }, conversationId, entry)).toMatchObject({
          status: 'registered',
        });
        expect(await markManagedTargetRegistered(db, publication)).toBe(true);
        const retainedDeadline = new Date(Date.now() + 60000);
        await db.model('Message').collection.updateOne(managedTargetFilter(db, target), {
          $set: { expiredAt: retainedDeadline },
        });
        expect(await markManagedTargetRegistered(db, publication)).toBe(true);
        expect(
          await markManagedTargetRegistered(db, {
            ...publication,
            logicalId: createManagedMessageId(),
          }),
        ).toBe(false);
        const methods = createMessageMethods(db, {
          managedPublication: publication,
          ...(path === 'apps-erased-during-budget' && {
            getMCPAppMessageBudget: async () => {
              await db.model('Message').collection.deleteOne(managedTargetFilter(db, target));
              return undefined;
            },
          }),
        });
        const createdAt = new Date('2026-01-01T00:00:00Z');
        const params = {
          messageId: publication.logicalId,
          conversationId,
          createdAt,
          text: 'confirmed canonical output',
          isCreatedByUser: false,
          ...(path === 'provenance' && { userSubmittedPaths: ['/text'] }),
          ...(path.startsWith('apps') && {
            attachments: [
              {
                type: Tools.ui_resources,
                file_id: 'app',
                toolCallId: 'call',
                [Tools.ui_resources]: [
                  {
                    uri: 'ui://app/test',
                    mimeType: MCP_APP_MIME_TYPE,
                    serverName: 'server',
                    serverBinding: 'authenticated',
                    resourceId: 'resource',
                    toolName: 'show_app',
                    content: [{ type: 'text', text: 'canonical tool result' }],
                    text: 'app document',
                  },
                ],
              },
            ],
          }),
        };
        const context = {
          userId,
          interfaceConfig: {
            retentionMode: RetentionMode.ALL,
            generalChatRetention: 2160,
          },
        };
        const saved = await methods.saveMessage(context, params);
        if (path === 'apps-erased-during-budget') {
          expect(saved).toBeNull();
          expect(
            await includeManagedAllocations(
              db.model('Message').exists(managedTargetFilter(db, target)),
            ),
          ).toBeNull();
          return;
        }
        expect(saved).toMatchObject({
          messageId: publication.logicalId,
          text: params.text,
          isTemporary: false,
          isUserSubmitted: false,
          createdAt,
        });
        expect(String(saved?._id)).toBe(target.id);
        expect(saved?.expiredAt).toBeInstanceOf(Date);
        expect(saved?.expiredAt).toEqual(retainedDeadline);
        expect(saved).not.toHaveProperty('_managed');
        expect(await settleResponseTarget(db, { userId }, undefined, entry)).toBe(true);
        expect(await settleResponseTarget(db, { userId }, conversationId, entry)).toBe(true);
        // Projection recovery cannot overwrite an already-published canonical row.
        expect(
          await methods.saveMessage(context, { ...params, text: 'stale retry' }),
        ).toMatchObject({ text: params.text });
        const ordinary = createMessageMethods(db);
        await ordinary.saveMessage({ userId, isTemporary: false }, { ...params, text: 'Edited' });
        await ordinary.updateMessage(userId, { messageId: params.messageId, expiredAt: null });
        await ordinary.bulkSaveMessages([
          { ...params, user: userId, expiredAt: null, text: 'Bulk edited' },
        ]);
        await expect(
          ordinary.updateMessage(userId, { messageId: params.messageId, user: 'other' }),
        ).rejects.toThrow('owner cannot be replaced');
        expect(
          await ordinary.saveMessage(
            { userId },
            {
              ...params,
              conversationId: createManagedConversationId(),
            },
          ),
        ).toBeNull();
        expect(
          await db.model('Message').collection.findOne(managedTargetFilter(db, target)),
        ).toMatchObject({ user: userId, conversationId, expiredAt: retainedDeadline });
        await db.model('Message').collection.deleteOne(managedTargetFilter(db, target));
        expect(await methods.saveMessage(context, params)).toBeNull();
        expect(await markManagedTargetRegistered(db, publication)).toBe(false);
      },
    );

    it('preserves edits of existing legacy rows in the newly reserved namespaces', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const userId = randomUUID();
      const conversationId = createManagedConversationId();
      const messageId = createManagedMessageId();
      await db
        .model('Conversation')
        .collection.insertOne({ conversationId, user: userId, title: 'Legacy' });
      await db
        .model('Message')
        .collection.insertOne({ conversationId, messageId, user: userId, text: 'Legacy' });
      expect(
        await conversations.saveConvo({ userId }, { conversationId, title: 'Edited' }),
      ).toMatchObject({ title: 'Edited' });
      expect(
        await messages.saveMessage({ userId }, { conversationId, messageId, text: 'Edited' }),
      ).toMatchObject({ text: 'Edited' });
      await conversations.bulkSaveConvos([{ conversationId, user: userId, title: 'Bulk edited' }]);
      expect(await db.model('Conversation').findOne({ conversationId })).toMatchObject({
        title: 'Bulk edited',
      });
    });

    it.each(['message', 'conversation'] as const)(
      'allocates unique payload-free %s rows',
      async (kind) => {
        const first = await allocateManagedTarget(db, kind);
        const second = await allocateManagedTarget(db, kind);
        expect(first.id).not.toBe(second.id);
        expect(first.incarnation).not.toBe(second.incarnation);
        const model = db.model(kind === 'message' ? 'Message' : 'Conversation');
        const row = await model.collection.findOne(managedTargetFilter(db, first));
        expect(row).toMatchObject({
          _managed: { phase: 'empty', incarnation: first.incarnation },
        });
        expect(row).not.toHaveProperty('user');
        expect(row).not.toHaveProperty('text');
        expect(row).not.toHaveProperty('content');
        expect(row).not.toHaveProperty('expiredAt');
        expect(await discardManagedAllocation(db, first)).toBe(true);
        expect(await discardManagedAllocation(db, second)).toBe(true);
      },
    );

    it('cannot pin a deleted target or recreate it through cleanup', async () => {
      const target = await allocateManagedTarget(db, 'message');
      expect(await discardManagedAllocation(db, target)).toBe(true);
      expect(await pinManagedTarget(db, target, new db.Types.ObjectId().toHexString())).toBe(false);
      expect(await discardManagedAllocation(db, target)).toBe(false);
      expect(
        await db.model('Message').collection.findOne(managedTargetFilter(db, target)),
      ).toBeNull();
    });

    it('pins to one parent, idempotently, and excludes the row from orphan cleanup', async () => {
      const target = await allocateManagedTarget(db, 'message');
      const parent = new db.Types.ObjectId().toHexString();
      const other = new db.Types.ObjectId().toHexString();
      const claims = await Promise.all([
        pinManagedTarget(db, target, parent),
        pinManagedTarget(db, target, other),
      ]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await pinManagedTarget(db, target, claims[0] ? parent : other)).toBe(true);
      expect(await discardManagedAllocation(db, target)).toBe(false);
    });

    mongoOnly('MongoDB command failpoints', () => {
      it('does not retry an allocation insert after a dropped connection', async () => {
        await db.connection.db!.admin().command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: { failCommands: ['insert'], closeConnection: true },
        });
        const commands: string[] = [];
        const client = db.connection.getClient();
        const onCommand = (event: { commandName: string }) => commands.push(event.commandName);
        client.on('commandStarted', onCommand);
        try {
          await expect(allocateManagedTarget(db, 'message')).rejects.toBeInstanceOf(
            db.mongo.MongoNetworkError,
          );
          expect(commands.filter((name) => name === 'insert')).toHaveLength(1);
        } finally {
          client.off('commandStarted', onCommand);
        }
        // A later invocation uses a new physical ID and remains available.
        await expect(allocateManagedTarget(db, 'message')).resolves.toMatchObject({
          kind: 'message',
        });
      });

      it('abandons an applied insert whose write-concern acknowledgment was lost', async () => {
        await db.connection.db!.admin().command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: {
            failCommands: ['insert'],
            writeConcernError: { code: 64, errmsg: 'test acknowledgment unavailable' },
          },
        });
        const before = await db.model('Message').collection.countDocuments();
        await expect(allocateManagedTarget(db, 'message')).rejects.toBeInstanceOf(
          db.mongo.MongoWriteConcernError,
        );
        expect(await db.model('Message').collection.countDocuments()).toBe(before + 1);
      });

      it('does not retry an allocation carrying a retryable-write server label', async () => {
        await db.connection.db!.admin().command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: { failCommands: ['insert'], errorCode: 91, errorLabels: ['RetryableWriteError'] },
        });
        const commands: string[] = [];
        const client = db.connection.getClient();
        const onCommand = (event: { commandName: string }) => commands.push(event.commandName);
        client.on('commandStarted', onCommand);
        try {
          await expect(allocateManagedTarget(db, 'message')).rejects.toMatchObject({ code: 91 });
          expect(commands.filter((name) => name === 'insert')).toHaveLength(1);
        } finally {
          client.off('commandStarted', onCommand);
        }
      });
    });

    it.each([false, true])(
      'does not recreate a managed message (provenance: %s)',
      async (provenance) => {
        const messages = createMessageMethods(db);
        const messageId = createManagedMessageId();
        const conversationId = createManagedConversationId();
        const params = {
          messageId,
          conversationId,
          text: 'confirmed output',
          ...(provenance && { userSubmittedPaths: ['/text'] }),
        };
        expect(await messages.saveMessage({ userId: 'owner' }, params)).toBeNull();
        const row = {
          ...params,
          user: 'owner',
          _managed: { incarnation: 'test', phase: 'published', receipt: 'receipt' },
        };
        await db.model('Message').collection.insertOne(row);
        expect(
          await messages.saveMessage({ userId: 'owner' }, { ...params, text: 'edited' }),
        ).toMatchObject({ text: 'edited' });
        await db.model('Message').collection.deleteOne({ messageId });
        expect(await messages.saveMessage({ userId: 'owner' }, params)).toBeNull();
        expect(
          await messages.saveMessage({ userId: 'owner' }, params, { insertOnly: true }),
        ).toBeUndefined();
        await messages.bulkSaveMessages([{ ...params, user: 'owner' }]);
        expect(await db.model('Message').collection.countDocuments({ messageId })).toBe(0);
      },
    );

    it('does not recreate a managed conversation through save, title, or archive', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const conversationId = createManagedConversationId();
      const context = { userId: 'owner' };
      expect(await conversations.saveConvo(context, { conversationId })).toBeNull();
      await db.model('Conversation').collection.insertOne({
        conversationId,
        user: 'owner',
        title: 'Original',
        _managed: { incarnation: 'test', phase: 'published', receipt: 'receipt' },
      });
      expect(
        await conversations.saveConvo(context, { conversationId, title: 'Renamed' }),
      ).toMatchObject({ title: 'Renamed' });
      await db.model('Conversation').collection.deleteOne({ conversationId });
      expect(
        await conversations.saveConvo(context, { conversationId, isArchived: true }),
      ).toBeNull();
      expect(
        await conversations.saveConvo(
          context,
          { conversationId, title: 'Generated' },
          {
            titleSource: 'generated',
          },
        ),
      ).toBeNull();
      expect(await db.model('Conversation').collection.countDocuments({ conversationId })).toBe(0);
    });

    it('strips forged internal fields from ordinary message, conversation and bulk saves', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const conversationId = '22222222-2222-4222-8222-222222222222';
      const forged = {
        _managed: { phase: 'registered', incarnation: 'forged' },
        '_managed.phase': 'published',
      };
      const messageId = `ordinary-${new db.Types.ObjectId()}`;
      await messages.saveMessage({ userId: 'owner' }, { ...forged, conversationId, messageId });
      const collection = db.model('Message').collection;
      expect(await collection.findOne({ messageId })).not.toHaveProperty('_managed');
      await messages.bulkSaveMessages([
        { ...forged, messageId: `${messageId}-bulk`, conversationId, user: 'owner' },
      ]);
      expect(await collection.findOne({ messageId: `${messageId}-bulk` })).not.toHaveProperty(
        '_managed',
      );
      await conversations.saveConvo({ userId: 'owner' }, { ...forged, conversationId });
      expect(
        await db.model('Conversation').collection.findOne({ conversationId }),
      ).not.toHaveProperty('_managed');
    });

    it('rejects allocation placeholders and moving into/out of managed identities', async () => {
      const messages = createMessageMethods(db);
      const conversations = createConversationMethods(db, messages);
      const conversationId = createManagedConversationId();
      await expect(
        messages.saveMessage(
          { userId: 'owner' },
          {
            conversationId,
            messageId: '__allocation_reserved',
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        messages.saveMessage(
          { userId: 'owner' },
          {
            conversationId,
            messageId: createManagedMessageId(),
            newMessageId: 'ordinary',
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        messages.saveMessage(
          { userId: 'owner' },
          {
            conversationId,
            messageId: 'ordinary',
            newMessageId: createManagedMessageId(),
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        conversations.saveConvo(
          { userId: 'owner' },
          {
            conversationId,
            newConversationId: 'ordinary',
          },
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        conversations.saveConvo(
          { userId: 'owner' },
          {
            conversationId: '__allocation_reserved',
          },
        ),
      ).rejects.toThrow(TypeError);
    });
  });

  it.each([
    { ok: 1, n: 0 },
    { ok: 1 },
    { ok: 0, n: 1 },
    { ok: 1, n: 1, writeErrors: [{ code: 11000 }] },
    { ok: 1, n: 1, writeErrors: null },
    { ok: 1, n: 1, writeErrors: '' },
    { ok: 1, n: 1, writeErrors: {} },
    { ok: 1, n: 1, writeConcernError: null },
    { ok: 1, n: 1, writeConcernError: { code: 64 } },
  ])('refuses a contradictory/malformed acknowledgment %j', async (reply) => {
    // Only command-response corruption is injected; real writes/faults are exercised above.
    const command = jest.spyOn(standalone.connection.db!, 'command').mockResolvedValueOnce(reply);
    await expect(allocateManagedTarget(standalone, 'message')).rejects.toBeInstanceOf(
      ManagedAllocationUnavailableError,
    );
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('applies the configured write concern to the raw command', async () => {
    const db = standalone.connection.db!;
    const command = jest.spyOn(db, 'command').mockResolvedValueOnce({ ok: 1, n: 1 });
    const concern = jest
      .spyOn(db, 'writeConcern', 'get')
      .mockReturnValue(new mongoose.mongo.WriteConcern('majority', 10000, true));
    await allocateManagedTarget(standalone, 'message');
    expect(command.mock.calls[0][0]).toHaveProperty('writeConcern', {
      w: 'majority',
      wtimeout: 10000,
      j: true,
    });
    concern.mockRestore();
  });

  it('rejects w:0 before sending an insert', async () => {
    const db = standalone.connection.db!;
    jest.spyOn(db, 'writeConcern', 'get').mockReturnValue(new mongoose.mongo.WriteConcern(0));
    const command = jest.spyOn(db, 'command');
    await expect(allocateManagedTarget(standalone, 'message')).rejects.toBeInstanceOf(
      ManagedAllocationUnavailableError,
    );
    expect(command).not.toHaveBeenCalled();
  });

  it('checks tenant context before bypassing Mongoose for allocation', async () => {
    const command = jest.spyOn(standalone.connection.db!, 'command');
    await expect(allocateManagedTarget(standalone, 'message', 'other')).rejects.toThrow(TypeError);
    await expect(runAsSystem(() => allocateManagedTarget(standalone, 'message'))).rejects.toThrow(
      TypeError,
    );
    await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
      await expect(allocateManagedTarget(standalone, 'message', 'tenant-b')).rejects.toThrow(
        TypeError,
      );
      await expect(allocateManagedTarget(standalone, 'message')).rejects.toThrow(TypeError);
      expect(command).not.toHaveBeenCalled();
      const target = await allocateManagedTarget(standalone, 'message', 'tenant-a');
      expect(
        await standalone
          .model('Message')
          .collection.findOne(managedTargetFilter(standalone, target)),
      ).toHaveProperty('tenantId', 'tenant-a');
    });
  });

  it('rejects forged model names and target identity before issuing writes', async () => {
    const command = jest.spyOn(standalone.connection.db!, 'command');
    await expect(
      allocateManagedTarget(standalone, 'toString' as ManagedTarget['kind']),
    ).rejects.toThrow(TypeError);
    const target = { kind: 'message', id: 'bad', incarnation: 'bad' } as ManagedTarget;
    expect(() => managedTargetFilter(standalone, target)).toThrow(TypeError);
    expect(command).not.toHaveBeenCalled();
  });
});

describe('managed allocation visibility', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryServer;
  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await db.connect(mongo.getUri());
    const schema = new mongoose.Schema({ name: String });
    applyManagedStorage(schema);
    applyManagedStorage(schema);
    db.model('Visibility', schema);
    await db.model('Visibility').collection.insertMany([
      { name: 'legacy' },
      { name: 'published', _managed: { phase: 'published', incarnation: 'published' } },
      ...['empty', 'pinned', 'registering', 'registered', 'retired'].map((phase) => ({
        name: phase,
        _managed: { phase, incarnation: phase },
      })),
    ]);
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });

  it('excludes metadata rows from reads, counts, distinct and aggregates', async () => {
    const model = db.model('Visibility');
    expect((await model.find()).map((row) => row.name)).toEqual(['legacy', 'published']);
    expect(await model.findOne({ name: 'empty' })).toBeNull();
    expect(await model.countDocuments()).toBe(2);
    expect(await model.distinct('name')).toEqual(['legacy', 'published']);
    expect(await model.aggregate([{ $count: 'count' }])).toEqual([{ count: 2 }]);
    expect(await model.findOne({ name: 'published' }).lean()).not.toHaveProperty('_managed');
  });

  it('allows only internally marked queries to inspect allocations', async () => {
    const model = db.model('Visibility');
    expect(await includeManagedAllocations(model.countDocuments())).toBe(7);
    expect(await includeManagedAllocations(model.aggregate([{ $count: 'count' }]))).toEqual([
      { count: 7 },
    ]);
    expect(await model.countDocuments().setOptions({ includeManagedAllocations: true })).toBe(2);
  });
});
