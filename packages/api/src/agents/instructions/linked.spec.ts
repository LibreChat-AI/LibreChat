import type { FiltersConfig, AgentInstructionsPrompt } from 'librechat-data-provider';
import type { LinkedInstructionsCache, LinkedInstructionsLogger } from './linked';
import type { PromptService, ResolvedPrompt } from '~/prompts';
import { createLinkedInstructionsResolver, invalidateLinkedPrompt } from './linked';
import { ContentTraversalLimitError } from '~/protection/adapters/nested';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';

jest.mock('~/middleware/modelBoundContent', () => ({
  ...jest.requireActual('~/middleware/modelBoundContent'),
  assertModelBoundContent: jest.fn(),
}));

const mockAssertModelBoundContent = assertModelBoundContent as jest.MockedFunction<
  typeof assertModelBoundContent
>;
const actualAssertModelBoundContent = jest.requireActual('~/middleware/modelBoundContent')
  .assertModelBoundContent as typeof assertModelBoundContent;

/** Map-based cache with real per-entry TTL, matching the Keyv contract the resolver relies on. */
class FakeCache implements LinkedInstructionsCache {
  private store = new Map<string, { value: unknown; expiresAt?: number }>();

  async get(key: string): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt != null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: unknown, ttl?: number): Promise<boolean> {
    this.store.set(key, { value, expiresAt: ttl ? Date.now() + ttl : undefined });
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  get size(): number {
    return this.store.size;
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
}

const blockingFilters: FiltersConfig = {
  prompts: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-[A-Z]+' }],
      fields: ['text'],
    },
  },
};

/** Blocks only via the agent-instructions policy — `prompts.pii` is untouched — so a
 *  finding here can only come from the `assertModelBoundContent({ agents: [...] })`
 *  check, never from `inspectPromptContent`. */
const agentInstructionsBlockingFilters: FiltersConfig = {
  agentInstructions: {
    pii: {
      starterPatterns: [],
      customPatterns: [{ id: 'secret', label: 'secret value', regex: 'SECRET-[A-Z]+' }],
      fields: ['instructions'],
    },
  },
};

const groupId = '507f1f77bcf86cd799439011';
const promptId = '507f1f77bcf86cd799439012';

const productionLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'production' },
};

const exactLink: AgentInstructionsPrompt = {
  source: 'native',
  groupId,
  selection: { type: 'exact', promptId },
};

function makeResolvedPrompt(overrides: Partial<ResolvedPrompt> = {}): ResolvedPrompt {
  return {
    groupId,
    promptId,
    prompt: 'You are a helpful assistant.',
    type: 'text',
    ...overrides,
  };
}

function makeLogger(): LinkedInstructionsLogger & { warn: jest.Mock; error: jest.Mock } {
  return { warn: jest.fn(), error: jest.fn() };
}

function makePromptService(
  overrides: Partial<Pick<PromptService, 'resolvePrompt' | 'incrementPromptGroupUsage'>> = {},
): Pick<PromptService, 'resolvePrompt' | 'incrementPromptGroupUsage'> {
  return {
    resolvePrompt: jest.fn().mockResolvedValue({ ok: true, value: makeResolvedPrompt() }),
    incrementPromptGroupUsage: jest.fn().mockResolvedValue({ numberOfGenerations: 1 }),
    ...overrides,
  };
}

