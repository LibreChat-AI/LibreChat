import type { IPromptGroup as IPromptGroup } from '@librechat/data-schemas';
import type { Types } from 'mongoose';

export interface PromptGroupsListResponse<T = IPromptGroup> {
  promptGroups: T[];
  pageNumber: string;
  pageSize: string;
  pages: string;
  has_more: boolean;
  after: string | null;
}

export interface PromptGroupsAllResponse {
  data: IPromptGroup[];
}

export interface AccessiblePromptGroupsResult {
  object: 'list';
  data: IPromptGroup[];
  first_id: Types.ObjectId | null;
  last_id: Types.ObjectId | null;
  has_more: boolean;
  after: string | null;
}
