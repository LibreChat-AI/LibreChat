import { AGENT_EVENT_TYPES, isAgentEventType, agentEventTypeSchema } from './eventTypes';

describe('agent event types', () => {
  it('keeps the stored ids it shipped with', () => {
    expect(AGENT_EVENT_TYPES).toEqual([
      'github.pull_request_review.submitted',
      'github.pull_request_review_comment.created',
      'github.issue_comment.created',
      'github.check_suite.completed',
      'github.pull_request.closed',
    ]);
  });

  it('names each id provider, event and action', () => {
    for (const type of AGENT_EVENT_TYPES) {
      expect(type).toMatch(/^github\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it('recognises a stored id and nothing else', () => {
    expect(AGENT_EVENT_TYPES.every(isAgentEventType)).toBe(true);
    for (const value of ['github.push', 'GITHUB.CHECK_SUITE.COMPLETED', 'toString', '', 7, null]) {
      expect(isAgentEventType(value)).toBe(false);
    }
  });

  it('validates a stored id', () => {
    expect(agentEventTypeSchema.parse('github.check_suite.completed')).toBe(
      'github.check_suite.completed',
    );
    expect(agentEventTypeSchema.safeParse('github.check_suite.requested').success).toBe(false);
  });
});
