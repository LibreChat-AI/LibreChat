import { validate as validateUUID } from 'uuid';
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

for (const mode of ['chat', 'always'] as const) {
  test.each([undefined, '', 'invalid-revision'])(
    `${mode} repairs a missing or invalid revision when reselected (%s)`,
    (approval_revision) => {
      const options: AgentToolOptions = {
        a: { approval_mode: mode, approval_revision, defer_loading: true },
      };
      const repaired = withApprovalModes(options, ['a'], mode);
      expect(repaired).not.toBe(options);
      expect(repaired.a.approval_mode).toBe(mode);
      expect(repaired.a.defer_loading).toBe(true);
      expect(validateUUID(repaired.a.approval_revision!)).toBe(true);
      expect(options.a.approval_revision).toBe(approval_revision);
      expect(withApprovalModes(repaired, ['a'], mode)).toBe(repaired);
    },
  );

  test(`${mode} bulk selection repairs only missing revisions and preserves valid consent`, () => {
    const valid = withApprovalModes({}, ['a'], mode);
    const original: AgentToolOptions = {
      ...valid,
      b: { approval_mode: mode, describe_intent: true },
    };
    const repaired = withApprovalModes(original, ['a', 'b'], mode);
    expect(repaired.a).toBe(original.a);
    expect(repaired.b).toMatchObject({ approval_mode: mode, describe_intent: true });
    expect(validateUUID(repaired.b.approval_revision!)).toBe(true);
    expect(original.b.approval_revision).toBeUndefined();
  });
}

test('unchanged ask, allow and inherited modes do not generate unnecessary revisions', () => {
  for (const mode of ['ask', 'allow', undefined] as const) {
    const original: AgentToolOptions = { a: { approval_mode: mode, defer_loading: true } };
    expect(withApprovalModes(original, ['a'], mode)).toBe(original);
  }
});
