import { Document, Types } from 'mongoose';

export interface IAgentApiKey extends Document {
  userId: Types.ObjectId;
  name: string;
  keyHash: string;
  keyPrefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  tenantId?: string;
}

export interface AgentApiKeyCreateData {
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
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
}
