import type { TConversation } from 'librechat-data-provider';
import { areConversationListItemFieldsEqual } from '../utils';

const baseConversation = {
  conversationId: 'conversation-1',
  title: 'Shared chat',
  endpoint: 'openAI',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as TConversation;

describe('conversation list memoization of the shared badge', () => {
  it('treats a change in shared state as a re-render', () => {
    const shared = { ...baseConversation, isShared: true } as TConversation;
    const unshared = { ...baseConversation, isShared: false } as TConversation;

    expect(areConversationListItemFieldsEqual(shared, unshared)).toBe(false);
  });

  it('treats a newly shared conversation as a re-render', () => {
    const shared = { ...baseConversation, isShared: true } as TConversation;

    expect(areConversationListItemFieldsEqual(baseConversation, shared)).toBe(false);
  });

  it('still memoizes when nothing relevant changed', () => {
    const first = { ...baseConversation, isShared: true } as TConversation;
    const second = { ...baseConversation, isShared: true } as TConversation;

    expect(areConversationListItemFieldsEqual(first, second)).toBe(true);
  });

  it('treats a workspace detach as a re-render, since the row decides its pull request mark from it', () => {
    const attached = {
      ...baseConversation,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'env', workspaceId: 'ws' }],
    } as TConversation;
    const detached = {
      ...baseConversation,
      codeEnvironmentMode: 'without_attached',
    } as TConversation;

    expect(areConversationListItemFieldsEqual(attached, detached)).toBe(false);
  });

  it('treats a newly attached workspace as a re-render', () => {
    const attached = {
      ...baseConversation,
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'env', workspaceId: 'ws' }],
    } as TConversation;

    expect(areConversationListItemFieldsEqual(baseConversation, attached)).toBe(false);
  });
});
