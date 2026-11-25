import { normalizeServerName } from 'librechat-data-provider';
import type { Connection, Types } from 'mongoose';
import { buildIndexWithRetry } from '~/utils/retry';

interface MCPServerNameRow {
  _id: Types.ObjectId;
  serverName?: string;
  normalizedServerName?: string;
  tenantId?: string;
}

const MIGRATION_BATCH_SIZE = 500;
const AUTHORITATIVE_FIND_OPTIONS = {
  projection: { _id: 1, serverName: 1, normalizedServerName: 1, tenantId: 1 },
  readPreference: 'primary' as const,
  readConcern: { level: 'majority' as const },
};

export interface MCPServerNameMigrationResult {
  scanned: number;
  updated: number;
}

export class MCPServerNameMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPServerNameMigrationError';
  }
}

function normalizedIdentity(server: MCPServerNameRow): {
  serverName: string;
  normalizedServerName: string;
} {
  if (typeof server.serverName !== 'string' || !server.serverName.trim()) {
    throw new MCPServerNameMigrationError('MCP server name index contains a malformed name');
  }
  if (server.tenantId !== undefined && typeof server.tenantId !== 'string') {
    throw new MCPServerNameMigrationError('MCP server name index contains a malformed tenant');
  }
  const normalizedServerName = normalizeServerName(server.serverName);
  if (!normalizedServerName) {
    throw new MCPServerNameMigrationError('MCP server name index contains an empty identity');
  }
  return { serverName: server.serverName, normalizedServerName };
}

/** Backfills the compact normalized-name index required before authority proofs are enabled. */
export async function backfillMCPServerNormalizedNames(
  connection: Connection,
): Promise<MCPServerNameMigrationResult> {
  const collection = connection.db!.collection<MCPServerNameRow>('mcpservers');
  const identities = new Map<string, { id: string; serverName: string }>();
  let scanned = 0;
  let updated = 0;

  for await (const server of collection.find({}, AUTHORITATIVE_FIND_OPTIONS)) {
    scanned++;
    const { serverName, normalizedServerName } = normalizedIdentity(server);
    const identity = JSON.stringify([server.tenantId ?? null, normalizedServerName]);
    const existing = identities.get(identity);
    if (existing && existing.id !== server._id.toHexString()) {
      throw new MCPServerNameMigrationError(
        `MCP server names normalize to the same identity in one tenant: "${existing.serverName}" and "${serverName}"`,
      );
    }
    identities.set(identity, { id: server._id.toHexString(), serverName });
    if (server.normalizedServerName !== normalizedServerName) {
      updated++;
    }
  }

  let updates: Array<{
    updateOne: {
      filter: { _id: Types.ObjectId };
      update: { $set: { normalizedServerName: string } };
    };
  }> = [];

  for await (const server of collection.find({}, AUTHORITATIVE_FIND_OPTIONS)) {
    const { normalizedServerName } = normalizedIdentity(server);
    if (server.normalizedServerName !== normalizedServerName) {
      updates.push({
        updateOne: {
          filter: { _id: server._id },
          update: { $set: { normalizedServerName } },
        },
      });
    }
    if (updates.length === MIGRATION_BATCH_SIZE) {
      // eslint-disable-next-line no-restricted-syntax -- offline all-tenant migration intentionally bypasses request tenant scoping
      await collection.bulkWrite(updates, { ordered: true });
      updates = [];
    }
  }
  if (updates.length) {
    // eslint-disable-next-line no-restricted-syntax -- offline all-tenant migration intentionally bypasses request tenant scoping
    await collection.bulkWrite(updates, { ordered: true });
  }
  await buildIndexWithRetry(
    () =>
      collection.createIndex(
        { normalizedServerName: 1, tenantId: 1 },
        {
          name: 'normalizedServerName_1_tenantId_1',
          unique: true,
          partialFilterExpression: { normalizedServerName: { $exists: true } },
        },
      ),
    'createIndex(normalizedServerName_1_tenantId_1)',
  );
  return { scanned, updated };
}
