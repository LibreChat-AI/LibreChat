import { bindToolApproval, getToolApprovalBinding } from './approval';

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
