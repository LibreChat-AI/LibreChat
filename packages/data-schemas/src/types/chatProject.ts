import type { Document, Types } from 'mongoose';

export interface IChatProject {
  _id?: Types.ObjectId;
  name: string;
  description?: string;
  instructions?: string;
  contextRevision?: number;
  file_ids?: string[];
  hasInstructions?: boolean;
  fileCount?: number;
  /** Set on projects another user shared with the requester. */
  isShared?: boolean;
  /** The requester's effective `PermissionBits` on a shared project. */
  permissions?: number;
  user: string;
  conversationCount: number;
  lastConversationAt?: Date | null;
  lastConversationId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

export interface IChatProjectDocument extends Omit<IChatProject, '_id'>, Document {}
