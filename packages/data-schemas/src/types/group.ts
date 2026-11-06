import type { Document, Types } from 'mongoose';
import { CursorPaginationParams } from '~/common';

export interface IGroup extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  email?: string;
  avatar?: string;
  /** Array of member IDs (stores idOnTheSource values, not ObjectIds) */
  memberIds?: string[];
  source: 'local' | 'entra';
  /** External ID (e.g., Entra ID) - required for non-local sources */
  idOnTheSource?: string;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
  /** Derived search tokens (see `~/utils/search`); `select: false`. */
  nameTokens?: string[];
  emailTokens?: string[];
}

export interface CreateGroupRequest {
  name: string;
  description?: string;
  email?: string;
  avatar?: string;
  memberIds?: string[];
  source: 'local' | 'entra';
  idOnTheSource?: string;
}

export interface UpdateGroupRequest {
  name?: string;
  description?: string;
  email?: string;
  avatar?: string;
  memberIds?: string[];
  source?: 'local' | 'entra' | 'ldap';
  idOnTheSource?: string;
}

export interface GroupFilterOptions extends CursorPaginationParams {
  // Includes email, name and description
  search?: string;
  source?: 'local' | 'entra' | 'ldap';
  hasMember?: string;
}
