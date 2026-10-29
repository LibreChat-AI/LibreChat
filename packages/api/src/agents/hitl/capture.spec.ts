import { Constants } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import { captureCodeExecutionApprovalBinding } from '../execution';
import { captureRunPendingAction } from './capture';
import { toClientPendingAction } from './policy';

const context = {
  streamId: 'response',
  responseMessageId: 'response',
  conversationId: 'conversation',
  actionId: 'action',
  interruptId: 'interrupt',
  threadId: 'conversation',
  projectContextKey: 'project-revision',
  requestFingerprint: 'legacy',
  requestFingerprintV2: 'current',
  resumeContext: { endpoint: 'agents', agent_id: 'agent' },
  ttlMs: 60_000,
};
const agents = [
  {
    id: 'agent',
    codeExecutionContext: {
      baseUrl: 'https://private-code.example',
      codeSessionKey: 'private-session-key',
      executionProfile: 'stateful' as const,
      statefulSessions: true,
    },
  },
];

function payload(name: string): Agents.ToolApprovalInterruptPayload {
  return {
    type: 'tool_approval',
    action_requests: [{ name, tool_call_id: 'call', arguments: { command: 'pwd' } }],
    review_configs: [
      { action_name: name, tool_call_id: 'call', allowed_decisions: ['approve', 'reject'] },
    ],
  };
}

it('retains the original question and immutable host context without inventing tool bindings', () => {
  const question: Agents.HumanInterruptPayload = {
    type: 'ask_user_question',
    question: { question: 'Which environment?' },
  };
  const action = captureRunPendingAction({
    run: {},
    payload: question,
    agents,
    aliases: [],
    context,
  });
  const { ttlMs, ...storedContext } = context;
  expect(action).toMatchObject({ ...storedContext, payload: question });
  expect(action.expiresAt).toBe(action.createdAt + ttlMs);
  expect(action.codeExecutionBinding).toBeUndefined();
  expect(action.toolApprovalBindings).toBeUndefined();
  expect(action.toolApprovalAliases).toBeUndefined();
});

it('captures the existing opaque native-code target binding without exposing its credentials', () => {
  const action = captureRunPendingAction({
    run: {},
    payload: payload(Constants.BASH_TOOL),
    agents,
    aliases: [],
    context,
  });
  expect(action.codeExecutionBinding).toEqual(captureCodeExecutionApprovalBinding(agents));
  expect(JSON.stringify(action)).not.toContain('private-session-key');
  expect(JSON.stringify(action)).not.toContain('https://private-code.example');
  expect(toClientPendingAction(action)).not.toHaveProperty('codeExecutionBinding');
});

it('does not bind unrelated tool reviews to a code environment merely present in the graph', () => {
  const action = captureRunPendingAction({
    run: {},
    payload: payload('lookup'),
    agents,
    aliases: [],
    context,
  });
  expect(action.codeExecutionBinding).toBeUndefined();
});

it('retains only aliases for tools actually offered conversation-wide approval', () => {
  const approval = payload('lookup_mcp_catalog');
  approval.review_configs[0].allow_always = true;
  const aliases = [
    { name: 'lookup_mcp_catalog', aliasName: 'read_mcp_catalog' },
    { name: 'delete_mcp_catalog', aliasName: 'remove_mcp_catalog' },
  ];
  const action = captureRunPendingAction({
    run: {},
    payload: approval,
    agents: [],
    aliases,
    context,
  });
  expect(action.toolApprovalAliases).toEqual([aliases[0]]);
  expect(toClientPendingAction(action)).not.toHaveProperty('toolApprovalAliases');
});
