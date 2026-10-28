import { getToolApprovalConstraint } from './approval';
import { toolApprovalPolicySchema } from './config';

test.each([
  [{ enabled: true, mode: 'bypass', deny: ['delete_*'] }, 'delete_mcp_db', 'deny'],
  [{ enabled: true, mode: 'bypass', ask: ['*_mcp_db'] }, 'query_mcp_db', 'ask'],
  [{ enabled: true, mode: 'default', allow: ['query_mcp_db'] }, 'query_mcp_db', undefined],
  [{ enabled: true, mode: 'dontAsk' }, 'query_mcp_db', 'deny'],
  [{ enabled: true }, 'query_mcp_db', 'ask'],
  [{ enabled: false, deny: ['*'] }, 'query_mcp_db', undefined],
] as const)('projects the administrator constraint for %s', (policy, name, expected) => {
  expect(getToolApprovalConstraint(toolApprovalPolicySchema.parse(policy), name)).toBe(expected);
});
