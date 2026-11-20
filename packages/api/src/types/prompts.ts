import type { IPromptGroup as IPromptGroup } from '@librechat/data-schemas';

export interface PromptGroupsListResponse<T = IPromptGroup> {
  promptGroups: T[];
  pageNumber: string;
  pageSize: string;
  pages: string;
  has_more: boolean;
  after: string | null;
}
