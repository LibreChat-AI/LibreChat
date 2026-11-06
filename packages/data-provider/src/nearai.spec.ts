import { nearAIVerificationReportSchema } from './nearai';

const report = {
  schemaVersion: 1,
  kind: 'response',
  completionId: 'completion-1',
  model: 'test-model',
  verifiedAt: '2026-11-06T10:00:00.000Z',
  scope: 'unknown',
  status: 'unverifiable',
  error: { code: 'test.unavailable', message: 'Evidence unavailable.' },
};

it.each(['response', 'reply'])('projects %s reports to the response wire kind', (kind) => {
  const input = { ...report, kind };
  expect(nearAIVerificationReportSchema.parse(input)).toEqual(report);
  expect(input.kind).toBe(kind);
});

it.each(['response', 'reply'])('still requires a completion ID for %s reports', (kind) => {
  expect(
    nearAIVerificationReportSchema.safeParse({ ...report, kind, completionId: undefined }).success,
  ).toBe(false);
});

it('keeps model reports separate from response reports', () => {
  expect(nearAIVerificationReportSchema.parse({ ...report, kind: 'model' }).kind).toBe('model');
  expect(nearAIVerificationReportSchema.safeParse({ ...report, kind: 'other' }).success).toBe(
    false,
  );
});
