import { CHILD_PRELUDE, withParserAdmission } from './nativeProcess';

/**
 * The counter runs inside the child, where the payload is measured before it crosses
 * IPC. `JSON.stringify` is the ground truth it has to match: building that string to
 * measure it is exactly the allocation the cap exists to refuse, so the count is done in
 * one pass instead, and this pins the two together.
 */
const measure: (text: string) => number = new Function(
  `${CHILD_PRELUDE}; return __serializedBytes;`,
)();

const serialized = (text: string): number => Buffer.byteLength(JSON.stringify(text), 'utf8');

describe('child payload measurement', () => {
  it.each([
    ['plain ascii', 'Quarterly Report'],
    ['an empty string', ''],
    ['quotes and backslashes', 'he said "hi" \\ there'],
    ['newlines and tabs', 'a\nb\tc\r\n'],
    ['other control characters', 'a\u0001b\u001fc'],
    ['two-byte scalars', 'caf\u00e9 r\u00e9sum\u00e9 na\u00efve'],
    ['three-byte scalars', '\u65e5\u672c\u8a9e\u306e\u30c6\u30ad\u30b9\u30c8'],
    ['emoji, which are surrogate pairs', '\ud83d\ude42\ud83d\ude80 done'],
    ['a lone high surrogate', 'a\ud800b'],
    ['a lone low surrogate', 'a\udc00b'],
    ['a high surrogate at the end', 'ab\ud800'],
  ])('matches JSON serialization for %s', (_label, text) => {
    expect(measure(text)).toBe(serialized(text));
  });
});

describe('parser admission configuration', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  test('uses a configured concurrency of one to serialize parses', async () => {
    const first = deferred();
    const started: string[] = [];
    const firstParse = withParserAdmission(
      async () => {
        started.push('first');
        await first.promise;
        return 'first';
      },
      undefined,
      1,
      1,
    );
    const secondParse = withParserAdmission(
      async () => {
        started.push('second');
        return 'second';
      },
      undefined,
      1,
      1,
    );

    await Promise.resolve();
    expect(started).toEqual(['first']);
    first.resolve();
    await expect(Promise.all([firstParse, secondParse])).resolves.toEqual(['first', 'second']);
    expect(started).toEqual(['first', 'second']);
  });

  test('rejects the waiter beyond configured queue depth', async () => {
    const first = deferred();
    const running = withParserAdmission(
      async () => {
        await first.promise;
        return 'running';
      },
      undefined,
      1,
      1,
    );
    const queued = withParserAdmission(async () => 'queued', undefined, 1, 1);
    const refused = withParserAdmission(async () => 'refused', undefined, 1, 1);

    await expect(refused).rejects.toMatchObject({
      name: 'ConcurrencyLimitError',
      code: 'CONCURRENCY_LIMIT',
      userErrorStatusCode: 503,
    });
    first.resolve();
    await expect(Promise.all([running, queued])).resolves.toEqual(['running', 'queued']);
  });

  test('shares the compatibility-default limiter across calls without options', async () => {
    const first = deferred();
    const started: string[] = [];
    const parses = ['first', 'second', 'third'].map((name, index) =>
      withParserAdmission(async () => {
        started.push(name);
        if (index === 0) {
          await first.promise;
        }
        return name;
      }),
    );

    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    first.resolve();
    await expect(Promise.all(parses)).resolves.toEqual(['first', 'second', 'third']);
  });
});
