import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import type { ConnectOptions } from 'mongoose';
import { createAgentTriggerDeliveryMethods } from '~/methods/triggerDelivery';
import { createConversationMethods } from '~/methods/conversation';
import { createMessageMethods } from '~/methods/message';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Amazon DocumentDB live adjudication of the surface added between 2026-07-29
 * (when #14495 cleared the last known pipeline-form updates) and 2026-08-30.
 *
 * A static audit against AWS's supported-APIs tables predicts six rejections.
 * Those tables are omission-based, so only a real cluster settles it. Every
 * probe drives the PRODUCTION method rather than a re-implementation, so the
 * suite cannot drift from the shapes the server actually emits.
 *
 * Query shapes are parsed before they are matched, so the no-fixture probes
 * still adjudicate: an engine that accepts the shape returns an empty result,
 * one that rejects it throws.
 *
 * Run (from packages/data-schemas, against a DEDICATED database):
 *   DOCUMENTDB_URI="mongodb://user:pass@127.0.0.1:27017/librechat_audit\
 *     ?tls=true&retryWrites=false&authSource=admin&authMechanism=SCRAM-SHA-1&directConnection=true" \
 *   DOCUMENTDB_TLS_CA_FILE="global-bundle.pem" \
 *   DOCUMENTDB_TLS_ALLOW_INVALID_HOSTNAMES=true \
 *     npx jest --config misc/documentdb/jest.documentdb.config.mjs audit
 *
 * Every URI parameter above is load-bearing when reaching a cluster through an
 * SSH tunnel, and each was established against a real cluster:
 *   - authSource=admin           the user lives in admin; a database in the path
 *                                otherwise becomes the auth source and login fails
 *   - authMechanism=SCRAM-SHA-1  DocumentDB rejects SCRAM-SHA-256 ("Unsupported
 *                                mechanism [ -301 ]")
 *   - directConnection=true      replica-set discovery returns internal cluster
 *                                hostnames that are unreachable through a tunnel
 *   - tlsAllowInvalidHostnames   the tunnel endpoint never matches the cert
 * Set DOCUMENTDB_STRICT=true to turn a rejected production shape into a failure.
 */
const DOCUMENTDB_URI = process.env.DOCUMENTDB_URI ?? '';
const STRICT = process.env.DOCUMENTDB_STRICT === 'true';
const describeLive = DOCUMENTDB_URI ? describe : describe.skip;

const runId = randomUUID().slice(0, 8);
const ACCEPTED = 'accepted';
const verdicts: Record<string, string> = {};

function getDb() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB database handle not available');
  }
  return db;
}

/** Records whether the engine parsed the shape. Never throws: a rejection is
 * the finding, not a harness failure. */
async function probe(label: string, run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    verdicts[label] = ACCEPTED;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    verdicts[label] = `REJECTED - ${message.replace(/\s+/g, ' ').slice(0, 140)}`;
  }
  return verdicts[label];
}

function expectShape(label: string): void {
  expect(verdicts[label]).toBeDefined();
  if (STRICT) {
    expect(verdicts[label]).toBe(ACCEPTED);
  }
}

