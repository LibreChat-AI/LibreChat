import { nanoid } from 'nanoid';
import { ResourceType, PermissionBits, normalizeServerName } from 'librechat-data-provider';
import type { Model, RootFilterQuery, Types } from 'mongoose';
import type { MCPOptions } from 'librechat-data-provider';
import type { MCPServerDocument } from '../types';
import { permissionBitSupersets } from './aclEntry';
import logger from '~/config/winston';

const NORMALIZED_LIMIT_DEFAULT = 20;
const MAX_CREATE_RETRIES = 5;
const RETRY_BASE_DELAY_MS = 25;

/**
 * Helper to check if an error is a MongoDB duplicate key error.
 * Both MCPServer unique indexes represent raw or normalized server-name collisions,
 * so retrying name allocation is safe for either E11000 source.
 */
function isDuplicateKeyError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const mongoError = error as { code: number };
    return mongoError.code === 11000;
  }
  return false;
}

/**
 * Escapes special regex characters in a string so they are treated literally.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a URL-friendly server name from a title.
 * Converts to lowercase, replaces spaces with hyphens, removes special characters.
 */
function generateServerNameFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars except spaces and hyphens
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Remove consecutive hyphens
    .replace(/^-|-$/g, ''); // Trim leading/trailing hyphens

  return slug || 'mcp-server'; // Fallback if empty
}

export interface MCPServerDeps {
  /** Returns resource IDs solely owned by the given user. From createAclEntryMethods. */
  getSoleOwnedResourceIds: (
    userObjectId: Types.ObjectId,
    resourceTypes: string | string[],
  ) => Promise<Types.ObjectId[]>;
}

/** An MCP server removed with its owner's account. */
export interface MCPServerViewerEntry {
  principalType: string;
  principalId?: string;
}

export interface ErasableMCPServer {
  id: string;
  serverName: string;
}

