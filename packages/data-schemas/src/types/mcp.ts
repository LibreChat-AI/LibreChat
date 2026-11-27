import { Document, Types } from 'mongoose';
import type { MCPServerDB } from 'librechat-data-provider';

/**
 * Mongoose document interface for MCP Server
 * Extends API interface with Mongoose-specific database fields
 */
export interface MCPServerDocument
  extends Omit<MCPServerDB, 'author' | '_id'>,
    Document<Types.ObjectId> {
  normalizedServerName: string;
  author: Types.ObjectId; // ObjectId reference in DB (vs string in API)
  tenantId?: string;
}
