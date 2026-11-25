import { Document, Types } from 'mongoose';
import type { OneOrMany } from './query';

export interface IAssistant extends Document {
  user: Types.ObjectId;
  assistant_id: string;
  endpoint?: string;
  avatar?: {
    filepath: string;
    source: string;
  };
  conversation_starters?: string[];
  access_level?: number;
  file_ids?: string[];
  actions?: string[];
  append_current_datetime?: boolean;
  tenantId?: string;
}

/**
 * Domain criteria for locating assistants. Fields are combined with AND; an
 * array value matches any of its entries.
 */
export interface AssistantQuery {
  assistantId?: OneOrMany<string>;
  user?: string;
  /** Matches the stored avatar path, used to authorize avatar image reads. */
  avatarFilepath?: OneOrMany<string>;
}
