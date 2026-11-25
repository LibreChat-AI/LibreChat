import type { Types, Document } from 'mongoose';

// Base memory interfaces
export interface IMemoryEntry extends Document {
  userId: Types.ObjectId;
  key: string;
  value: string;
  /** Agent partition; null/absent = shared personal pool */
  agentId?: string;
  tokenCount?: number;
  updated_at?: Date;
  tenantId?: string;
}

export interface IMemoryEntryLean {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  key: string;
  value: string;
  agentId?: string;
  tokenCount?: number;
  updated_at?: Date;
  __v?: number;
}

// Method parameter interfaces
export interface SetMemoryParams {
  userId: string | Types.ObjectId;
  key: string;
  value: string;
  tokenCount?: number;
  /** Agent partition; omit for the shared personal pool */
  agentId?: string;
}

export interface DeleteMemoryParams {
  userId: string | Types.ObjectId;
  key: string;
  agentId?: string;
}

export interface MemoryByIdParams {
  userId: string | Types.ObjectId;
  id: string;
  agentId?: string;
}

export interface SetMemoryByIdParams extends MemoryByIdParams {
  /** Omit to preserve the existing key. */
  key?: string;
  value: string;
  tokenCount?: number;
}

export interface GetUserMemoriesParams {
  userId: string | Types.ObjectId;
  agentId?: string;
}

export interface GetFormattedMemoriesParams {
  userId: string | Types.ObjectId;
  agentId?: string;
}

// Result interfaces
export interface MemoryResult {
  ok: boolean;
}

export interface SetMemoryByIdResult extends MemoryResult {
  conflict?: boolean;
  memory?: IMemoryEntryLean;
}

/** A failed read is not an empty memory partition. Consumers can suppress
 *  memory guidance and writes without changing the shape of successful reads. */
export type FormattedMemoriesResult =
  | {
      withKeys: string;
      withoutKeys: string;
      totalTokens?: number;
      tokenCountsByKey?: Map<string, number>;
      readFailed?: false;
    }
  | {
      withKeys: undefined;
      withoutKeys: undefined;
      totalTokens?: number;
      tokenCountsByKey?: Map<string, number>;
      readFailed: true;
    };
