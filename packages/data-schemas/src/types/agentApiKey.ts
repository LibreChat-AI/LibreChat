import { Document, Types } from 'mongoose';

/** Server-only integration grant; a bound key is never an unrestricted personal key. */
export interface AgentApiKeyBinding {
  kind: string;
  id: string;
}

export interface IAgentApiKey extends Document {
  binding?: AgentApiKeyBinding;
  userId: Types.ObjectId;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  tenantId?: string;
  /** MCP grants the owner made for this key, by the agent each one covers. */
  mcpGrants?: Record<string, unknown>;
}

export interface AgentApiKeyCreateData {
  binding?: AgentApiKeyBinding;
  userId: Types.ObjectId | string;
  name: string;
  expiresAt?: Date | null;
}

export interface AgentApiKeyCreateResult {
  id: string;
  name: string;
  keyPrefix: string;
  key: string;
  createdAt: Date;
  expiresAt?: Date;
}

export interface AgentApiKeyListItem {
  binding?: AgentApiKeyBinding;
  /** In a list: the key was issued to an integration. The binding itself is not listed. */
  bound?: boolean;
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
}
