import { createMCPReauthenticationPrompt } from './events';

function fixture(toolCallId?: string, stepId?: string) {
  const start = jest.fn(async () => {});
  const end = jest.fn(async () => {});
  const createStart = jest.fn(() => start);
  const createEnd = jest.fn(() => end);
  const prompt = createMCPReauthenticationPrompt({
    serverName: 'clock',
    toolCallId,
    stepId,
    runId: 'run',
    createStart,
    createEnd,
  });
  return { prompt, start, end, createStart, createEnd };
}

it.each([
  ['call', 'step', 'call'],
  [undefined, 'step', 'step'],
  [undefined, undefined, 'run'],
])('keeps a synthetic OAuth step separate from model output (%s, %s)', (call, step, id) => {
  const f = fixture(call, step);
  const expected = {
    stepId: `step_oauth_login_clock:oauth:${id}`,
    toolCall: { id: `oauth:${id}`, name: 'oauth_mcp_clock', type: 'tool_call_chunk' },
  };
  expect(f.createStart).toHaveBeenCalledWith(expected);
  expect(f.createEnd).toHaveBeenCalledWith(expected);
});

it('leaves ordinary tool calls unchanged without emitting an OAuth completion', async () => {
  const f = fixture();
  await expect(f.prompt.run(async () => ['ordinary result'])).resolves.toEqual(['ordinary result']);
  await f.prompt.end();
  expect(f.start).not.toHaveBeenCalled();
  expect(f.end).not.toHaveBeenCalled();
});

it('forwards the exact prompt deadline and completes consent only once', async () => {
  const f = fixture();
  const options = { expiresAt: 1234 };
  await expect(
    f.prompt.run(async () => {
      await f.prompt.start('https://auth.example/authorize', options);
      await f.prompt.end();
      return 'protected result';
    }),
  ).resolves.toBe('protected result');
  expect(f.start).toHaveBeenCalledWith('https://auth.example/authorize', options);
  expect(f.end).toHaveBeenCalledTimes(1);
});

it.each(['timeout', 'caller cancellation'])(
  'retires its prompt after %s without hiding the error',
  async (reason) => {
    const f = fixture();
    const failure = new Error(reason);
    await expect(
      f.prompt.run(async () => {
        await f.prompt.start('https://auth.example/authorize');
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(f.end).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  'preserves tool side effects and original outcome through retirement outage: throws=%s',
  async (throws) => {
    const f = fixture();
    const failure = new Error('original tool failure');
    const retirement = new Error('private retirement transport failure');
    f.end.mockRejectedValueOnce(retirement);
    let effects = 0;
    const operation = f.prompt.run(async () => {
      await f.prompt.start('https://auth.example/authorize');
      effects++;
      if (throws) throw failure;
      return 'executed result';
    });
    if (throws) await expect(operation).rejects.toBe(failure);
    else await expect(operation).resolves.toBe('executed result');
    expect(effects).toBe(1);
    await f.prompt.end();
    expect(f.end).toHaveBeenCalledTimes(2);
  },
);
