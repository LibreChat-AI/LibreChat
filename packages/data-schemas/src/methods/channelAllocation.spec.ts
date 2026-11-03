import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { ManagedTargetKind, ManagedTarget } from '~/types/managed';
import {
  allocateManagedTarget,
  discardManagedAllocation,
  listManagedAllocations,
  managedTargetModels,
  managedTargetPredicate,
} from './managed';
import { includeManagedAllocations, ALLOCATION_PREFIX } from '~/utils/managed';
import { tenantStorage } from '~/config/tenantContext';
import { createModels } from '~/models';

const kinds = [
  'channel',
  'channelIdentity',
  'channelRun',
  'channelLane',
  'channelKey',
  'channelReply',
  'channelFeedback',
  'channelFeedbackEvent',
] as const satisfies readonly ManagedTargetKind[];
const underscore = new Set<ManagedTargetKind>([
  'channelIdentity',
  'channelRun',
  'channelLane',
  'channelReply',
  'channelFeedback',
  'channelFeedbackEvent',
]);
const engines = ['standalone', 'replica', ...(process.env.FERRETDB_URI ? ['FerretDB'] : [])];

describe.each(engines)('channel allocation on %s', (engine) => {
  let server: MongoMemoryServer | MongoMemoryReplSet | undefined;
  beforeAll(async () => {
    if (engine === 'replica') server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    else if (engine === 'standalone') server = await MongoMemoryServer.create();
    createModels(mongoose);
    await mongoose.connect(server?.getUri() ?? process.env.FERRETDB_URI!, {
      dbName: `channel_allocation_${randomUUID().replace(/-/g, '')}`,
      monitorCommands: true,
    });
  }, 60000);
  beforeEach(async () => {
    await mongoose.connection.db!.dropDatabase();
    for (const kind of kinds) await mongoose.model(managedTargetModels[kind]).createIndexes();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  });

  describe.each([undefined, 'channel-tenant'])('logical tenant %s', (tenantId) => {
    it.each(kinds)(
      'allocates distinct hidden %s records across every unique index',
      async (kind) => {
        await tenantStorage.run({ tenantId }, async () => {
          const model = mongoose.model(managedTargetModels[kind]);
          let inserts = 0;
          const client = mongoose.connection.getClient();
          const observe = (command: mongoose.mongo.CommandStartedEvent) => {
            if (
              command.commandName === 'insert' &&
              command.command.insert === model.collection.name
            )
              inserts++;
          };
          client.on('commandStarted', observe);
          let first: ManagedTarget<(typeof kinds)[number]>;
          let second: ManagedTarget<(typeof kinds)[number]>;
          try {
            first = await allocateManagedTarget(mongoose, kind, tenantId);
            second = await allocateManagedTarget(mongoose, kind, tenantId);
          } finally {
            client.off('commandStarted', observe);
          }
          expect(inserts).toBe(2);
          expect(first.id).not.toBe(second.id);
          expect(first.incarnation).not.toBe(second.incarnation);
          expect(first.tenantId).toBe(tenantId);
          expect(await model.countDocuments({})).toBe(0);
          const listed = await listManagedAllocations(mongoose, kind, { tenantId, limit: 2 }, [
            'empty',
          ]);
          expect(new Set(listed.allocations.map(({ target }) => target.id))).toEqual(
            new Set([first.id, second.id]),
          );
          const stored = await model.collection.findOne(managedTargetPredicate(mongoose, first));
          expect(stored).not.toBeNull();
          expect(stored!.tenantId).toBe(tenantId ?? (underscore.has(kind) ? '_' : undefined));
          expect(stored!._managed).toEqual({ phase: 'empty', incarnation: first.incarnation });
          for (const field of [
            'user',
            'userId',
            'principal',
            'text',
            'requestJSON',
            'encryptedApiKey',
            'encryptedBotToken',
          ])
            expect(stored).not.toHaveProperty(field);
          if (kind === 'channelIdentity') {
            expect(stored!.identity).toEqual({
              channelId: expect.stringMatching(`^${ALLOCATION_PREFIX}`),
              teamId: expect.stringMatching(`^${ALLOCATION_PREFIX}`),
              externalUserId: expect.stringMatching(`^${ALLOCATION_PREFIX}`),
            });
          }
          expect(await discardManagedAllocation(mongoose, first)).toBe(true);
          expect(
            await includeManagedAllocations(model.exists(managedTargetPredicate(mongoose, first))),
          ).toBeNull();
          expect(
            await includeManagedAllocations(model.exists(managedTargetPredicate(mongoose, second))),
          ).not.toBeNull();
        });
      },
    );
  });
});
