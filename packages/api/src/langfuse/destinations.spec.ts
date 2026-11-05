process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const langfuseEnvKeys = [
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PROJECT_ID',
  'LANGFUSE_BASE_URL',
  'LANGFUSE_HOST',
  'LANGFUSE_BASEURL',
];

function clearLangfuseEnv() {
  for (const key of langfuseEnvKeys) {
    delete process.env[key];
  }
}

// Cleared before the module graph loads: another spec file running earlier in
// this worker may have left Langfuse env vars set, and `./destinations` reads
// them at import time for its own warm-up lookup.
clearLangfuseEnv();

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  }),
  { virtual: true },
);

let fetchMock: jest.SpiedFunction<typeof fetch>;

/** A fresh module instance per test, so each test's project-id cache (keyed by
 *  base URL and credentials) starts empty instead of reusing another test's
 *  resolved id or retry window. */
async function loadDestinations(): Promise<typeof import('./destinations')> {
  jest.resetModules();
  return import('./destinations');
}

function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

describe('resolveCentralProjectIdOutcome', () => {
  beforeEach(() => {
    clearLangfuseEnv();
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    clearLangfuseEnv();
    jest.restoreAllMocks();
  });

  it('uses the default project-lookup timeout when no timeoutMs is given', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'project-default-timeout' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await resolveCentralProjectIdOutcome(
      'https://cloud.langfuse.com',
      'public-key',
      'secret-key',
      true,
    );

    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('reports a lookup timeout as timedOut, distinct from any other failure', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    fetchMock.mockRejectedValue(timeoutError());

    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
        undefined,
        50,
      ),
    ).resolves.toEqual({ ok: false, timedOut: true });
  });

  it('reports a non-200 response as a failure that is not a timeout', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
        undefined,
        50,
      ),
    ).resolves.toEqual({ ok: false, timedOut: false });
  });

  it('reports a network error that is not a timeout as not timed out', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
        undefined,
        50,
      ),
    ).resolves.toEqual({ ok: false, timedOut: false });
  });

  it('resolves immediately from a pinned LANGFUSE_PROJECT_ID without a network call', async () => {
    process.env.LANGFUSE_PROJECT_ID = 'pinned-project';
    const { resolveCentralProjectIdOutcome } = await loadDestinations();

    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
      ),
    ).resolves.toEqual({ ok: true, projectId: 'pinned-project' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts the shared fetch with the deployment timeout even when the only caller passes a shorter one', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'project-short-caller' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await resolveCentralProjectIdOutcome(
      'https://cloud.langfuse.com',
      'public-key',
      'secret-key',
      true,
      undefined,
      50,
    );

    // The fetch itself always uses the 10 s deployment-wide timeout; `50` only
    // bounded this call's own wait on it, below.
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('shares one fetch between a short- and a long-timeout caller: the short caller times out without touching the cache, the long caller still gets the id', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const shortCall = resolveCentralProjectIdOutcome(
      'https://cloud.langfuse.com',
      'public-key',
      'secret-key',
      true,
      undefined,
      20,
    );
    const longCall = resolveCentralProjectIdOutcome(
      'https://cloud.langfuse.com',
      'public-key',
      'secret-key',
      true,
      undefined,
      5_000,
    );

    await expect(shortCall).resolves.toEqual({ ok: false, timedOut: true });

    resolveFetch(
      new Response(JSON.stringify({ data: [{ id: 'shared-project' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(longCall).resolves.toEqual({ ok: true, projectId: 'shared-project' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The short caller's timeout never touched the cache: the resolved id is
    // served from it without a second fetch.
    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
      ),
    ).resolves.toEqual({ ok: true, projectId: 'shared-project' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the score path unaffected by a shorter prompt-sync caller sharing the same fetch', async () => {
    const { resolveCentralProjectIdOutcome, resolveCentralProjectId } = await loadDestinations();
    let resolveFetch!: (value: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const promptSyncCall = resolveCentralProjectIdOutcome(
      'https://cloud.langfuse.com',
      'public-key',
      'secret-key',
      true,
      undefined,
      20,
    );
    const scorePathCall = resolveCentralProjectId(
      'https://cloud.langfuse.com',
      'public-key',
      'secret-key',
      true,
    );

    await expect(promptSyncCall).resolves.toEqual({ ok: false, timedOut: true });

    resolveFetch(
      new Response(JSON.stringify({ data: [{ id: 'score-project' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(scorePathCall).resolves.toBe('score-project');
  });

  it('reports timedOut inside the retry window a timeout opened', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    fetchMock.mockRejectedValue(timeoutError());

    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
        undefined,
        50,
      ),
    ).resolves.toEqual({ ok: false, timedOut: true });

    fetchMock.mockClear();
    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
      ),
    ).resolves.toEqual({ ok: false, timedOut: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not timedOut inside the retry window a non-timeout failure opened', async () => {
    const { resolveCentralProjectIdOutcome } = await loadDestinations();
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
      ),
    ).resolves.toEqual({ ok: false, timedOut: false });

    fetchMock.mockClear();
    await expect(
      resolveCentralProjectIdOutcome(
        'https://cloud.langfuse.com',
        'public-key',
        'secret-key',
        true,
      ),
    ).resolves.toEqual({ ok: false, timedOut: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('resolveCentralProjectId', () => {
  beforeEach(() => {
    clearLangfuseEnv();
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    clearLangfuseEnv();
    jest.restoreAllMocks();
  });

  it('always uses the default project-lookup timeout, collapsing a timeout to undefined like any other failure', async () => {
    const { resolveCentralProjectId } = await loadDestinations();
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    fetchMock.mockRejectedValue(timeoutError());

    await expect(
      resolveCentralProjectId('https://cloud.langfuse.com', 'public-key', 'secret-key', true),
    ).resolves.toBeUndefined();
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('returns the resolved project id on success', async () => {
    const { resolveCentralProjectId } = await loadDestinations();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'project-via-wrapper' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      resolveCentralProjectId('https://cloud.langfuse.com', 'public-key', 'secret-key', true),
    ).resolves.toBe('project-via-wrapper');
  });
});
