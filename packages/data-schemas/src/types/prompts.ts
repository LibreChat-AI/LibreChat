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

export interface IPromptGroup {
  name: string;
  numberOfGenerations: number;
  oneliner: string;
  category: string;
  productionId: Types.ObjectId;
  author: Types.ObjectId;
  authorName: string;
  command?: string;
  createdAt?: Date;
  updatedAt?: Date;
  isPublic?: boolean;
  tenantId?: string;
}

export interface IPromptGroupDocument extends IPromptGroup, Document {}
