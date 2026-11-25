import { Constants } from 'librechat-data-provider';
import type { TitleTiming } from '~/endpoints/config/providers';
import { createAgentTurnTitle } from './turnTitle';

function setup(overrides: Partial<Parameters<typeof createAgentTurnTitle>[0]> = {}) {
  const job = new AbortController();
  const trackTrailingAbort = jest.fn<Promise<boolean>, [() => void]>().mockResolvedValue(true);
  const generate = jest
    .fn<Promise<void>, [Parameters<Parameters<typeof createAgentTurnTitle>[0]['generate']>[0]]>()
    .mockResolvedValue(undefined);
  const jobs = {
    getJob: jest.fn().mockResolvedValue({ createdAt: 7 }),
    emitChunk: jest.fn().mockResolvedValue(undefined),
  };
  const release = jest.fn();
  const openConvoReady = jest.fn();
  const turnTitle = createAgentTurnTitle({
    timing: 'immediate',
    signal: job.signal,
    hasGenerator: true,
    parentMessageId: String(Constants.NO_PARENT),
    isNewConvo: true,
    streamId: 'chat',
    epoch: 7,
    convoReady: Promise.resolve(),
    openConvoReady,
    trackTrailingAbort,
    generate,
    jobs,
    logger: { error: jest.fn() },
    ...overrides,
  });
  return { turnTitle, trackTrailingAbort, generate, jobs, job, release, openConvoReady };
}

it.each([
  { hasGenerator: false },
  { isNewConvo: false },
  { isTemporary: true },
  { parentMessageId: 'parent' },
])('does not register a title for %p', async (inputs) => {
  const { turnTitle, trackTrailingAbort, generate, release } = setup(inputs);
  await turnTitle.prepare();
  turnTitle.startImmediate();
  turnTitle.finish(release);
  await turnTitle.settled();
  expect(trackTrailingAbort).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it.each<TitleTiming>(['immediate', 'final'])(
  'skips %s titles when cleanup cannot cancel them',
  async (timing) => {
    const { turnTitle, trackTrailingAbort, generate, release } = setup({ timing });
    trackTrailingAbort.mockResolvedValue(false);
    await turnTitle.prepare();
    turnTitle.startImmediate();
    await turnTitle.complete({ stopped: false, preempted: false });
    turnTitle.finish(release);
    await turnTitle.settled();
    expect(trackTrailingAbort).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it.each<TitleTiming>(['immediate', 'final'])(
  'keeps %s titles alive after normal completion and cancels them on cleanup',
  async (timing) => {
    const { turnTitle, trackTrailingAbort, generate, job, openConvoReady, release } = setup({
      timing,
    });
    generate.mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    await turnTitle.prepare();
    turnTitle.startImmediate();
    await turnTitle.complete({ stopped: false, preempted: false });
    job.abort();
    turnTitle.finish(release);
    await Promise.resolve();
    expect(openConvoReady).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].signal?.aborted).toBe(false);
    expect(release).not.toHaveBeenCalled();
    trackTrailingAbort.mock.calls[0][0]();
    await turnTitle.settled();
    turnTitle.dispose(release);
    expect(release).toHaveBeenCalledTimes(1);
  },
);

it('does not emit a live event when the stream closes during its epoch lookup', async () => {
  const { turnTitle, generate, jobs, release } = setup();
  let publishEpoch!: (value: { createdAt: number }) => void;
  jobs.getJob.mockReturnValue(new Promise((resolve) => (publishEpoch = resolve)));
  generate.mockImplementation(async ({ onTitleGenerated }) => {
    await onTitleGenerated?.({ conversationId: 'chat', title: 'Title' });
  });
  await turnTitle.prepare();
  turnTitle.startImmediate();
  await Promise.resolve();
  const closed = turnTitle.complete({ stopped: false, preempted: false });
  publishEpoch({ createdAt: 7 });
  await closed;
  turnTitle.finish(release);
  await turnTitle.settled();
  expect(jobs.emitChunk).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});