describeLive('Amazon DocumentDB - 2026-08-30 audit surface', () => {
  let triggerMethods: ReturnType<typeof createAgentTriggerDeliveryMethods>;
  let messageMethods: ReturnType<typeof createMessageMethods>;
  let probeCollection: string;

  const userId = new mongoose.Types.ObjectId();
  const conversationId = `audit-convo-${runId}`;
  const messageId = `audit-message-${runId}`;
  const deliveryKey = `audit-delivery-${runId}`;
  const sourceId = `audit-source-${runId}`;

  beforeAll(async () => {
    const options: ConnectOptions = { autoIndex: false, autoCreate: false };
    if (process.env.DOCUMENTDB_TLS_CA_FILE) {
      options.tlsCAFile = process.env.DOCUMENTDB_TLS_CA_FILE;
    }
    if (process.env.DOCUMENTDB_TLS_ALLOW_INVALID_HOSTNAMES === 'true') {
      options.tlsAllowInvalidHostnames = true;
    }
    await mongoose.connect(DOCUMENTDB_URI, options);

    Object.assign(mongoose.models, createModels(mongoose));
    triggerMethods = createAgentTriggerDeliveryMethods(mongoose);
    messageMethods = createMessageMethods(mongoose);

    probeCollection = `audit_probe_${runId}`;
    await getDb()
      .collection(probeCollection)
      .insertOne({
        probe: 1,
        label: 'audit',
        note: 'construct probe row',
        values: [1, 2, 3],
      });
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 1) {
      return;
    }
    await getDb()
      .collection(probeCollection)
      .drop()
      .catch(() => undefined);
    await mongoose.models.Message.deleteMany({ conversationId }).catch(() => undefined);
    await mongoose.models.AgentTriggerDelivery.deleteMany({ deliveryKey }).catch(() => undefined);
    await mongoose.models.AgentTriggerLaneSequence.deleteMany({
      orderingKey: { $regex: runId },
    }).catch(() => undefined);

    const width = Math.max(...Object.keys(verdicts).map((key) => key.length));
    const rows = Object.entries(verdicts).map(
      ([label, verdict]) => `  ${label.padEnd(width)}  ${verdict}`,
    );
    console.log(`\nDocumentDB audit verdicts (run ${runId}):\n${rows.join('\n')}\n`);
    await mongoose.disconnect();
  });

  it('reports the engine build so the verdicts are attributable', async () => {
    const info = await getDb().admin().command({ buildInfo: 1 });
    const version = typeof info.version === 'string' ? info.version : 'unknown';
    verdicts['engine version'] = version;
    expect(version).toBeTruthy();
  });

  describe('raw construct probes (isolates which primitive the engine refuses)', () => {
    it('probes the mixed include and exclude projection', async () => {
      /** `{ _id: 1, other: 0 }` is what Mongoose compiles `'_id +field'` to on
       * a schema with hidden siblings. MongoDB tolerates it via the `_id`
       * exception; DocumentDB rejects it, which broke the legacy actor-receipt
       * sweep on every maintenance pass. */
      const verdict = await probe('mixed projection { _id: 1, x: 0 }', () =>
        getDb()
          .collection(probeCollection)
          .find({ probe: 1 }, { projection: { _id: 1, note: 0 } })
          .toArray(),
      );
      expect(verdict).toBeTruthy();
    });

    it('probes the pipeline-update form', async () => {
      const verdict = await probe('pipeline-form findOneAndUpdate', () =>
        getDb()
          .collection(probeCollection)
          .findOneAndUpdate({ probe: 1 }, [{ $set: { touched: true } }]),
      );
      expect(verdict).toBeTruthy();
    });

    it('probes $$REMOVE, documented unsupported on every engine', async () => {
      const verdict = await probe('$$REMOVE in $project', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([
            { $project: { kept: '$label', dropped: { $cond: [false, '$note', '$$REMOVE'] } } },
          ])
          .toArray(),
      );
      expect(verdict).toBeTruthy();
    });

    it('probes $facet, documented unsupported on every engine', async () => {
      const verdict = await probe('$facet stage', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([{ $facet: { rows: [{ $project: { label: 1 } }] } }])
          .toArray(),
      );
      expect(verdict).toBeTruthy();
    });

    it('probes the operators the subagent projections rely on', async () => {
      await probe('$regexMatch', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([
            { $addFields: { matched: { $regexMatch: { input: '$label', regex: 'audit' } } } },
          ])
          .toArray(),
      );
      await probe('$switch', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([
            {
              $addFields: {
                branch: { $switch: { branches: [{ case: true, then: 'a' }], default: 'b' } },
              },
            },
          ])
          .toArray(),
      );
      await probe('$let', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([{ $addFields: { bound: { $let: { vars: { one: 1 }, in: '$$one' } } } }])
          .toArray(),
      );
      await probe('$convert', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([
            {
              $addFields: {
                text: { $convert: { input: '$label', to: 'string', onError: '', onNull: '' } },
              },
            },
          ])
          .toArray(),
      );
      await probe('$strLenBytes + $substrCP', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([
            {
              $addFields: {
                size: { $strLenBytes: '$label' },
                head: { $substrCP: ['$label', 0, 2] },
              },
            },
          ])
          .toArray(),
      );
      await probe('$mergeObjects + $map', () =>
        getDb()
          .collection(probeCollection)
          .aggregate([
            {
              $addFields: {
                merged: {
                  $map: {
                    input: '$values',
                    as: 'value',
                    in: { $mergeObjects: [{ v: '$$value' }, { seen: true }] },
                  },
                },
              },
            },
          ])
          .toArray(),
      );
      for (const label of [
        '$regexMatch',
        '$switch',
        '$let',
        '$convert',
        '$strLenBytes + $substrCP',
        '$mergeObjects + $map',
      ]) {
        expect(verdicts[label]).toBeTruthy();
      }
    });

    it('probes the classic-operator replacements the fix would use', async () => {
      await probe('$max update operator', () =>
        getDb()
          .collection(probeCollection)
          .updateOne({ probe: 1 }, { $max: { leaseUntil: new Date() } }),
      );
      await probe('$set + $unset classic update', () =>
        getDb()
          .collection(probeCollection)
          .updateOne({ probe: 1 }, { $set: { claimed: true }, $unset: { dropped: 1 } }),
      );
      expectShape('$max update operator');
      expectShape('$set + $unset classic update');
    });
  });

  describe('production shapes (drives the real methods)', () => {
    it('site 1 - claimNextAgentTriggerDelivery', async () => {
      await probe('enqueueAgentTriggerDelivery', () =>
        triggerMethods.enqueueAgentTriggerDelivery({
          deliveryKey,
          fingerprint: `audit-fingerprint-${runId}`,
          orderingKey: `audit-ordering-${runId}`,
          envelope: { version: 1, audit: runId },
          user: userId,
          availableAt: new Date(),
        }),
      );
      const now = new Date();
      await probe('claimNextAgentTriggerDelivery', () =>
        triggerMethods.claimNextAgentTriggerDelivery({
          workerId: `audit-worker-${runId}`,
          claimToken: randomUUID(),
          now,
          leaseUntil: new Date(now.getTime() + 60_000),
        }),
      );
      expectShape('claimNextAgentTriggerDelivery');
    });

    it('site 2 - renewAgentTriggerDeliveryProducerLease', async () => {
      await probe('renewAgentTriggerDeliveryProducerLease', () =>
        triggerMethods.renewAgentTriggerDeliveryProducerLease({
          deliveryKey,
          sourceId,
          leaseUntil: new Date(Date.now() + 60_000),
        }),
      );
      expectShape('renewAgentTriggerDeliveryProducerLease');
    });

    it('site 3 - claimBackgroundToolResults', async () => {
      /** This method returns `not_found`/`not_ready` before it ever builds the
       * update, so an unseeded probe would report a false `accepted`. Seed a
       * terminal, wakeup-eligible, unclaimed task so the claim path is reached. */
      await mongoose.models.Message.create({
        messageId,
        conversationId,
        user: String(userId),
        isCreatedByUser: false,
        content: [
          {
            type: 'tool_call',
            tool_call: {
              backgroundTask: {
                taskId: `audit-task-${runId}`,
                status: 'completed',
                completionWakeup: true,
              },
            },
          },
        ],
      });
      await probe('claimBackgroundToolResults', () =>
        messageMethods.claimBackgroundToolResults({
          userId: String(userId),
          conversationId,
          messageId,
          taskId: `audit-task-${runId}`,
          kind: 'wakeup',
          claimId: randomUUID(),
        }),
      );
      expectShape('claimBackgroundToolResults');
    });

    it('site 4 - releaseBackgroundToolResultClaims', async () => {
      await probe('releaseBackgroundToolResultClaims', () =>
        messageMethods.releaseBackgroundToolResultClaims({
          userId: String(userId),
          conversationId,
          messageId,
          taskIds: [`audit-task-${runId}`],
          kind: 'wakeup',
          claimId: randomUUID(),
        }),
      );
      expectShape('releaseBackgroundToolResultClaims');
    });

    it('site 5 - getMessagesForSubagentThreadView ($$REMOVE path)', async () => {
      await probe('getMessagesForSubagentThreadView (list)', () =>
        messageMethods.getMessagesForSubagentThreadView({
          user: String(userId),
          conversationId,
          limit: 10,
          textCodePointLimit: 512,
        }),
      );
      expectShape('getMessagesForSubagentThreadView (list)');
    });

    it('site 6 - getMessagesForSubagentThreadView ($facet path)', async () => {
      await probe('getMessagesForSubagentThreadView (selected)', () =>
        messageMethods.getMessagesForSubagentThreadView({
          user: String(userId),
          conversationId,
          selectedTaskId: `audit-task-${runId}`,
          limit: 10,
          textCodePointLimit: 512,
        }),
      );
      expectShape('getMessagesForSubagentThreadView (selected)');
    });

    it('listSubagentTasksForThreads ($regexMatch path)', async () => {
      await probe('listSubagentTasksForThreads', () =>
        messageMethods.listSubagentTasksForThreads({
          user: String(userId),
          conversationIds: [conversationId],
          limitPerThread: 4,
        }),
      );
      expectShape('listSubagentTasksForThreads');
    });

    it('site 8 - expireLegacyAgentEventActorReceipts', async () => {
      const verdict = await probe('expireLegacyAgentEventActorReceipts', () =>
        createConversationMethods(mongoose).expireLegacyAgentEventActorReceipts(new Date(), 5),
      );
      expectShape('expireLegacyAgentEventActorReceipts');
      expect(verdict).toBeTruthy();
    });

    it('site 7 - updateToolCallResult', async () => {
      const settleMessageId = `audit-settle-${runId}`;
      await mongoose.models.Message.create({
        messageId: settleMessageId,
        conversationId,
        user: String(userId),
        isCreatedByUser: false,
        content: [
          {
            type: 'tool_call',
            tool_call: { id: `audit-call-${runId}`, name: 'execute_code', output: 'pending' },
          },
        ],
        attachments: [{ file_id: `audit-file-${runId}`, toolCallId: `audit-call-${runId}` }],
      });
      await probe('updateToolCallResult', () =>
        messageMethods.updateToolCallResult({
          userId: String(userId),
          messageId: settleMessageId,
          conversationId,
          toolCallId: `audit-call-${runId}`,
          output: 'settled output',
          markBackgrounded: true,
          backgroundTask: {
            taskId: `audit-task-${runId}`,
            toolName: 'execute_code',
            status: 'completed',
            settledAt: new Date(),
            resultClaim: { kind: 'wakeup', claimId: `audit-claim-${runId}`, claimedAt: new Date() },
          },
          attachments: [{ file_id: `audit-file-${runId}`, toolCallId: `audit-call-${runId}` }],
        }),
      );
      expectShape('updateToolCallResult');
    });
  });
});
