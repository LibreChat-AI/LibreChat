import type { AgentToolOptions } from 'librechat-data-provider';
import { withApprovalModes } from '../useMCPToolOptions';

test('bulk changes preserve other tool options and do not mutate the form snapshot', () => {
  const original: AgentToolOptions = { a: { defer_loading: true }, b: { run_in_background: true } };
  const updated = withApprovalModes(original, ['a', 'b'], 'chat');
  expect(original).toEqual({ a: { defer_loading: true }, b: { run_in_background: true } });
  expect(updated.a).toMatchObject({
    defer_loading: true,
    approval_mode: 'chat',
    approval_revision: expect.any(String),
  });
  expect(updated.b).toMatchObject({ run_in_background: true, approval_mode: 'chat' });
  expect(updated.a.approval_revision).not.toEqual(updated.b.approval_revision);
});

test('selecting the existing mode preserves its approval revision and form identity', () => {
  const original = withApprovalModes({}, ['a'], 'always');
  expect(withApprovalModes(original, ['a'], 'always')).toBe(original);
});

test('inheritance clears only the approval settings and drops empty entries', () => {
  const original: AgentToolOptions = withApprovalModes(
    { a: { defer_loading: true } },
    ['a', 'b'],
    'ask',
  );
  expect(withApprovalModes(original, ['a', 'b'])).toEqual({ a: { defer_loading: true } });
});
