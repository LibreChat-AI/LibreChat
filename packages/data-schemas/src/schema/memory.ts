import { Schema } from 'mongoose';
import type { IMemoryEntry } from '~/types/memory';

const MEMORY_KEY_REGEX = /^[a-z_]+$/;

export function isValidMemoryKey(key: string): boolean {
  return MEMORY_KEY_REGEX.test(key);
}

const MemoryEntrySchema: Schema<IMemoryEntry> = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: true,
  },
  key: {
    type: String,
    required: true,
    validate: {
      validator: isValidMemoryKey,
      message: 'Key must only contain lowercase letters and underscores',
    },
  },
  value: {
    type: String,
    required: true,
  },
  /** Agent partition; null/absent = shared personal pool */
  agentId: {
    type: String,
    default: undefined,
  },
  tokenCount: {
    type: Number,
    default: 0,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

MemoryEntrySchema.index({ userId: 1, agentId: 1, key: 1 });

export default MemoryEntrySchema;
