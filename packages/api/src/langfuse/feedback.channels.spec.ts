import { sendFeedbackScore } from './feedback';

let fetchMock: jest.SpiedFunction<typeof fetch>;
const originalEnv = { ...process.env };
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('LANGFUSE_')) delete process.env[key];
  }
  Object.assign(process.env, {
    LANGFUSE_PUBLIC_KEY: 'fixture-public',
    LANGFUSE_SECRET_KEY: 'fixture-secret',
    LANGFUSE_PROJECT_ID: 'fixture-project',
    LANGFUSE_BASE_URL: 'https://langfuse.invalid',
  });
  fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
});
afterEach(() => {
  fetchMock.mockRestore();
  process.env = { ...originalEnv };
});

test('channel score IDs remain distinct from browser feedback and are stable for update/removal', async () => {
  const signal = new AbortController().signal;
  await sendFeedbackScore({
    traceId: 'trace',
    scoreId: 'channel-feedback-hash-a',
    signal,
    feedback: { rating: 'thumbsUp' },
  });
  await sendFeedbackScore({
    traceId: 'trace',
    scoreId: 'channel-feedback-hash-b',
    feedback: { rating: 'thumbsDown' },
  });
  await sendFeedbackScore({ traceId: 'trace', feedback: { rating: 'thumbsUp' } });
  expect(
    fetchMock.mock.calls.slice(0, 3).map(([, init]) => JSON.parse(init!.body as string).id),
  ).toEqual(['channel-feedback-hash-a', 'channel-feedback-hash-b', 'feedback-trace']);
  expect(fetchMock.mock.calls[0][1]?.signal).toBe(signal);
  await sendFeedbackScore({
    traceId: 'trace',
    scoreId: 'channel-feedback-hash-a',
    signal,
    feedback: null,
  });
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://langfuse.invalid/api/public/scores/channel-feedback-hash-a',
    expect.objectContaining({ method: 'DELETE', signal }),
  );
});

test('sampling and central-export suppression still apply to explicit channel score IDs', async () => {
  await sendFeedbackScore({
    traceId: 'trace',
    scoreId: 'channel-score',
    sampled: false,
    feedback: { rating: 'thumbsUp' },
  });
  await sendFeedbackScore({
    traceId: 'trace',
    scoreId: 'channel-score',
    centralTraceExportEnabled: false,
    feedback: { rating: 'thumbsUp' },
  });
  expect(fetchMock).not.toHaveBeenCalled();
});
