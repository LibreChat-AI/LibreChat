import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { TextEdit } from '../edits';
import { createHostEditProcessor } from './processing';

const workerPath = path.join(
  path.dirname(require.resolve('@librechat/api')),
  'agents/files/edit-worker.cjs',
);
const edit: TextEdit = { old_text: 'a', new_text: 'b', replace_all: true };
const amplification = (): TextEdit[] => [
  ...Array.from({ length: 23 }, () => ({ old_text: 'a', new_text: 'aa', replace_all: true })),
  ...Array.from({ length: 30 }, (_, i) => ({
    old_text: i % 2 ? 'b' : 'a',
    new_text: i % 2 ? 'a' : 'b',
    replace_all: true,
  })),
  { old_text: 'a', new_text: '', replace_all: true },
];

describe('bounded host edit workers', () => {
  const processor = createHostEditProcessor(workerPath);
  afterAll(async () => processor.close());

  it('rejects compact expansion and contraction while unrelated timers keep running', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 0);
    try {
      await expect(processor.apply('ax', amplification())).rejects.toThrow('budget exceeded');
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it('bounds occurrence work independently of scanned bytes', async () => {
    await expect(processor.apply('aaa', [edit], { maxOccurrences: 2 })).rejects.toThrow(
      'occurrence budget',
    );
  });

  it.each([9, 10])(
    'supports an ordinary exact edit of a %i MiB file with omitted limits',
    async (mib) => {
      const content = 'start\n' + 'x'.repeat(mib * 1024 * 1024 - 10) + '\nend';
      const result = await processor.apply(content, [{ old_text: 'start', new_text: 'begin' }]);
      expect(Buffer.byteLength(result.content)).toBe(mib * 1024 * 1024);
      expect(result.content.startsWith('begin\n')).toBe(true);
      expect(result.strategies).toEqual(['exact']);
    },
  );

  it.each([
    ['9 MiB ASCII', 'a'.repeat(9 * 1024 * 1024)],
    ['10 MiB ASCII', 'a'.repeat(10 * 1024 * 1024)],
    ['10 MiB UTF-8', 'é'.repeat(5 * 1024 * 1024)],
  ])('supports full matching context for %s with omitted limits', async (_label, content) => {
    const replacement = 'b' + content.slice(1);
    const result = await processor.apply(content, [{ old_text: content, new_text: replacement }]);
    expect(result.content).toBe(replacement);
    expect(result.strategies).toEqual(['exact']);
  });

  it('supports replace_all with full 10 MiB context and a same-size replacement', async () => {
    const content = 'a'.repeat(10 * 1024 * 1024);
    const replacement = 'b' + content.slice(1);
    await expect(
      processor.apply(content, [{ old_text: content, new_text: replacement, replace_all: true }]),
    ).resolves.toEqual({
      content: replacement,
      strategies: ['exact'],
    });
  });

  it.each([false, true])(
    'admits a full-file replacement into a smaller result, replace_all=%s',
    async (replaceAll) => {
      const content = 'a'.repeat(10 * 1024 * 1024);
      await expect(
        processor.apply(content, [{ old_text: content, new_text: 'b', replace_all: replaceAll }]),
      ).resolves.toEqual({
        content: 'b',
        strategies: ['exact'],
      });
    },
  );

  it('bounds every intermediate result, even when a later edit would shrink it', async () => {
    await expect(
      processor.apply(
        'a',
        [
          { old_text: 'a', new_text: 'x'.repeat(10 * 1024 * 1024 + 1) },
          { old_text: 'x', new_text: '', replace_all: true },
        ],
        { maxWorkBytes: 64 * 1024 * 1024 },
      ),
    ).rejects.toThrow('byte limit');
  });

  it('retains ordered edits, exact-match strategy, and UTF-16 offsets', async () => {
    await expect(
      processor.apply('😀 a\r\na', [edit, { old_text: 'b', new_text: 'c', replace_all: true }]),
    ).resolves.toEqual({
      content: '😀 c\r\nc',
      strategies: ['exact x2', 'exact x2'],
    });
  });

  it('checks server-side count limits without starting work', async () => {
    await expect(processor.apply('a', [edit, edit], { maxEdits: 1 })).rejects.toThrow(
      'limited to 1',
    );
  });

  it('fails closed with a safe error on invalid configuration', async () => {
    await expect(processor.apply('a', [edit], { maxConcurrent: 0 })).rejects.toThrow(
      'configuration is invalid',
    );
  });

  it('rejects pre-cancelled jobs', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(processor.apply('a', [edit], undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('worker lifecycle', () => {
  const fixture = path.join(__dirname, '__fixtures__', 'edit-worker.cjs');

  it('sanitizes synchronous thread creation failures without consuming admission', async () => {
    const processor = createHostEditProcessor(fixture);
    const startup = jest
      .spyOn(
        jest.requireActual<typeof import('node:worker_threads')>('node:worker_threads'),
        'Worker',
      )
      .mockImplementationOnce(() => {
        throw new Error('PRIVATE-STARTUP /operator/absolute/edit-worker.cjs');
      });
    try {
      await expect(processor.apply('ready', [edit], { maxConcurrent: 1 })).rejects.toThrow(
        /^File edit processing failed\. Nothing was written\.$/,
      );
      startup.mockRestore();
      await expect(processor.apply('ready', [edit], { maxConcurrent: 1 })).resolves.toEqual({
        content: 'ready',
        strategies: [],
      });
    } finally {
      startup.mockRestore();
      await processor.close();
    }
  });

  it('rejects oversized clone input before acquiring a worker', async () => {
    const processor = createHostEditProcessor(fixture);
    const startup = jest.spyOn(
      jest.requireActual<typeof import('node:worker_threads')>('node:worker_threads'),
      'Worker',
    );
    try {
      await expect(
        processor.apply('a', [{ old_text: 'a'.repeat(512), new_text: 'b' }], {
          maxWorkBytes: 1024,
        }),
      ).rejects.toThrow('budget exceeded');
      expect(startup).not.toHaveBeenCalled();
    } finally {
      startup.mockRestore();
      await processor.close();
    }
  });

  it.each([false, true])(
    'keeps timers running while a worker reply is pending, warm=%s',
    async (warm) => {
      const processor = createHostEditProcessor(fixture);
      const controller = new AbortController();
      try {
        if (warm) await processor.apply('ready', [edit]);
        let settled = false;
        const pending = processor.apply('wait', [edit], undefined, controller.signal).then(
          () => {
            settled = true;
            return 'completed';
          },
          (error: Error) => {
            settled = true;
            return error.name;
          },
        );
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        controller.abort();
        await expect(pending).resolves.toBe('AbortError');
      } finally {
        controller.abort();
        await processor.close();
      }
    },
  );

  it('has no queue and releases capacity only after cancellation terminates the worker', async () => {
    const processor = createHostEditProcessor(fixture);
    const controller = new AbortController();
    const pending = processor.apply('wait', [edit], { maxConcurrent: 1 }, controller.signal);
    try {
      await expect(processor.apply('ready', [edit], { maxConcurrent: 1 })).rejects.toThrow('busy');
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await expect(processor.apply('ready', [edit], { maxConcurrent: 1 })).resolves.toEqual({
        content: 'ready',
        strategies: [],
      });
    } finally {
      controller.abort();
      await processor.close();
    }
  });

  it('terminates stalled jobs at the deadline and permits later reuse', async () => {
    const processor = createHostEditProcessor(fixture);
    try {
      await expect(processor.apply('wait', [edit], { timeoutMs: 100 })).rejects.toThrow(
        'timed out',
      );
      await expect(processor.apply('ready', [edit])).resolves.toEqual({
        content: 'ready',
        strategies: [],
      });
    } finally {
      await processor.close();
    }
  });

  it.each([10_000, 10_001])(
    'rejects a reply at monotonic time %i before the timeout callback runs',
    async (replyTime) => {
      const processor = createHostEditProcessor(fixture);
      const persisted = jest.fn();
      const clock = jest
        .spyOn(performance, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0)
        .mockReturnValue(replyTime);
      try {
        const result = processor.apply('ready', [edit], { timeoutMs: 10_000, maxConcurrent: 1 });
        await expect(result.then(persisted)).rejects.toThrow('timed out');
        expect(clock).toHaveBeenCalledTimes(3);
        expect(persisted).not.toHaveBeenCalled();
        clock.mockRestore();
        await expect(processor.apply('ready', [edit], { maxConcurrent: 1 })).resolves.toEqual({
          content: 'ready',
          strategies: [],
        });
      } finally {
        clock.mockRestore();
        await processor.close();
      }
    },
  );

  it('accepts a reply strictly before the monotonic deadline', async () => {
    const processor = createHostEditProcessor(fixture);
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(9999);
    try {
      await expect(processor.apply('ready', [edit], { timeoutMs: 10_000 })).resolves.toEqual({
        content: 'ready',
        strategies: [],
      });
      expect(clock).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
      await processor.close();
    }
  });

  it('sanitizes worker crashes and recovers capacity', async () => {
    const processor = createHostEditProcessor(fixture);
    try {
      await expect(processor.apply('crash', [edit])).rejects.toThrow(
        /^File edit processing failed\. Nothing was written\.$/,
      );
      await expect(processor.apply('ready', [edit])).resolves.toEqual({
        content: 'ready',
        strategies: [],
      });
    } finally {
      await processor.close();
    }
  });
});
