import path from 'node:path';
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