export function createMCPServerMethods(
  mongoose: typeof import('mongoose'),
  deps: MCPServerDeps,
): {
  createMCPServer: (data: {
    config: MCPOptions;
    author: string | Types.ObjectId;
    reservedServerNames?: Iterable<string>;
  }) => Promise<MCPServerDocument>;
  findMCPServerByServerName: (serverName: string) => Promise<MCPServerDocument | null>;
  findMCPServerByObjectId: (_id: string | Types.ObjectId) => Promise<MCPServerDocument | null>;
  getListMCPServersByIds: ({
    ids,
    otherParams,
    limit,
    after,
  }: {
    ids?: Types.ObjectId[];
    otherParams?: RootFilterQuery<MCPServerDocument>;
    limit?: number | null;
    after?: string | null;
  }) => Promise<{
    data: MCPServerDocument[];
    has_more: boolean;
    after: string | null;
  }>;
  getListMCPServersByNames: ({ names }: { names: string[] }) => Promise<{
    data: MCPServerDocument[];
  }>;
  updateMCPServer: (
    serverName: string,
    updateData: { config?: MCPOptions },
  ) => Promise<MCPServerDocument | null>;
  deleteMCPServer: (serverName: string) => Promise<MCPServerDocument | null>;
  findUserErasableMCPServers: (userId: string) => Promise<ErasableMCPServer[]>;
  deleteMCPServersWithAcl: (ids: string[]) => Promise<number>;
  findMCPServerOAuthTokenUserIds: (serverName: string, tenantId?: string) => Promise<string[]>;
  findMCPServerViewerEntries: (serverId: string) => Promise<MCPServerViewerEntry[]>;
} {
  /**
   * Finds the next available server name by checking DB and reserved-name collisions.
   * If baseName is taken or reserved, returns baseName-2, baseName-3, etc.
   */
  async function findNextAvailableServerName(
    baseName: string,
    reservedServerNames: Set<string> = new Set(),
  ): Promise<string> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;

    // Find all servers with matching base name pattern (baseName or baseName-N)
    const escapedBaseName = escapeRegex(baseName);
    const matchingNamePattern = new RegExp(`^${escapedBaseName}(-\\d+)?$`);
    const existing = await MCPServer.find({
      serverName: { $regex: matchingNamePattern },
    })
      .select('serverName')
      .lean<Array<{ serverName: string }>>();

    const existingNames = new Set([
      ...existing.map((server) => server.serverName),
      ...Array.from(reservedServerNames).filter((serverName) =>
        matchingNamePattern.test(serverName),
      ),
    ]);

    if (existingNames.size === 0) {
      return baseName;
    }

    // Extract numbers from existing names
    const numbers = Array.from(existingNames).map((serverName) => {
      const match = serverName.match(/-(\d+)$/);
      return match ? parseInt(match[1], 10) : 1;
    });

    const maxNumber = Math.max(...numbers);
    return `${baseName}-${maxNumber + 1}`;
  }

  /**
   * Create a new MCP server with retry logic for handling race conditions.
   * When multiple requests try to create servers with the same title simultaneously,
   * they may get the same serverName from findNextAvailableServerName() before any
   * creates the record (TOCTOU race condition). This is handled by retrying with
   * exponential backoff when a duplicate key error occurs.
   * @param data - Object containing config (with title, description, url, etc.) and author
   * @returns The created MCP server document
   */
  async function createMCPServer(data: {
    config: MCPOptions;
    author: string | Types.ObjectId;
    reservedServerNames?: Iterable<string>;
  }): Promise<MCPServerDocument> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    let lastError: unknown;
    const reservedServerNames = new Set(data.reservedServerNames ?? []);

    for (let attempt = 0; attempt < MAX_CREATE_RETRIES; attempt++) {
      try {
        // Generate serverName from title, with fallback to nanoid if no title
        // Important: regenerate on each attempt to get fresh available name
        let serverName: string;
        if (data.config.title) {
          const baseSlug = generateServerNameFromTitle(data.config.title);
          serverName = await findNextAvailableServerName(baseSlug, reservedServerNames);
        } else {
          serverName = `mcp-${nanoid(16)}`;
        }

        const newServer = await MCPServer.create({
          serverName,
          normalizedServerName: normalizeServerName(serverName),
          config: data.config,
          author: data.author,
        });

        return newServer.toObject() as MCPServerDocument;
      } catch (error) {
        lastError = error;

        // Only retry on duplicate key errors (serverName collision)
        if (isDuplicateKeyError(error) && attempt < MAX_CREATE_RETRIES - 1) {
          // Exponential backoff: 10ms, 20ms, 40ms
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
          logger.debug(
            `[createMCPServer] Duplicate serverName detected, retrying (attempt ${attempt + 2}/${MAX_CREATE_RETRIES}) after ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Not a duplicate key error or out of retries - throw immediately
        throw error;
      }
    }

    // Should not reach here, but TypeScript requires a return
    throw lastError;
  }

  /**
   * Find an MCP server by serverName
   * @param serverName - The unique server name identifier
   * @returns The MCP server document or null
   */
  async function findMCPServerByServerName(serverName: string): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findOne({ serverName }).lean<MCPServerDocument>();
  }

  /**
   * Find an MCP server by MongoDB ObjectId
   * @param _id - The MongoDB ObjectId
   * @returns The MCP server document or null
   */
  async function findMCPServerByObjectId(
    _id: string | Types.ObjectId,
  ): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findById(_id).lean<MCPServerDocument>();
  }

  /**
   * Get a paginated list of MCP servers by IDs with filtering and search
   * @param ids - Array of ObjectIds to include
   * @param otherParams - Additional filter parameters (e.g., search)
   * @param limit - Page size limit (null for no pagination)
   * @param after - Cursor for pagination
   * @returns Paginated list of MCP servers
   */
  async function getListMCPServersByIds({
    ids = [],
    otherParams = {},
    limit = null,
    after = null,
  }: {
    ids?: Types.ObjectId[];
    otherParams?: RootFilterQuery<MCPServerDocument>;
    limit?: number | null;
    after?: string | null;
  }): Promise<{
    data: MCPServerDocument[];
    has_more: boolean;
    after: string | null;
  }> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    const isPaginated = limit !== null && limit !== undefined;
    const normalizedLimit = isPaginated
      ? Math.min(Math.max(1, parseInt(String(limit)) || NORMALIZED_LIMIT_DEFAULT), 100)
      : null;

    // Build base query combining accessible servers with other filters
    const baseQuery: RootFilterQuery<MCPServerDocument> = { ...otherParams, _id: { $in: ids } };

    // Add cursor condition
    if (after) {
      try {
        const cursor = JSON.parse(Buffer.from(after, 'base64').toString('utf8'));
        const { updatedAt, _id } = cursor;

        const cursorCondition = {
          $or: [
            { updatedAt: { $lt: new Date(updatedAt) } },
            { updatedAt: new Date(updatedAt), _id: { $gt: new mongoose.Types.ObjectId(_id) } },
          ],
        };

        // Merge cursor condition with base query
        if (Object.keys(baseQuery).length > 0) {
          baseQuery.$and = [{ ...baseQuery }, cursorCondition];
          // Remove the original conditions from baseQuery to avoid duplication
          Object.keys(baseQuery).forEach((key) => {
            if (key !== '$and') {
              delete baseQuery[key];
            }
          });
        }
      } catch (error) {
        // Invalid cursor, ignore
        logger.warn('[getListMCPServersByIds] Invalid cursor provided', error);
      }
    }

    if (normalizedLimit === null) {
      // No pagination - return all matching servers
      const servers = await MCPServer.find(baseQuery)
        .sort({ updatedAt: -1, _id: 1 })
        .lean<MCPServerDocument[]>();

      return {
        data: servers,
        has_more: false,
        after: null,
      };
    }

    // Paginated query - assign to const to help TypeScript
    const servers = await MCPServer.find(baseQuery)
      .sort({ updatedAt: -1, _id: 1 })
      .limit(normalizedLimit + 1)
      .lean<MCPServerDocument[]>();

    const hasMore = servers.length > normalizedLimit;
    const data = hasMore ? servers.slice(0, normalizedLimit) : servers;

    let nextCursor = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({
          updatedAt: lastItem.updatedAt,
          _id: lastItem._id,
        }),
      ).toString('base64');
    }

    return {
      data,
      has_more: hasMore,
      after: nextCursor,
    };
  }

  /**
   * Update an MCP server
   * @param serverName - The MCP server ID
   * @param updateData - Object containing config to update
   * @returns The updated MCP server document or null
   */
  async function updateMCPServer(
    serverName: string,
    updateData: { config?: MCPOptions },
  ): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findOneAndUpdate(
      { serverName },
      { $set: updateData },
      { new: true, runValidators: true },
    ).lean<MCPServerDocument>();
  }

  /**
   * Delete an MCP server
   * @param serverName - The MCP server ID
   * @returns The deleted MCP server document or null
   */
  async function deleteMCPServer(serverName: string): Promise<MCPServerDocument | null> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    return await MCPServer.findOneAndDelete({ serverName }).lean<MCPServerDocument>();
  }

  /**
   * Get MCP servers by their serverName strings
   * @param names - Array of serverName strings to fetch
   * @returns Object containing array of MCP server documents
   */
  async function getListMCPServersByNames({ names = [] }: { names: string[] }): Promise<{
    data: MCPServerDocument[];
  }> {
    if (names.length === 0) {
      return { data: [] };
    }
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    const servers = await MCPServer.find({ serverName: { $in: names } }).lean<
      MCPServerDocument[]
    >();
    return { data: servers };
  }

  /**
   * Account erasure: servers solely owned by the user, plus legacy (pre-ACL) servers that only
   * carry the author field. Servers shared with another owner are not returned.
   */
  async function findUserErasableMCPServers(userId: string): Promise<ErasableMCPServer[]> {
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument> | undefined;
    const AclEntry = mongoose.models.AclEntry;
    if (!MCPServer || !AclEntry) {
      return [];
    }

    const userObjectId = new mongoose.Types.ObjectId(userId);
    const soleOwnedIds = await deps.getSoleOwnedResourceIds(userObjectId, ResourceType.MCPSERVER);
    const authoredServers = await MCPServer.find({ author: userObjectId })
      .select('_id serverName')
      .lean<Array<{ _id: Types.ObjectId; serverName: string }>>();
    const migratedEntries =
      authoredServers.length > 0
        ? await AclEntry.find({
            resourceType: ResourceType.MCPSERVER,
            resourceId: { $in: authoredServers.map((s) => s._id) },
          })
            .select('resourceId')
            .lean<Array<{ resourceId: Types.ObjectId }>>()
        : [];
    const migratedIds = new Set(migratedEntries.map((e) => e.resourceId.toString()));
    const legacyServers = authoredServers.filter((s) => !migratedIds.has(s._id.toString()));
    const aclOwnedServers =
      soleOwnedIds.length > 0
        ? await MCPServer.find({ _id: { $in: soleOwnedIds } })
            .select('_id serverName')
            .lean<Array<{ _id: Types.ObjectId; serverName: string }>>()
        : [];
    const found = new Set(aclOwnedServers.map((s) => s._id.toString()));
    /** Sole-owned ids whose server is already gone keep an empty name so the ACLs still get cleaned. */
    const residual = soleOwnedIds
      .filter((id) => !found.has(id.toString()))
      .map((id) => ({ id: id.toString(), serverName: '' }));
    return [
      ...[...aclOwnedServers, ...legacyServers].map((s) => ({
        id: s._id.toString(),
        serverName: s.serverName,
      })),
      ...residual,
    ];
  }

  /** Users holding an OAuth credential record for the server, used to fence them on removal. */
  async function findMCPServerOAuthTokenUserIds(
    serverName: string,
    tenantId?: string,
  ): Promise<string[]> {
    const Token = mongoose.models.Token;
    if (!Token) {
      return [];
    }
    const identifier = `mcp:${serverName}`;
    /** Server names are unique per tenant, so a tenantless owner only matches tenantless tokens. */
    const userIds = await Token.distinct('userId', {
      tenantId: tenantId ?? null,
      identifier: { $in: [identifier, `${identifier}:client`, `${identifier}:refresh`] },
    });
    return userIds.map(String);
  }

  /** Principals holding view access on the server, used to find users it was shared with. */
  async function findMCPServerViewerEntries(serverId: string): Promise<MCPServerViewerEntry[]> {
    const entries = await mongoose.models.AclEntry.find({
      resourceType: ResourceType.MCPSERVER,
      resourceId: new mongoose.Types.ObjectId(serverId),
      permBits: { $in: permissionBitSupersets(PermissionBits.VIEW) },
    })
      .select('principalType principalId')
      .lean<Array<{ principalType: string; principalId?: Types.ObjectId | string }>>();
    return entries.map((entry) => ({
      principalType: entry.principalType,
      principalId: entry.principalId?.toString(),
    }));
  }

  /** Deletes MCP servers by id together with every ACL entry on them. */
  async function deleteMCPServersWithAcl(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const MCPServer = mongoose.models.MCPServer as Model<MCPServerDocument>;
    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    const result = await MCPServer.deleteMany({ _id: { $in: objectIds } });
    /** ACL entries are the retry discovery key for sole-owned servers, so they go last. */
    await mongoose.models.AclEntry.deleteMany({
      resourceType: ResourceType.MCPSERVER,
      resourceId: { $in: objectIds },
    });
    return result.deletedCount ?? 0;
  }

  return {
    findUserErasableMCPServers,
    deleteMCPServersWithAcl,
    findMCPServerOAuthTokenUserIds,
    findMCPServerViewerEntries,
    createMCPServer,
    findMCPServerByServerName,
    findMCPServerByObjectId,
    getListMCPServersByIds,
    getListMCPServersByNames,
    updateMCPServer,
    deleteMCPServer,
  };
}

export type MCPServerMethods = ReturnType<typeof createMCPServerMethods>;
