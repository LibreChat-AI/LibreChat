import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ResponseTargetIntent, ResponseTargetResult } from './projection';
import type { ResponseTerminalReceipt } from '~/models/response';
import type { ManagedPublication } from '~/types/managed';
import {
  publishResponseTarget,
  createResponseTurnPublisher,
  selectResponseTarget,
  beginResponseTargetRegistration,
  acknowledgeResponseTarget,
  responseTargetRegistrationKey,
  retireResponseTarget,
  sweepResponseTargetOrphans,
} from './projection';
import {
  markManagedTargetRegistered,
  managedTargetFilter,
  sweepManagedAllocations,
} from './managed';
import { createManagedMessageId, createManagedConversationId } from '~/utils/managed';
import { registerResponseTarget, settleResponseTarget } from './registration';
import { createResponseRetention, responseScopeKeys } from './responseScope';
import { createResponseScopeModel } from '~/models/responseScope';
import { createStoredResponseModel } from '~/models/response';
import { includeManagedAllocations } from '~/utils/managed';
import { createConversationMethods } from './conversation';
import { createConversationModel } from '~/models/convo';
import { tenantStorage } from '~/config/tenantContext';
import { createMessageModel } from '~/models/message';
import { responseReceiptKey } from '~/utils/receipt';
import { createResponseStorage } from './response';
import { createMessageMethods } from './message';

function required(result: ResponseTargetResult) {
  if (!result.ok) throw new Error(`Fixture target unavailable: ${result.code}`);
  return result;
}

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, entered, resumed };
}

