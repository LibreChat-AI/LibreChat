import { PULL_REQUEST_CHECKS, PULL_REQUEST_MERGEABLE, PULL_REQUEST_STATES } from './types';
import { conversationPullRequest } from './api-endpoints';
import { QueryKeys } from './keys';

describe('conversation pull request contract', () => {
  it('builds the endpoint under the conversation', () => {
    expect(conversationPullRequest('abc-123')).toBe('/api/convos/abc-123/pull-request');
  });

  it('encodes a conversation id so it cannot change the path or query', () => {
    const endpoint = conversationPullRequest('a/b?c=d#e');
    expect(endpoint).toBe('/api/convos/a%2Fb%3Fc%3Dd%23e/pull-request');
    expect(endpoint).not.toContain('?');
    expect(endpoint).not.toContain('#');
  });

  it('has its own query key', () => {
    expect(QueryKeys.conversationPullRequest).toBe('conversationPullRequest');
  });

  it('lists every state the header can render', () => {
    expect([...PULL_REQUEST_STATES]).toEqual(['open', 'closed', 'merged']);
    expect([...PULL_REQUEST_MERGEABLE]).toEqual(['clean', 'conflicting', 'unknown']);
    expect([...PULL_REQUEST_CHECKS]).toEqual(['passing', 'failing', 'running', 'none']);
  });
});
