import type { Document, Types } from 'mongoose';

export interface IPrompt extends Document {
  groupId: Types.ObjectId;
  author: Types.ObjectId;
  prompt: string;
  type: 'text' | 'chat';
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

/** A stored prompt revision as plain data, without Mongoose document methods. */
export type IPromptRecord = Pick<
  IPrompt,
  'groupId' | 'author' | 'prompt' | 'type' | 'createdAt' | 'updatedAt' | 'tenantId'
> & { _id: Types.ObjectId; __v?: number };

export type PromptGroupSource = 'native' | 'langfuse';

export interface IPromptGroup {
  name: string;
  numberOfGenerations: number;
  oneliner: string;
  category: string;
  /** Required for `native` groups; absent for a mirrored group with no production prompt yet. */
  productionId?: Types.ObjectId;
  author: Types.ObjectId;
  authorName: string;
  command?: string;
  createdAt?: Date;
  updatedAt?: Date;
  isPublic?: boolean;
  tenantId?: string;
  source?: PromptGroupSource;
  sourcePromptName?: string;
  sourceProjectId?: string;
  sourceDestination?: string;
}

export interface IPromptGroupDocument extends IPromptGroup, Document {}
