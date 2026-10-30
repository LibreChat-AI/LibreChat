import { Socket } from 'node:net';
import { IncomingMessage, ServerResponse } from 'node:http';
import { logger as systemLogger } from '@librechat/data-schemas';
import {
  createMCPReauthenticationPrompt,
  createMCPAuthStepEmitter,
  createMCPInitializationOAuthPrompts,
} from './events';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { createOAuthCallback, invokeOAuthStart } from './publication';

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

it('rejects publication before the URL when durable step evidence fails, without exposing storage or logger diagnostics', async () => {
  const secret = 'private query body and credential';
  const internalDiagnostics = jest
    .spyOn(systemLogger, 'error')
    .mockImplementation(() => systemLogger);
  const saveRunSteps = jest.fn().mockRejectedValue(new Error(secret));
  const store = Object.assign(new InMemoryJobStore(), { saveRunSteps });
  const manager = new GenerationJobManagerClass();
  manager.configure({ jobStore: store, eventTransport: new InMemoryEventTransport() });
  manager.initialize();
  const socket = new Socket();
  const res = new ServerResponse(new IncomingMessage(socket));
  const logger = {
    warn: jest.fn(() => {
      throw new Error('private logger failure');
    }),
  };
  try {
    const streamId = 'oauth-publication-failure';
    const job = await manager.createJob(streamId, 'user', streamId);
    const url = jest.fn().mockResolvedValue(undefined);
    const start = createOAuthCallback({
      runStepEmitter: createMCPAuthStepEmitter({
        res,
        logger,
        streamId,
        jobCreatedAt: job.createdAt,
        jobs: manager,
        sendEvent: jest.fn(),
        runId: 'response',
        stepId: 'oauth-step',
        index: 0,
        toolCall: { id: 'oauth:call', name: 'oauth_mcp_clock', type: 'tool_call_chunk' },
      }),
      runStepDeltaEmitter: url,
    });
    const publication = invokeOAuthStart(start, 'https://auth.example/authorize');
    const expected = {
      code: 'oauth_prompt_publication_unavailable',
      message: 'MCP sign-in prompt is unavailable. Please try again.',
    };
    await expect(publication.published).rejects.toMatchObject(expected);
    await expect(publication.completed).rejects.toMatchObject(expected);
    expect(url).not.toHaveBeenCalled();
    expect(saveRunSteps).toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(internalDiagnostics.mock.calls)).not.toContain(secret);
  } finally {
    socket.destroy();
    await manager.destroy();
    internalDiagnostics.mockRestore();
  }
});

it('shares one durable startup prompt identity across discovery and reconnect, retiring exactly once', async () => {
  const emitChunk = jest.fn().mockResolvedValue(undefined);
  const owner = createMCPInitializationOAuthPrompts({
    userId: 'owner',
    res: {} as ServerResponse,
    sendEvent: jest.fn(),
    jobs: { emitChunk },
    streamId: 'startup-stream',
    jobCreatedAt: 123,
  });
  const prompt = owner.forServer('startup', 2);
  expect(owner.forServer('startup', 9)).toBe(prompt);
  const ack = jest.fn();
  await prompt.run(async () => {
    await prompt.start('https://auth.example/authorize', { onPublished: ack });
    await prompt.start('https://auth.example/authorize', { onPublished: ack });
    await prompt.end();
  });
  expect(ack).toHaveBeenCalledTimes(2);
  const events = emitChunk.mock.calls.map(([, event]) => event);
  expect(events.map((event) => event.event)).toEqual([
    'on_run_step',
    'on_run_step_delta',
    'on_run_step_completed',
  ]);
  expect(events[2].data.result.id).toBe(events[0].data.id);
  expect(events[2].data.result.tool_call.id).toBe(events[0].data.stepDetails.tool_calls[0].id);
  expect(events[2].data.result.index).toBe(2);
  expect(
    emitChunk.mock.calls.every(
      ([id, , options]) =>
        id === 'startup-stream' && options.expectedCreatedAt === 123 && options.durable === true,
    ),
  ).toBe(true);
});

it('does not cache failed startup publication and retries without hiding its original failure', async () => {
  const emitChunk = jest
    .fn()
    .mockRejectedValueOnce(new Error('private store diagnostic'))
    .mockResolvedValue(undefined);
  const prompt = createMCPInitializationOAuthPrompts({
    userId: 'owner',
    res: {} as ServerResponse,
    sendEvent: jest.fn(),
    jobs: { emitChunk },
    streamId: 'startup-stream',
    jobCreatedAt: 123,
  }).forServer('startup');
  const ack = jest.fn();
  await expect(
    prompt.start('https://auth.example/authorize', { onPublished: ack }),
  ).rejects.toThrow('MCP sign-in prompt is unavailable');
  expect(ack).not.toHaveBeenCalled();
  await prompt.start('https://auth.example/authorize', { onPublished: ack });
  await prompt.end();
  expect(ack).toHaveBeenCalledTimes(1);
  expect(emitChunk).toHaveBeenCalledTimes(4);
});

it('clears startup deduplication before a publication acknowledgement can reenter completion', async () => {
  const emitChunk = jest.fn().mockResolvedValue(undefined);
  const prompt = createMCPInitializationOAuthPrompts({
    userId: 'owner',
    res: {} as ServerResponse,
    sendEvent: jest.fn(),
    jobs: { emitChunk },
    streamId: 'startup-stream',
    jobCreatedAt: 123,
  }).forServer('startup');
  let ending: Promise<void> | undefined;
  await prompt.start('https://auth.example/authorize', {
    onPublished: () => {
      ending = prompt.end();
    },
  });
  await ending;
  await prompt.start('https://auth.example/authorize');
  await prompt.end();
  expect(emitChunk.mock.calls.map(([, event]) => event.event)).toEqual([
    'on_run_step',
    'on_run_step_delta',
    'on_run_step_completed',
    'on_run_step',
    'on_run_step_delta',
    'on_run_step_completed',
  ]);
});
