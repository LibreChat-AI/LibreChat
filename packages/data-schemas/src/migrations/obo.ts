import type { Model } from 'mongoose';
import type { IToken } from '~/types';
import { indexGrantClients, classifyScheduledGrant } from '~/utils/grants';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';

type GrantRecord = Pick<IToken, 'userId' | 'tenantId'> & {
  identifier: string;
  metadata?: Record<string, unknown>;
};

export interface ScheduledOboInventory {
  scanned: number;
  tagged: number;
  provable: number;
  ordinary: number;
  ambiguous: number;
  modified: number;
  ready: boolean;
}

const projection = {
  _id: 0,
  userId: 1,
  tenantId: 1,
  identifier: 1,
  'metadata.credential_set_id': 1,
  'metadata.credential_purpose': 1,
  'metadata.openid_subject': 1,
  'metadata.openid_issuer': 1,
};
const recordKey = (record: GrantRecord): string =>
  JSON.stringify([record.tenantId ?? null, String(record.userId), record.identifier]);

/** Run before legacy client TTL expiry, with legacy writers quiesced. Never reads ciphertext. */
export async function migrateScheduledOboGrantProvenance(
  Token: Model<IToken>,
  options: { apply?: boolean; batchSize?: number } = {},
): Promise<ScheduledOboInventory> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error('Invalid scheduled OBO migration batch size');

  const scan = async (apply: boolean): Promise<ScheduledOboInventory> => {
    const result: ScheduledOboInventory = {
      scanned: 0,
      tagged: 0,
      provable: 0,
      ordinary: 0,
      ambiguous: 0,
      modified: 0,
      ready: false,
    };
    const processBatch = async (records: GrantRecord[]): Promise<void> => {
      const clients = await Token.find(
        {
          type: 'mcp_oauth_client',
          $or: records.map((record) => ({
            userId: record.userId,
            tenantId: record.tenantId ?? null,
            identifier: record.identifier.replace(/:refresh$/, ':client'),
          })),
        },
        projection,
      ).lean<GrantRecord[]>();
      const byKey = indexGrantClients(clients, recordKey);
      const provable: GrantRecord[] = [];
      for (const record of records) {
        result.scanned++;
        const client = byKey.get(
          recordKey({ ...record, identifier: record.identifier.replace(/:refresh$/, ':client') }),
        );
        const state = classifyScheduledGrant(
          record.metadata,
          client === null ? null : client?.metadata,
        );
        result[state]++;
        if (state === 'provable') provable.push(record);
      }
      if (!apply || !provable.length) return;
      const written = await tenantSafeBulkWrite(
        Token,
        provable.map((record) => ({
          updateOne: {
            filter: {
              userId: record.userId,
              tenantId: record.tenantId ?? null,
              type: 'mcp_oauth_refresh',
              identifier: record.identifier,
              'metadata.credential_set_id': record.metadata!.credential_set_id,
              'metadata.credential_purpose': { $ne: 'scheduled_obo' },
            },
            update: { $set: { 'metadata.credential_purpose': 'scheduled_obo' } },
          },
        })),
      );
      result.modified += written.modifiedCount;
    };
    const cursor = Token.find(
      {
        type: 'mcp_oauth_refresh',
        identifier: /^mcp:schedule-obo:/,
      },
      projection,
    )
      .lean<GrantRecord[]>()
      .cursor({ batchSize });
    let batch: GrantRecord[] = [];
    try {
      for await (const record of cursor) {
        batch.push(record);
        if (batch.length === batchSize) {
          await processBatch(batch);
          batch = [];
        }
      }
      if (batch.length) await processBatch(batch);
    } finally {
      await cursor.close();
    }
    result.ready = result.ambiguous === 0 && result.provable === 0;
    return result;
  };

  const inventory = await scan(false);
  if (!options.apply || inventory.ambiguous > 0 || inventory.ready) return inventory;
  const applied = await scan(true);
  const verified = await scan(false);
  return { ...verified, modified: applied.modified };
}
