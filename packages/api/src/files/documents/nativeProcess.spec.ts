import { CHILD_PRELUDE } from './nativeProcess';

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

/**
 * The limiter is process-wide and resolved once, so each test needs its own module
 * instance: sharing one would let the first test's bounds decide the rest.
 */
describe('parser admission configuration', () => {
  let withParserAdmission: typeof import('./nativeProcess').withParserAdmission;

  beforeEach(async () => {
    jest.resetModules();
    ({ withParserAdmission } = await import('./nativeProcess'));
  });

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

  /**
   * The code-artifact and fallback-text callers reach the same engines with no options,
   * so they have to land in the limiter the upload route configured: a limiter of their
   * own would run children the operator's bound never counted.
   */
  test('a caller that passes no options joins the configured limiter', async () => {
    const first = deferred();
    const started: string[] = [];
    const configured = withParserAdmission(
      async () => {
        started.push('configured');
        await first.promise;
        return 'configured';
      },
      undefined,
      1,
      2,
    );
    const unconfigured = withParserAdmission(async () => {
      started.push('unconfigured');
      return 'unconfigured';
    });

    await Promise.resolve();
    expect(started).toEqual(['configured']);
    first.resolve();
    await expect(Promise.all([configured, unconfigured])).resolves.toEqual([
      'configured',
      'unconfigured',
    ]);
    expect(started).toEqual(['configured', 'unconfigured']);
  });

  /**
   * A limiter created for new bounds would start with an active count of zero while the
   * children the first one admitted are still running, so the process would exceed both
   * bounds at once. Later bounds are therefore ignored rather than swapped in.
   */
  test('later bounds never replace the limiter that is already admitting', async () => {
    const first = deferred();
    const started: string[] = [];
    const running = withParserAdmission(
      async () => {
        started.push('first');
        await first.promise;
        return 'first';
      },
      undefined,
      1,
      2,
    );
    /* A second request resolving a wider bound must still wait behind the first. */
    const wider = withParserAdmission(
      async () => {
        started.push('wider');
        return 'wider';
      },
      undefined,
      4,
      8,
    );

    await Promise.resolve();
    expect(started).toEqual(['first']);
    first.resolve();
    await expect(Promise.all([running, wider])).resolves.toEqual(['first', 'wider']);
  });
});