/** Flushes pending microtasks (used to let fire-and-forget calls settle). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('createLinkedInstructionsResolver', () => {
  beforeEach(() => {
    mockAssertModelBoundContent.mockImplementation(actualAssertModelBoundContent);
  });

  it('resolves the production selection on a cache miss and caches the result', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink });

    expect(result).toEqual({
      status: 'resolved',
      prompt: 'You are a helpful assistant.',
      facts: { source: 'native', groupId, promptId },
    });
    expect(promptService.resolvePrompt).toHaveBeenCalledWith({
      groupId,
      selection: { type: 'production' },
      filters: undefined,
    });
    await expect(cache.get(`native:${groupId}:production`)).resolves.toMatchObject({
      groupId,
      promptId,
      prompt: 'You are a helpful assistant.',
    });
  });

  it('resolves an exact revision selection and caches it under the exact key', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: exactLink });

    expect(result.status).toBe('resolved');
    expect(promptService.resolvePrompt).toHaveBeenCalledWith({
      groupId,
      selection: { type: 'exact', promptId },
      filters: undefined,
    });
    await expect(cache.get(`native:${groupId}:exact:${promptId}`)).resolves.toBeDefined();
  });

  it('serves a cache hit without calling resolvePrompt', async () => {
    const cache = new FakeCache();
    await cache.set(`native:${groupId}:production`, {
      groupId,
      promptId,
      prompt: 'Cached instructions',
      type: 'text',
    });
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink });

    expect(result).toEqual({
      status: 'resolved',
      prompt: 'Cached instructions',
      facts: { source: 'native', groupId, promptId },
    });
    expect(promptService.resolvePrompt).not.toHaveBeenCalled();
  });

  it('re-inspects a cache hit and blocks it when current prompt filters now block the content', async () => {
    const cache = new FakeCache();
    await cache.set(`native:${groupId}:production`, {
      groupId,
      promptId,
      prompt: 'Contains PRIVATE-SECRET marker',
      type: 'text',
    });
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink, filters: blockingFilters });

    expect(result).toEqual({ status: 'unavailable', reason: 'blocked_content' });
    expect(promptService.resolvePrompt).not.toHaveBeenCalled();
  });

  it('blocks a cache hit under the agent-instructions policy alone (prompts.pii is untouched)', async () => {
    const cache = new FakeCache();
    await cache.set(`native:${groupId}:production`, {
      groupId,
      promptId,
      prompt: 'Contains SECRET-VALUE marker',
      type: 'text',
    });
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({
      link: productionLink,
      filters: agentInstructionsBlockingFilters,
    });

    expect(result).toEqual({ status: 'unavailable', reason: 'blocked_content' });
    expect(promptService.resolvePrompt).not.toHaveBeenCalled();
  });

  it('blocks a fresh resolution under the agent-instructions policy alone (prompts.pii is untouched)', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: true,
        value: makeResolvedPrompt({ prompt: 'Contains SECRET-VALUE marker' }),
      }),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({
      link: productionLink,
      filters: agentInstructionsBlockingFilters,
    });

    expect(result).toEqual({ status: 'unavailable', reason: 'blocked_content' });
    // Blocked before the cache write: a violation is never cached.
    await expect(cache.get(`native:${groupId}:production`)).resolves.toBeUndefined();
  });

  it('does not re-run the prompt-library policy on a fresh resolution, leaving it to resolvePrompt', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: true,
        value: makeResolvedPrompt({ prompt: 'Contains PRIVATE-SECRET marker' }),
      }),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink, filters: blockingFilters });

    expect(result.status).toBe('resolved');
  });

  it('maps any content-policy error the content check throws to blocked_content, not just ContentFilterError', async () => {
    // A traversal-limit error is a content-policy error `isContentFilterError`
    // recognizes, but not an `instanceof ContentFilterError` — this is exactly
    // the gap `isContentFilterError` closes over the old `instanceof` check.
    mockAssertModelBoundContent.mockImplementation(() => {
      throw new ContentTraversalLimitError();
    });
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink });

    expect(result).toEqual({ status: 'unavailable', reason: 'blocked_content' });
  });

  it('maps an error the content-policy check does not recognize to reason "error" instead of rejecting', async () => {
    mockAssertModelBoundContent.mockImplementation(() => {
      throw new Error('unexpected content-policy failure');
    });
    const cache = new FakeCache();
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    await expect(resolver({ link: productionLink })).resolves.toEqual({
      status: 'unavailable',
      reason: 'error',
    });
    expect(logger.error).toHaveBeenCalledWith(
      '[linkedInstructions] Content-policy check failed',
      expect.objectContaining({ groupId, errorName: 'Error' }),
    );
  });

  it('fetches fresh content after the cached entry expires', async () => {
    jest.useFakeTimers();
    try {
      const cache = new FakeCache();
      const promptService = makePromptService({
        resolvePrompt: jest
          .fn()
          .mockResolvedValueOnce({ ok: true, value: makeResolvedPrompt({ prompt: 'first' }) })
          .mockResolvedValueOnce({ ok: true, value: makeResolvedPrompt({ prompt: 'second' }) }),
      });
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      const first = await resolver({
        link: productionLink,
        config: { native: { cacheTtlMs: 1000 } },
      });
      expect(first).toMatchObject({ status: 'resolved', prompt: 'first' });

      jest.advanceTimersByTime(1001);

      const second = await resolver({
        link: productionLink,
        config: { native: { cacheTtlMs: 1000 } },
      });
      expect(second).toMatchObject({ status: 'resolved', prompt: 'second' });
      expect(promptService.resolvePrompt).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not read or write the cache when cacheTtlMs is 0', async () => {
    const cache = new FakeCache();
    const getSpy = jest.spyOn(cache, 'get');
    const setSpy = jest.spyOn(cache, 'set');
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({
      link: productionLink,
      config: { native: { cacheTtlMs: 0 } },
    });

    expect(result.status).toBe('resolved');
    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('falls through to resolvePrompt and still resolves when the cache read errors', async () => {
    const cache = new FakeCache();
    const getSpy = jest.spyOn(cache, 'get').mockRejectedValue(new Error('cache unavailable'));
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(promptService.resolvePrompt).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 'resolved',
      prompt: 'You are a helpful assistant.',
      facts: { source: 'native', groupId, promptId },
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[linkedInstructions] Cache read failed; resolving without cache',
      expect.objectContaining({ groupId, errorName: 'Error' }),
    );
  });

  it('bounds the cache-read phase so a hung cache read still leaves resolvePrompt room to answer from the database', async () => {
    jest.useFakeTimers();
    try {
      const cache = new FakeCache();
      jest.spyOn(cache, 'get').mockReturnValue(new Promise(() => {})); // never settles
      const promptService = makePromptService(); // resolvePrompt settles immediately
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      const pending = resolver({ link: productionLink, config: { timeoutMs: 200 } });
      // The cache-read phase is capped at min(250ms, timeoutMs / 4) = 50ms here, well
      // under the 200ms deadline — advancing past just that cap (not the full
      // deadline) is enough for the hung cache read to time out, fall through to
      // resolvePrompt, and settle from the database with ~150ms of budget to spare.
      await jest.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({
        status: 'resolved',
        prompt: 'You are a helpful assistant.',
        facts: { source: 'native', groupId, promptId },
      });
      expect(promptService.resolvePrompt).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        '[linkedInstructions] Cache read failed; resolving without cache',
        expect.objectContaining({ groupId, errorName: 'LinkedInstructionsTimeoutError' }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('still bounds total latency to ~timeoutMs when both the cache read and resolvePrompt hang', async () => {
    jest.useFakeTimers();
    try {
      const cache = new FakeCache();
      jest.spyOn(cache, 'get').mockReturnValue(new Promise(() => {}));
      const promptService = makePromptService({
        // Also hangs, so this call can only settle via the shared-deadline timeout,
        // not because the mock happened to resolve fast.
        resolvePrompt: jest.fn().mockReturnValue(new Promise(() => {})),
      });
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      const pending = resolver({ link: productionLink, config: { timeoutMs: 50 } });
      // The capped cache-read phase (min(250ms, 50/4) = 12.5ms) times out first;
      // the remaining ~37.5ms of the shared deadline is left for resolvePrompt,
      // which also hangs and times out in turn.
      await jest.advanceTimersByTimeAsync(50);

      await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns unavailable "timeout" when resolvePrompt does not settle in time', async () => {
    jest.useFakeTimers();
    try {
      const cache = new FakeCache();
      const promptService = makePromptService({
        resolvePrompt: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ ok: true, value: makeResolvedPrompt() }), 200);
            }),
        ),
      });
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      const pending = resolver({
        link: productionLink,
        config: { timeoutMs: 10 },
      });
      await jest.advanceTimersByTimeAsync(11);

      await expect(pending).resolves.toEqual({ status: 'unavailable', reason: 'timeout' });
      // Let the still-pending mock's own timer fire and resolve harmlessly.
      await jest.advanceTimersByTimeAsync(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns unavailable "error" when resolvePrompt throws', async () => {
    const cache = new FakeCache();
    const promptService = makePromptService({
      resolvePrompt: jest.fn().mockRejectedValue(new Error('adapter exploded')),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const result = await resolver({ link: productionLink });

    expect(result).toEqual({ status: 'unavailable', reason: 'error' });
    expect(logger.error).toHaveBeenCalledWith(
      '[linkedInstructions] resolvePrompt failed',
      expect.objectContaining({ groupId, errorName: 'Error' }),
    );
  });

  it('maps unavailable_selection and blocked_content service errors', async () => {
    const cache = new FakeCache();
    const logger = makeLogger();

    const unavailableService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: false,
        error: { type: 'unavailable_selection', reason: 'production' },
      }),
    });
    const unavailableResolver = createLinkedInstructionsResolver({
      promptService: unavailableService,
      cache,
      logger,
    });
    await expect(unavailableResolver({ link: productionLink })).resolves.toEqual({
      status: 'unavailable',
      reason: 'unavailable_selection',
    });

    const blockedService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: false,
        error: { type: 'blocked_content', finding: { source: 'prompt' } },
      }),
    });
    const blockedResolver = createLinkedInstructionsResolver({
      promptService: blockedService,
      cache: new FakeCache(),
      logger,
    });
    await expect(blockedResolver({ link: productionLink })).resolves.toEqual({
      status: 'unavailable',
      reason: 'blocked_content',
    });
  });

  it('throws the abort reason when already aborted before any work starts', async () => {
    const cache = new FakeCache();
    const getSpy = jest.spyOn(cache, 'get');
    const setSpy = jest.spyOn(cache, 'set');
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const controller = new AbortController();
    controller.abort();

    await expect(resolver({ link: productionLink, signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );
    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    expect(promptService.resolvePrompt).not.toHaveBeenCalled();
  });

  it('throws the abort reason when aborted mid-flight and never writes the cache', async () => {
    const cache = new FakeCache();
    const setSpy = jest.spyOn(cache, 'set');
    jest.spyOn(cache, 'get').mockReturnValue(new Promise(() => {}));
    const promptService = makePromptService();
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    const controller = new AbortController();
    const pending = resolver({
      link: productionLink,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBe(controller.signal.reason);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('never logs prompt text', async () => {
    const secretMarker = 'DO-NOT-LOG-THIS-PROMPT-BODY';
    const cache = new FakeCache();
    jest.spyOn(cache, 'set').mockRejectedValue(new Error(secretMarker));
    const promptService = makePromptService({
      resolvePrompt: jest.fn().mockResolvedValue({
        ok: true,
        value: makeResolvedPrompt({ prompt: secretMarker }),
      }),
    });
    const logger = makeLogger();
    const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

    await resolver({ link: productionLink });
    await flush();

    const allLogCalls = [...logger.warn.mock.calls, ...logger.error.mock.calls];
    for (const call of allLogCalls) {
      expect(JSON.stringify(call)).not.toContain(secretMarker);
    }
  });

  describe('tenant scoping', () => {
    it('scopes the cache key by tenant so two tenants never share an entry', async () => {
      const { tenantStorage } = await import('@librechat/data-schemas');
      const cache = new FakeCache();
      const promptService = makePromptService();
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      await tenantStorage.run({ tenantId: 'tenant-a' }, () => resolver({ link: productionLink }));
      await tenantStorage.run({ tenantId: 'tenant-b' }, () => resolver({ link: productionLink }));

      const keys = cache.keys();
      expect(keys).toContain(`native:${groupId}:production:tenant-a`);
      expect(keys).toContain(`native:${groupId}:production:tenant-b`);
      expect(keys).not.toContain(`native:${groupId}:production`);
      // Neither tenant's cached entry satisfied the other's read.
      expect(promptService.resolvePrompt).toHaveBeenCalledTimes(2);
    });

    it('reuses the same key across calls within one tenant', async () => {
      const { tenantStorage } = await import('@librechat/data-schemas');
      const cache = new FakeCache();
      const promptService = makePromptService();
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      await tenantStorage.run({ tenantId: 'tenant-a' }, async () => {
        await resolver({ link: productionLink });
        await resolver({ link: productionLink });
      });

      expect(promptService.resolvePrompt).toHaveBeenCalledTimes(1);
    });
  });

  describe('recordUse', () => {
    it('does not record usage on its own when resolve succeeds', async () => {
      const cache = new FakeCache();
      const promptService = makePromptService();
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      const result = await resolver({ link: productionLink });
      await flush();

      expect(result.status).toBe('resolved');
      expect(promptService.incrementPromptGroupUsage).not.toHaveBeenCalled();
    });

    it('records a usage generation for the given facts, fire-and-forget', async () => {
      const cache = new FakeCache();
      const promptService = makePromptService();
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      resolver.recordUse({ source: 'native', groupId, promptId });
      await flush();

      expect(promptService.incrementPromptGroupUsage).toHaveBeenCalledTimes(1);
      expect(promptService.incrementPromptGroupUsage).toHaveBeenCalledWith(groupId);
    });

    it('logs but does not throw when incrementPromptGroupUsage fails', async () => {
      const cache = new FakeCache();
      const promptService = makePromptService({
        incrementPromptGroupUsage: jest.fn().mockRejectedValue(new Error('usage boom')),
      });
      const logger = makeLogger();
      const resolver = createLinkedInstructionsResolver({ promptService, cache, logger });

      expect(() => resolver.recordUse({ source: 'native', groupId, promptId })).not.toThrow();
      await flush();

      expect(logger.warn).toHaveBeenCalledWith(
        '[linkedInstructions] Failed to record prompt group usage',
        expect.objectContaining({ groupId, errorName: 'Error' }),
      );
    });
  });

  describe('invalidateLinkedPrompt', () => {
    it('clears only the production key when no promptIds are given', async () => {
      const cache = new FakeCache();
      await cache.set(`native:${groupId}:production`, 'cached');
      await cache.set(`native:${groupId}:exact:${promptId}`, 'cached');

      await invalidateLinkedPrompt(cache, groupId, []);

      await expect(cache.get(`native:${groupId}:production`)).resolves.toBeUndefined();
      await expect(cache.get(`native:${groupId}:exact:${promptId}`)).resolves.toBe('cached');
    });

    it('clears the production key plus one exact key per promptId', async () => {
      const otherPromptId = '507f1f77bcf86cd799439013';
      const cache = new FakeCache();
      await cache.set(`native:${groupId}:production`, 'cached');
      await cache.set(`native:${groupId}:exact:${promptId}`, 'cached');
      await cache.set(`native:${groupId}:exact:${otherPromptId}`, 'cached');

      await invalidateLinkedPrompt(cache, groupId, [promptId, otherPromptId]);

      expect(cache.keys()).toEqual([]);
    });

    it('does not disturb another group sharing the same cache', async () => {
      const otherGroupId = '507f1f77bcf86cd799439099';
      const cache = new FakeCache();
      await cache.set(`native:${groupId}:production`, 'cached');
      await cache.set(`native:${otherGroupId}:production`, 'cached');

      await invalidateLinkedPrompt(cache, groupId, []);

      await expect(cache.get(`native:${groupId}:production`)).resolves.toBeUndefined();
      await expect(cache.get(`native:${otherGroupId}:production`)).resolves.toBe('cached');
    });

    describe('tenant scoping', () => {
      it('clears only the calling tenant entry when two tenants cached the same group', async () => {
        const { tenantStorage } = await import('@librechat/data-schemas');
        const cache = new FakeCache();
        await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          cache.set(`native:${groupId}:production:tenant-a`, 'cached'),
        );
        await tenantStorage.run({ tenantId: 'tenant-b' }, () =>
          cache.set(`native:${groupId}:production:tenant-b`, 'cached'),
        );

        await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
          invalidateLinkedPrompt(cache, groupId, []),
        );

        expect(cache.keys()).toEqual([`native:${groupId}:production:tenant-b`]);
      });
    });
  });
});
