import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  isSelfSpawn,
  messageAuthor,
  resolveSelfAuthor,
  resolveSubagentAuthor,
  findAgentLaneId,
  resolveChildAgent,
  readableSubagentType,
  readableSubagentTitle,
  findAgentAuthorMessage,
} from './author';

function message(
  messageId: string,
  parentMessageId: string | null,
  isCreatedByUser = false,
): TMessage {
  return {
    messageId,
    parentMessageId,
    isCreatedByUser,
    conversationId: 'parent',
    text: '',
    sender: messageId,
    endpoint: EModelEndpoint.agents,
  };
}

it('prefers the dispatch itself over an earlier reply and preserves the first agent reply', () => {
  const firstReply = message('first', 'dispatch');
  const dispatch = message('dispatch', null);
  const messages = [
    message('user', null, true),
    firstReply,
    dispatch,
    message('second', 'dispatch'),
  ];
  expect(findAgentAuthorMessage(messages, 'dispatch')).toBe(dispatch);
  expect(findAgentAuthorMessage(messages, 'missing')).toBeUndefined();
  expect(findAgentAuthorMessage([firstReply, message('second', 'dispatch')], 'dispatch')).toBe(
    firstReply,
  );
});

it('shares one history traversal across multiple wake-up authors and indexes a new snapshot', () => {
  const messages = Array.from({ length: 1000 }, (_, i) => message(`reply-${i}`, `wake-${i}`));
  const traversal = jest.spyOn(messages, Symbol.iterator);
  for (let i = 0; i < messages.length; i++) {
    expect(findAgentAuthorMessage(messages, `wake-${i}`)).toBe(messages[i]);
  }
  expect(traversal).toHaveBeenCalledTimes(1);
  const added = message('added', 'new-wake');
  expect(findAgentAuthorMessage([...messages, added], 'new-wake')).toBe(added);
  expect(findAgentAuthorMessage(messages, 'new-wake')).toBeUndefined();
});

it('preserves self as an explicit graph alias across author resolution', () => {
  expect(isSelfSpawn('self', 'graph')).toBe(false);
  expect(isSelfSpawn('self', 'agent')).toBe(true);
  expect(isSelfSpawn('self')).toBe(true);
  expect(readableSubagentType('self', undefined, 'graph')).toBe('self');
  expect(readableSubagentType('self')).toBeUndefined();
  expect(resolveChildAgent('agent-1', 'self', undefined, {}, 'graph')).toBeUndefined();
});

it('retains matching historical snapshots and never borrows an enclosing avatar for a missing lane', () => {
  const snapshot = message('dispatch', null);
  snapshot.model = 'agent_deleted';
  snapshot.sender = 'Historical Parent';
  snapshot.iconURL = '/historical.png';
  const parent = messageAuthor(snapshot, undefined, 'Agent');
  expect(resolveSelfAuthor(parent, 'agent_deleted', undefined, 'Agent')).toBe(parent);
  expect(resolveSelfAuthor(parent, undefined, undefined, 'Agent')).toBe(parent);
  expect(resolveSelfAuthor(parent, 'agent_missing_lane', undefined, 'Agent').name).toBe('Agent');
  expect(messageAuthor(snapshot, undefined, 'Agent', 'agent_missing_lane').name).toBe('Agent');
  expect(findAgentLaneId(snapshot, 'missing')).toBeUndefined();
});

it('retains legacy graph aliases while suppressing identities known to be agent IDs', () => {
  expect(readableSubagentType('agent_research_team')).toBe('agent_research_team');
  expect(readableSubagentType('agent_research_team', undefined, 'graph')).toBe(
    'agent_research_team',
  );
  expect(readableSubagentType('agent_deleted', 'agent_deleted')).toBeUndefined();
  expect(readableSubagentType('agent_deleted', undefined, 'agent')).toBeUndefined();
});

it('resolves repeated tool IDs by their content-part occurrence and rejects ambiguous legacy matches', () => {
  const dispatch = message('dispatch', null);
  dispatch.content = [
    {
      type: ContentTypes.TOOL_CALL,
      agentId: 'first',
      tool_call: { id: 'repeat', name: 'subagent', args: {} },
    },
    {
      type: ContentTypes.TOOL_CALL,
      agentId: 'second',
      tool_call: { id: 'repeat', name: 'subagent', args: {} },
    },
  ];
  expect(findAgentLaneId(dispatch, 'repeat', 0)).toBe('first');
  expect(findAgentLaneId(dispatch, 'repeat', 1)).toBe('second');
  expect(findAgentLaneId(dispatch, 'repeat')).toBeUndefined();
  expect(findAgentLaneId(dispatch, 'repeat', 9)).toBeUndefined();
});

it('preserves literal display titles while suppressing legacy storage keys', () => {
  expect(readableSubagentTitle('Subagent: research', undefined, 'graph')).toBe(
    'Subagent: research',
  );
  expect(readableSubagentTitle('Subagent: Historical Agent', 'agent_deleted', 'agent')).toBe(
    'Subagent: Historical Agent',
  );
  expect(readableSubagentTitle('self', 'agent_deleted', 'agent')).toBe('self');
  expect(readableSubagentTitle('agent_research_team', 'agent_deleted', 'agent')).toBe(
    'agent_research_team',
  );
  expect(
    readableSubagentTitle('Subagent: agent_deleted', 'agent_deleted', 'agent'),
  ).toBeUndefined();
});

it.each([
  [{ subagentType: 'self' }, 'Historical Parent'],
  [{ subagentType: 'self', agentId: 'agent_parent' }, 'Historical Parent'],
  [{ subagentType: 'self', agentId: 'agent_missing_lane' }, 'Agent'],
  [{ subagentType: 'self', subagentKind: 'graph' as const }, 'self'],
  [{ subagentType: 'Subagent: research', subagentKind: 'graph' as const }, 'Subagent: research'],
  [{ subagentType: 'agent_research_team' }, 'agent_research_team'],
  [{ subagentType: 'agent_deleted', subagentKind: 'agent' as const }, 'Agent'],
  [{ subagentType: 'agent_deleted', agentId: 'agent_deleted' }, 'Agent'],
])('resolves child identity %j consistently across surfaces', (child, expectedName) => {
  const snapshot = message('dispatch', null);
  snapshot.model = 'agent_parent';
  snapshot.sender = 'Historical Parent';
  const parent = messageAuthor(snapshot, undefined, 'Agent');
  expect(resolveSubagentAuthor(child, parent, undefined, 'Agent').name).toBe(expectedName);
});
