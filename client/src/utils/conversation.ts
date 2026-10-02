import { pick } from 'lodash';
import type { TConversation } from 'librechat-data-provider';

export const isTemporaryConversation = (conversation?: Partial<TConversation> | null): boolean =>
  conversation?.isTemporary === true ||
  (conversation?.isTemporary === undefined && conversation?.expiredAt != null);

const sidebarFields = [
  'conversationId',
  'title',
  'endpoint',
  'endpointType',
  'model',
  'modelLabel',
  'chatGptLabel',
  'agent_id',
  'assistant_id',
  'spec',
  'iconURL',
  'user',
  'chatProjectId',
  'pinned',
  'isArchived',
  'isShared',
  'createdAt',
  'updatedAt',
  'archivedAt',
  'lastResponseAt',
  'lastResponseMessageId',
  'lastResponseIsManual',
  'lastSeenAt',
  'isTemporary',
  'expiredAt',
] as const satisfies readonly (keyof TConversation)[];

/** Sidebar metadata may overlay navigation records; chat-owned settings must not. */
export const toSidebarConversation = (conversation: TConversation): TConversation =>
  pick(conversation, sidebarFields);
