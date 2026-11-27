import type { Connection } from 'mongoose';
import { buildIndexWithRetry } from '~/utils/retry';

/**
 * Replace only the MCP reservation constraint. All writers must already persist
 * tenantId and honor tenantless tombstones. Builds before dropping, so current
 * writers may stay online. Never attributes or deletes legacy reservations.
 */
export async function migrateMCPReservationIndex(
  connection: Connection,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<{ compoundIndex: boolean; legacyIndex: boolean }> {
  const collection = connection.db!.collection('mcpnames');
  let indexes: Awaited<ReturnType<typeof collection.indexes>>;
  try {
    indexes = await collection.indexes();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 26) {
      throw error;
    }
    indexes = [];
  }
  if (
    indexes.some(
      (index) =>
        index.unique &&
        Object.keys(index.key).length === 1 &&
        index.key.name === 1 &&
        index.name !== 'name_1',
    )
  ) {
    throw new Error('Unexpected global MCP reservation index; inspect before migrating');
  }
  const legacy = indexes.find((index) => index.name === 'name_1');
  if (legacy && (Object.keys(legacy.key).length !== 1 || legacy.key.name !== 1 || !legacy.unique)) {
    throw new Error('Unexpected mcpnames.name_1 definition; inspect before migrating');
  }
  const compound = indexes.find((index) => index.name === 'name_1_tenantId_1');
  if (dryRun) {
    return { compoundIndex: Boolean(compound?.unique), legacyIndex: Boolean(legacy) };
  }

  await buildIndexWithRetry(
    () =>
      collection.createIndex({ name: 1, tenantId: 1 }, { unique: true, name: 'name_1_tenantId_1' }),
    'createIndex(mcpnames.name_1_tenantId_1)',
  );
  const replacement = (await collection.indexes()).find(
    (index) => index.name === 'name_1_tenantId_1',
  );
  if (
    !replacement?.unique ||
    Object.keys(replacement.key).length !== 2 ||
    replacement.key.name !== 1 ||
    replacement.key.tenantId !== 1 ||
    replacement.sparse ||
    replacement.partialFilterExpression
  ) {
    throw new Error('MCP reservation replacement constraint was not verified');
  }
  if (legacy) {
    try {
      await buildIndexWithRetry(() => collection.dropIndex('name_1'), 'dropIndex(mcpnames.name_1)');
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 27) {
        throw error;
      }
    }
  }
  const finalIndexes = await collection.indexes();
  if (finalIndexes.some((index) => index.name === 'name_1')) {
    throw new Error('Legacy MCP reservation index is still present');
  }
  return { compoundIndex: true, legacyIndex: false };
}