describe('Response-owned canonical target selection', () => {
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
      MongoMemoryServer.create({ instance: { args: ['--setParameter', 'ttlMonitorSleepSecs=1'] } }),
      MongoMemoryReplSet.create({
        replSet: { count: 1, args: ['--setParameter', 'ttlMonitorSleepSecs=1'] },
      }),
    ]);
    await Promise.all([
      standalone.connect(mongo.getUri(), { monitorCommands: true }),
      replica.connect(repl.getUri(), {
        monitorCommands: true,
        readPreference: 'secondaryPreferred',
      }),
    ]);
    if (ferret)
      await ferret.connect(process.env.FERRETDB_URI!, {
        dbName: `projection_${randomUUID().replace(/-/g, '')}`,
        monitorCommands: true,
      });
    for (const [, db] of engines) {
      for (const model of [
        createStoredResponseModel(db),
        createMessageModel(db),
        createConversationModel(db),
      ]) {
        await model.init();
        // These models share schema objects across isolated Mongoose instances.
        await model.createIndexes();
      }
    }
  }, 60000);
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(engines.map(([, db]) => db.disconnect()));
    await Promise.all([mongo?.stop(), repl?.stop()]);
  });

  describe.each(engines)('%s', (_name, db) => {
    async function fixture(kind: 'message' | 'conversation' = 'message', tenantId?: string) {
      const userId = randomUUID();
      const conversationId = createManagedConversationId();
      const responseId = createManagedMessageId();
      const fingerprint = randomUUID();
      const receipt: ResponseTerminalReceipt = {
        generationCreatedAt: 17,
        providerExecutionId: 'provider-generation',
        status: 'completed',
        responseJSON: '{"output":"confirmed"}',
        turnJSON: JSON.stringify({ version: 1, inputs: [{ messageId: createManagedMessageId() }] }),
      };
      const storage = createResponseStorage(db);
      const reserved = await storage.reserve({
        userId,
        tenantId,
        conversationId,
        responseId,
        fingerprint,
        agentId: 'agent',
        requestJSON: '{}',
        requestKey: randomUUID(),
        parentMessageId: 'parent',
      });
      if (!reserved.ok) throw new Error('Fixture reservation failed');
      const execution = {
        generationCreatedAt: 17,
        providerExecutionId: receipt.providerExecutionId,
      };
      const enrolled = await storage.enrollExecution(reserved.record, execution, '{}');
      if (!enrolled.ok || !(await storage.bindExecution(enrolled.record, execution)))
        throw new Error('Fixture provider binding failed');
      if (kind === 'message')
        await createStoredResponseModel(db).updateOne(
          {
            _id: reserved.record.storageTarget!.id,
          },
          {
            $set: {
              status: 'materializing',
              pendingTerminal: receipt,
              terminalReceiptKey: responseReceiptKey(receipt),
            },
          },
        );
      const root = await createStoredResponseModel(db)
        .findById(reserved.record.storageTarget!.id)
        .select('+providerExecution');
      if (!root) throw new Error('Fixture root unavailable');
      const common = {
        userId,
        tenantId,
        conversationId,
        responseId,
        fingerprint,
        parentId: String(root._id),
        logicalId: kind === 'message' ? responseId : conversationId,
      };
      const intent: ResponseTargetIntent =
        kind === 'message'
          ? { ...common, kind, receipt }
          : {
              ...common,
              kind,
              execution: {
                generationCreatedAt: 17,
                providerExecutionId: receipt.providerExecutionId,
              },
            };
      return { intent, root, receipt };
    }

    async function readTargets(intent: ResponseTargetIntent) {
      return createStoredResponseModel(db)
        .findById(intent.parentId)
        .select('+canonicalTargets')
        .lean();
    }

    it.each(['message', 'conversation'] as const)(
      'publishes and recovers a %s through the shared protocol using the canonical writer',
      async (kind) => {
        const { intent } = await fixture(kind);
        let first = true;
        const write = async (publication: ManagedPublication, expiredAt?: Date) => {
          const context = { userId: intent.userId, expiredAt };
          const messages = createMessageMethods(db, { managedPublication: publication });
          const saved =
            kind === 'message'
              ? await messages.saveMessage(context, {
                  messageId: intent.logicalId,
                  conversationId: intent.conversationId,
                  text: 'confirmed canonical payload',
                  isCreatedByUser: false,
                })
              : await createConversationMethods(db, {
                  managedPublication: publication,
                  getMessages: createMessageMethods(db).getMessages,
                  deleteMessages: createMessageMethods(db).deleteMessages,
                }).saveConvo(
                  context,
                  {
                    conversationId: intent.conversationId,
                    endpoint: 'agents',
                    agent_id: 'agent',
                    title: 'Canonical conversation',
                  },
                  { initialAgentId: 'agent', appendMessageIds: [] },
                );
          if (first) {
            first = false;
            throw new Error('Canonical publication reply lost');
          }
          return saved;
        };
        await expect(publishResponseTarget(db, intent, write)).rejects.toThrow('reply lost');
        const recovered = await publishResponseTarget(db, intent, write);
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) throw new Error('Expected recovered publication');
        const replay = await publishResponseTarget(db, intent, write);
        if (!replay.ok) throw new Error('Expected publication replay');
        expect(replay.publication.target).toEqual(recovered.publication.target);
        const model = db.model(kind === 'message' ? 'Message' : 'Conversation');
        expect(await model.countDocuments({ user: intent.userId })).toBe(1);
        expect((await readTargets(intent))?.canonicalTargets).toMatchObject([
          { phase: 'published', target: recovered.publication.target },
        ]);
        const anchors = await createResponseScopeModel(db)
          .find({
            _id: { $in: [recovered.publication.ownerKey, recovered.publication.conversationKey] },
          })
          .lean();
        expect(anchors).toHaveLength(2);
        expect(anchors.every((anchor) => anchor.pendingCount === 0)).toBe(true);
      },
    );
    it('keeps every per-Message Root query metadata-only and binds a publisher to its immutable receipt', async () => {
      const { intent, receipt, root } = await fixture();
      const publisher = createResponseTurnPublisher(db, root.toObject(), receipt);
      const originalResponseJSON = receipt.responseJSON;
      const originalTurnJSON = receipt.turnJSON!;
      // Mutation of a caller's object cannot change the private capability's authority.
      receipt.responseJSON = 'changed after publisher creation';
      const commands: string[] = [];
      const client = db.connection.getClient();
      const monitor = (event: { command: Record<string, unknown> }) => {
        if (
          event.command.aggregate === 'storedresponses' ||
          event.command.find === 'storedresponses' ||
          event.command.findAndModify === 'storedresponses' ||
          event.command.update === 'storedresponses'
        )
          commands.push(JSON.stringify(event.command));
      };
      client.on('commandStarted', monitor);
      try {
        const result = await publisher(intent.logicalId, (publication) =>
          createMessageMethods(db, { managedPublication: publication }).saveMessage(
            { userId: intent.userId },
            {
              messageId: intent.logicalId,
              conversationId: intent.conversationId,
              text: 'confirmed',
            },
          ),
        );
        expect(result.ok).toBe(true);
        expect(commands.length).toBeGreaterThan(0);
        expect(
          commands.every(
            (command) =>
              !command.includes(JSON.stringify(originalResponseJSON)) &&
              !command.includes(JSON.stringify(originalTurnJSON)),
          ),
        ).toBe(true);
        expect(commands.every((command) => !command.includes('"pendingTerminal":1'))).toBe(true);
        expect(commands.some((command) => command.includes('terminalReceiptKey'))).toBe(true);
      } finally {
        client.off('commandStarted', monitor);
      }
    });
    it('keeps discovery until a replay adopts retention shortened during canonical publication', async () => {
      const { intent } = await fixture();
      const deadline = new Date(Date.now() + 60_000);
      let first = true;
      const write = async (publication: ManagedPublication, expiredAt?: Date) => {
        if (first) {
          first = false;
          await createResponseRetention(db)(intent, intent.conversationId, deadline);
        }
        return createMessageMethods(db, { managedPublication: publication }).saveMessage(
          { userId: intent.userId, expiredAt },
          { messageId: intent.logicalId, conversationId: intent.conversationId, text: 'confirmed' },
        );
      };
      expect(await publishResponseTarget(db, intent, write)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect(
        (
          await createResponseScopeModel(db).findById(
            responseScopeKeys(intent, intent.conversationId)[1],
          )
        )?.pendingCount,
      ).toBeGreaterThan(0);
      const recovered = await publishResponseTarget(db, intent, write);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw new Error('Expected recovered publication');
      expect(
        await createMessageModel(db).findOne({ messageId: intent.logicalId }).lean(),
      ).toMatchObject({
        expiredAt: deadline,
      });
      const anchors = await createResponseScopeModel(db)
        .find({
          _id: { $in: [recovered.publication.ownerKey, recovered.publication.conversationKey] },
        })
        .lean();
      expect(anchors.every((anchor) => anchor.pendingCount === 0)).toBe(true);
    });
    it('cannot recreate a registered target deleted before the canonical payload lands', async () => {
      const { intent } = await fixture();
      const model = createMessageModel(db);
      const write = async (publication: ManagedPublication) => {
        await model.deleteOne(managedTargetFilter(db, publication.target));
        return createMessageMethods(db, { managedPublication: publication }).saveMessage(
          { userId: intent.userId },
          { messageId: intent.logicalId, conversationId: intent.conversationId, text: 'late' },
        );
      };
      expect(await publishResponseTarget(db, intent, write)).toEqual({
        ok: false,
        code: 'target_retired',
      });
      const selected = (await readTargets(intent))!.canonicalTargets![0].target;
      const allocate = jest.spyOn(db.connection.db!, 'command');
      expect(await publishResponseTarget(db, intent, write)).toEqual({
        ok: false,
        code: 'target_retired',
      });
      expect(allocate).not.toHaveBeenCalled();
      expect(await model.collection.countDocuments({ user: intent.userId })).toBe(0);
      expect((await readTargets(intent))!.canonicalTargets).toMatchObject([
        { phase: 'retired', target: selected },
      ]);
    });
    it('cannot call a canonical writer while its terminal turn is still unconfirmed', async () => {
      const { intent, receipt } = await fixture();
      await createStoredResponseModel(db).updateOne(
        { _id: intent.parentId },
        {
          $set: { preparedTerminal: receipt },
          $unset: { pendingTerminal: 1 },
        },
      );
      const write = jest.fn();
      expect(await publishResponseTarget(db, intent, write)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect(write).not.toHaveBeenCalled();
    });
    it('selects a single physical winner across competing publishers', async () => {
      const { intent } = await fixture();
      const command = db.connection.db!.command.bind(db.connection.db!);
      const gate = barrier();
      let allocations = 0;
      jest.spyOn(db.connection.db!, 'command').mockImplementation(async (...args) => {
        if (args[0].insert === createMessageModel(db).collection.name) {
          allocations++;
          if (allocations === 2) gate.release();
          await gate.resumed;
        }
        return command(...args);
      });
      const attempts = await Promise.all([
        selectResponseTarget(db, intent),
        selectResponseTarget(db, intent),
      ]);
      expect(attempts.filter((candidate) => candidate.ok)).toHaveLength(1);
      const winner = required(attempts.find((candidate) => candidate.ok)!);
      const retry = required(await selectResponseTarget(db, intent));
      expect(retry.selection.target).toEqual(winner.selection.target);
      expect((await readTargets(intent))?.canonicalTargets).toHaveLength(1);
    });

    it('pins a returned selection against both orphan sweep paths', async () => {
      const { intent } = await fixture();
      const selected = required(await selectResponseTarget(db, intent));
      expect(await sweepManagedAllocations(db, 'message', { limit: 100 })).toMatchObject({
        deleted: 0,
      });
      expect(await sweepResponseTargetOrphans(db, 'message', { limit: 100 })).toMatchObject({
        deleted: 0,
      });
      expect((await beginResponseTargetRegistration(db, intent, selected.selection)).ok).toBe(true);
    });

    it('returns conflict if cleanup wins before pinning, then recovers with a fresh selection', async () => {
      const { intent } = await fixture();
      const collection = createStoredResponseModel(db).collection;
      const update = collection.updateOne.bind(collection);
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        const result = await update(...args);
        await sweepManagedAllocations(db, 'message', { limit: 100 });
        return result;
      });
      expect(await selectResponseTarget(db, intent)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      const recovered = required(await selectResponseTarget(db, intent));
      expect((await beginResponseTargetRegistration(db, intent, recovered.selection)).ok).toBe(
        true,
      );
    });

    it('freezes before authority admission and publishes through the actual canonical writer', async () => {
      const { intent } = await fixture();
      const selected = required(await selectResponseTarget(db, intent));
      const started = required(
        await beginResponseTargetRegistration(db, intent, selected.selection),
      );
      expect((await readTargets(intent))?.canonicalTargets?.[0].phase).toBe('registering');
      const entry = {
        key: responseTargetRegistrationKey(started.publication),
        target: started.selection.target,
        retentionEpoch: 0,
      };
      expect(await registerResponseTarget(db, intent, undefined, entry)).toMatchObject({
        status: 'registered',
      });
      expect(await registerResponseTarget(db, intent, intent.conversationId, entry)).toMatchObject({
        status: 'registered',
      });
      expect(await markManagedTargetRegistered(db, started.publication)).toBe(true);
      const registered = required(
        await acknowledgeResponseTarget(db, intent, started.selection, 'registered'),
      );
      expect(registered.selection.phase).toBe('registered');
      const methods = createMessageMethods(db, { managedPublication: started.publication });
      expect(
        await methods.saveMessage(
          { userId: intent.userId },
          {
            messageId: intent.logicalId,
            conversationId: intent.conversationId,
            text: 'confirmed output',
            isCreatedByUser: false,
          },
        ),
      ).toMatchObject({ text: 'confirmed output' });
      expect(
        required(await acknowledgeResponseTarget(db, intent, registered.selection, 'published'))
          .selection.phase,
      ).toBe('published');
      expect(await settleResponseTarget(db, intent, undefined, entry)).toBe(true);
      expect(await settleResponseTarget(db, intent, intent.conversationId, entry)).toBe(true);
    });

    it('replaces a missing selection before registration, without letting the old publisher start', async () => {
      const { intent } = await fixture();
      const first = required(await selectResponseTarget(db, intent));
      await db
        .model('Message')
        .collection.deleteOne(managedTargetFilter(db, first.selection.target));
      const second = required(await selectResponseTarget(db, intent));
      expect(second.selection.target.id).not.toBe(first.selection.target.id);
      expect(await beginResponseTargetRegistration(db, intent, first.selection)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect(
        required(await beginResponseTargetRegistration(db, intent, second.selection)).selection
          .phase,
      ).toBe('registering');
    });

    it('cannot register an old pinned selection after a replacement wins the parent CAS', async () => {
      const { intent } = await fixture();
      const first = required(await selectResponseTarget(db, intent));
      const pause = barrier();
      const collection = createStoredResponseModel(db).collection;
      const original = collection.updateOne.bind(collection);
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        pause.enter();
        await pause.resumed;
        return original(...args);
      });
      const oldPublisher = beginResponseTargetRegistration(db, intent, first.selection);
      try {
        await pause.entered;
        await db
          .model('Message')
          .collection.deleteOne(managedTargetFilter(db, first.selection.target));
        const replacement = required(await selectResponseTarget(db, intent));
        expect(replacement.selection.target.id).not.toBe(first.selection.target.id);
        pause.release();
        expect(await oldPublisher).toEqual({ ok: false, code: 'response_conflict' });
        expect(
          required(await beginResponseTargetRegistration(db, intent, replacement.selection))
            .selection.phase,
        ).toBe('registering');
      } finally {
        pause.release();
        await oldPublisher;
      }
    });

    it('does not replace a target after the old publisher freezes selection first', async () => {
      const { intent } = await fixture();
      const first = required(await selectResponseTarget(db, intent));
      const freeze = barrier();
      const replacement = barrier();
      const collection = createStoredResponseModel(db).collection;
      const update = collection.updateOne.bind(collection);
      const findUpdate = collection.updateOne.bind(collection);
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        freeze.enter();
        await freeze.resumed;
        return update(...args);
      });
      const oldPublisher = beginResponseTargetRegistration(db, intent, first.selection);
      let newPublisher: Promise<ResponseTargetResult> | undefined;
      try {
        await freeze.entered;
        await db
          .model('Message')
          .collection.deleteOne(managedTargetFilter(db, first.selection.target));
        jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
          replacement.enter();
          await replacement.resumed;
          return findUpdate(...args);
        });
        newPublisher = selectResponseTarget(db, intent);
        await replacement.entered;
        freeze.release();
        expect(await oldPublisher).toEqual({ ok: false, code: 'target_retired' });
        replacement.release();
        expect(await newPublisher).toEqual({ ok: false, code: 'response_conflict' });
        expect(await selectResponseTarget(db, intent)).toEqual({
          ok: false,
          code: 'target_retired',
        });
      } finally {
        freeze.release();
        replacement.release();
        await oldPublisher;
        await newPublisher;
      }
    });

    it('recovers an acknowledged selection whose parent CAS reply was lost', async () => {
      const { intent } = await fixture();
      const collection = createStoredResponseModel(db).collection;
      const update = collection.updateOne.bind(collection);
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        await update(...args);
        throw new db.mongo.MongoNetworkError('test selection reply lost');
      });
      await expect(selectResponseTarget(db, intent)).rejects.toBeInstanceOf(
        db.mongo.MongoNetworkError,
      );
      const captured = (await readTargets(intent))?.canonicalTargets?.[0];
      const recovered = required(await selectResponseTarget(db, intent));
      expect(recovered.selection.target).toEqual(captured?.target);
    });

    it('recovers a frozen selection whose freeze reply was lost', async () => {
      const { intent } = await fixture();
      const first = required(await selectResponseTarget(db, intent));
      const collection = createStoredResponseModel(db).collection;
      const update = collection.updateOne.bind(collection);
      jest.spyOn(collection, 'updateOne').mockImplementationOnce(async (...args) => {
        await update(...args);
        throw new db.mongo.MongoNetworkError('test freeze reply lost');
      });
      await expect(
        beginResponseTargetRegistration(db, intent, first.selection),
      ).rejects.toBeInstanceOf(db.mongo.MongoNetworkError);
      expect((await readTargets(intent))?.canonicalTargets?.[0].phase).toBe('registering');
      const recovered = required(await selectResponseTarget(db, intent));
      expect(recovered.selection.target).toEqual(first.selection.target);
      expect(
        required(await beginResponseTargetRegistration(db, intent, recovered.selection)).selection
          .phase,
      ).toBe('registering');
    });

    it('retires a missing target after a successful registration with a lost reply', async () => {
      const { intent } = await fixture();
      const first = required(await selectResponseTarget(db, intent));
      const started = required(await beginResponseTargetRegistration(db, intent, first.selection));
      const entry = {
        key: responseTargetRegistrationKey(started.publication),
        target: started.selection.target,
        retentionEpoch: 0,
      };
      const collection = createResponseScopeModel(db).collection;
      const update = collection.findOneAndUpdate.bind(collection);
      jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
        await update(...args);
        throw new db.mongo.MongoNetworkError('test registration reply lost');
      });
      await expect(registerResponseTarget(db, intent, undefined, entry)).rejects.toBeInstanceOf(
        db.mongo.MongoNetworkError,
      );
      await db
        .model('Message')
        .collection.deleteOne(managedTargetFilter(db, first.selection.target));
      const commands: string[] = [];
      const client = db.connection.getClient();
      const monitor = (event: { commandName: string }) => commands.push(event.commandName);
      client.on('commandStarted', monitor);
      try {
        expect(await selectResponseTarget(db, intent)).toEqual({
          ok: false,
          code: 'target_retired',
        });
        expect(commands.filter((name) => name === 'insert')).toHaveLength(0);
        expect((await readTargets(intent))?.canonicalTargets?.[0].phase).toBe('retired');
      } finally {
        client.off('commandStarted', monitor);
      }
    });

    it('rejects prepared-only or changed-generation terminal candidates before allocation', async () => {
      const { intent, receipt } = await fixture();
      await createStoredResponseModel(db).updateOne(
        { _id: intent.parentId },
        {
          $set: { preparedTerminal: receipt },
          $unset: { pendingTerminal: '' },
        },
      );
      expect(await selectResponseTarget(db, intent)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      await createStoredResponseModel(db).updateOne(
        { _id: intent.parentId },
        {
          $set: { pendingTerminal: receipt, generationCreatedAt: 18 },
        },
      );
      expect(await selectResponseTarget(db, intent)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
      expect((await readTargets(intent))?.canonicalTargets).toBeUndefined();
    });

    it('binds Conversation selection to one active provider and cannot adopt a replacement parent', async () => {
      const { intent, root } = await fixture('conversation');
      const first = required(await selectResponseTarget(db, intent));
      expect(first.selection.target.kind).toBe('conversation');
      await retireResponseTarget(db, intent, first.selection);
      const revision = (await readTargets(intent))?.revision;
      await retireResponseTarget(db, intent, first.selection);
      expect((await readTargets(intent))?.revision).toBe(revision);
      expect(await selectResponseTarget(db, intent)).toEqual({ ok: false, code: 'target_retired' });
      await createStoredResponseModel(db).deleteOne({ _id: root._id });
      const { _id: _oldId, createdAt: _created, updatedAt: _updated, ...copy } = root.toObject();
      await createStoredResponseModel(db).create(copy);
      expect(await selectResponseTarget(db, intent)).toEqual({
        ok: false,
        code: 'response_conflict',
      });
    });

    const mongoTTL = db === ferret ? describe.skip : describe;
    mongoTTL('MongoDB TTL monitor', () => {
      it('never reallocates a registered target removed by the actual TTL index', async () => {
        expect(
          await db.connection.db!.admin().command({ getParameter: 1, ttlMonitorSleepSecs: 1 }),
        ).toMatchObject({ ttlMonitorSleepSecs: 1 });
        expect(await db.model('Message').collection.indexes()).toContainEqual(
          expect.objectContaining({ key: { expiredAt: 1 }, expireAfterSeconds: 0 }),
        );
        const { intent } = await fixture();
        const chosen = required(await selectResponseTarget(db, intent));
        const started = required(
          await beginResponseTargetRegistration(db, intent, chosen.selection),
        );
        const entry = {
          key: responseTargetRegistrationKey(started.publication),
          target: started.selection.target,
          retentionEpoch: 0,
        };
        await registerResponseTarget(db, intent, undefined, entry);
        await db.model('Message').collection.updateOne(managedTargetFilter(db, entry.target), {
          $set: { expiredAt: new Date(Date.now() - 60000) },
        });
        const deadline = Date.now() + 20000;
        const exists = () =>
          includeManagedAllocations(
            db.model('Message').exists(managedTargetFilter(db, entry.target)),
          ).read('primary');
        while (await exists()) {
          if (Date.now() >= deadline)
            throw new Error('Fixture TTL monitor did not remove the target');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(await selectResponseTarget(db, intent)).toEqual({
          ok: false,
          code: 'target_retired',
        });
        expect(await exists()).toBeNull();
      }, 30000);
    });

    it('rejects IDs not declared by the confirmed turn before allocating', async () => {
      const { intent } = await fixture();
      await expect(
        selectResponseTarget(db, { ...intent, logicalId: createManagedMessageId() }),
      ).rejects.toThrow('Invalid Response target intent');
      expect((await readTargets(intent))?.canonicalTargets).toBeUndefined();
    });

    it.each(['managed', 'ordinary'] as const)(
      'requires immutable %s input IDs to obey the durable namespace contract',
      async (kind) => {
        const { intent, receipt } = await fixture();
        const messageId = kind === 'managed' ? createManagedMessageId() : randomUUID();
        const terminal = {
          ...receipt,
          turnJSON: JSON.stringify({ version: 1, inputs: [{ messageId }] }),
        };
        await createStoredResponseModel(db).updateOne(
          { _id: intent.parentId },
          { $set: { pendingTerminal: terminal, terminalReceiptKey: responseReceiptKey(terminal) } },
        );
        const input: ResponseTargetIntent = {
          ...intent,
          kind: 'message',
          receipt: terminal,
          logicalId: messageId,
        };
        if (kind === 'managed') expect((await selectResponseTarget(db, input)).ok).toBe(true);
        else {
          const allocator = jest.spyOn(db.connection.db!, 'command');
          await expect(selectResponseTarget(db, input)).rejects.toThrow(
            'Invalid Response target intent',
          );
          expect(allocator).not.toHaveBeenCalled();
          expect((await readTargets(intent))?.canonicalTargets).toBeUndefined();
        }
      },
    );

    it('reaps pinned orphan pages by parent identity and preserves live selections', async () => {
      const tenantId = randomUUID();
      await tenantStorage.run({ tenantId }, async () => {
        const lost = await fixture('message', tenantId);
        const retired = await fixture('message', tenantId);
        const live = await fixture('message', tenantId);
        const selections = [];
        for (const f of [lost, retired, live]) {
          const chosen = required(await selectResponseTarget(db, f.intent));
          selections.push(
            required(await beginResponseTargetRegistration(db, f.intent, chosen.selection)),
          );
        }
        await createStoredResponseModel(db).deleteOne({ _id: lost.intent.parentId });
        await createStoredResponseModel(db).updateOne(
          { _id: retired.intent.parentId },
          {
            $set: { 'canonicalTargets.0.phase': 'retired' },
          },
        );
        const first = await sweepResponseTargetOrphans(db, 'message', { tenantId, limit: 1 });
        expect(first).toMatchObject({ deleted: 1, next: expect.any(String) });
        const second = await sweepResponseTargetOrphans(db, 'message', {
          tenantId,
          limit: 2,
          after: first.next,
        });
        expect(second).toEqual({ deleted: 1 });
        const target = selections[2].selection.target;
        expect(
          await includeManagedAllocations(
            db.model('Message').exists(managedTargetFilter(db, target)),
          ),
        ).not.toBeNull();
        expect(
          required(await beginResponseTargetRegistration(db, live.intent, selections[2].selection))
            .selection.target,
        ).toEqual(target);
      });
    });

    it('uses distinct registration keys for multiple messages sharing one terminal receipt', async () => {
      const { intent } = await fixture();
      const first = required(await selectResponseTarget(db, intent));
      const second = required(
        await selectResponseTarget(db, {
          ...intent,
          logicalId: JSON.parse(intent.kind === 'message' ? intent.receipt.turnJSON! : '{}')
            .inputs[0].messageId,
        }),
      );
      expect(responseTargetRegistrationKey(first.publication)).not.toBe(
        responseTargetRegistrationKey(second.publication),
      );
    });
  });
});
