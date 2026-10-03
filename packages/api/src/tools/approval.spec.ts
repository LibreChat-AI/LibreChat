import {
  bindToolApproval,
  getToolApprovalBinding,
  bindToolApprovalIdentity,
  getToolApprovalIdentity,
  assertToolApprovalExecution,
  withToolApprovalExecution,
  bindToolReviewAuthority,
  getToolReviewAuthority,
} from './approval';
import {
  bindToolApprovalInvocation,
  noteToolApprovalDispatch,
  withToolApprovalTransport,
  assertToolApprovalTransportEpoch,
} from './approval';
import { getToolApprovalAuthKind } from './approval';

test('connection-derived bindings survive local copies without reaching JSON or provider payloads', () => {
  const definition = bindToolApproval(
    { name: 'query_mcp_db', parameters: { type: 'object' } },
    'private-source-hash',
  );
  const copied = { ...definition };
  expect(getToolApprovalBinding(copied)).toBe('private-source-hash');
  expect(JSON.parse(JSON.stringify(copied))).toEqual({
    name: 'query_mcp_db',
    parameters: { type: 'object' },
  });
  expect(JSON.stringify(copied)).not.toContain('private-source-hash');
});

test('raw target fingerprints stay private when definitions are copied or serialized', () => {
  const definition = bindToolApprovalIdentity(
    { name: 'query_mcp_db', parameters: { type: 'object' } },
    'db_query',
    { type: 'object' },
  );
  expect(getToolApprovalIdentity({ ...definition })).toEqual(expect.any(String));
  expect(getToolApprovalIdentity(JSON.parse(JSON.stringify(definition)))).toBeUndefined();
});

test('concurrent runs isolate the execution guard without a global run-id lookup', async () => {
  const first = jest.fn(async () => {});
  const second = jest.fn(async () => {});
  await Promise.all([
    withToolApprovalExecution({ validateExecution: first }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      await assertToolApprovalExecution(
        { name: 'query_mcp_db' },
        { toolCall: { id: 'first' }, metadata: { activeAgentId: 'agent-a' } },
      );
    }),
    withToolApprovalExecution({ validateExecution: second }, async () => {
      await assertToolApprovalExecution(
        { name: 'query_mcp_db' },
        { toolCall: { id: 'second' }, metadata: { activeAgentId: 'agent-b' } },
      );
    }),
  ]);
  expect(first).toHaveBeenCalledWith(
    { name: 'query_mcp_db' },
    { agentId: 'agent-a', toolCallId: 'first', background: false },
  );
  expect(second).toHaveBeenCalledWith(
    { name: 'query_mcp_db' },
    { agentId: 'agent-b', toolCallId: 'second', background: false },
  );
  await assertToolApprovalExecution({ name: 'query_mcp_db' });
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
});

test('invocation-only authority stays private while surviving internal definition copies', () => {
  const definition = bindToolReviewAuthority({ name: 'query_mcp_db' }, 'private-review-authority');
  expect(getToolReviewAuthority({ ...definition })).toBe('private-review-authority');
  expect(JSON.stringify(definition)).not.toContain('private-review-authority');
});

test('private dispatch ownership survives metadata copies and binds the exact transport invocation', async () => {
  const token = Symbol('invocation');
  const dispatch = { agentId: 'agent-a', toolCallId: 'call_0', background: true };
  const execution = {
    validateExecution: jest.fn(async () => {}),
    noteDispatch: (invocation: import('./approval').ToolApprovalInvocation) => {
      invocation.ownership = token;
    },
    validateTransport: jest.fn(async () => {}),
  };
  await withToolApprovalExecution(execution, async () => {
    noteToolApprovalDispatch(dispatch);
    const metadata = { ...bindToolApprovalInvocation({ agentId: 'agent-a' }, dispatch) };
    expect(JSON.stringify(metadata)).toBe('{"agentId":"agent-a"}');
    const config = {
      toolCall: { id: 'call_0' },
      metadata,
      configurable: { __librechatBackgroundToolInvocation: true },
    };
    const approved = await assertToolApprovalExecution({ name: 'query_mcp_db' }, config);
    await withToolApprovalTransport(
      config,
      () => assertToolApprovalTransportEpoch('db', null),
      approved,
    );
  });
  expect(execution.validateTransport).toHaveBeenCalledWith(
    'db',
    null,
    expect.objectContaining({ ownership: token, toolCallId: 'call_0' }),
    false,
  );
});

test('effective auth kind stays private while surviving definition copies', () => {
  const def = bindToolApproval(
    { name: 'query_mcp_db' },
    'source',
    undefined,
    undefined,
    undefined,
    'other',
  );
  expect(getToolApprovalAuthKind({ ...def })).toBe('other');
  expect(getToolApprovalAuthKind(JSON.parse(JSON.stringify(def)))).toBeUndefined();
  expect(JSON.stringify(def)).toBe('{"name":"query_mcp_db"}');
});
