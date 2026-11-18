import type { Connection } from 'mongoose';

/**
 * Copies the former agent flag into the official-status field without removing it.
 * Keeping the old field allows an operator to roll back without losing marked agents.
 */
export async function migrateLegacyAgentOfficialStatus(
  connection: Connection,
): Promise<number> {
  const result = await connection.db!.collection('agents').updateMany(
    { is_certified: true, is_official: { $ne: true } },
    { $set: { is_official: true } },
  );
  return result.modifiedCount;
}
