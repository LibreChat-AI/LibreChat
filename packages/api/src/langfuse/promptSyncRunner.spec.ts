import type { TLangfusePromptListItem, TLangfusePromptListResponse } from 'librechat-data-provider';
import type { LangfusePromptSyncRunnerDeps, LangfusePromptSyncRequest } from './promptSyncRunner';
import type { DistributedLock } from '~/cache/lock';
import { createLangfusePromptSyncRunner } from './promptSyncRunner';

function textItem(name: string): TLangfusePromptListItem {
  return { name, type: 'text', versions: [1], labels: [], tags: [], lastUpdatedAt: '2026-01-01' };
}

function listResult(
  items: TLangfusePromptListItem[],
  totalPages: number,
  page = 1,
): TLangfusePromptListResponse {
  return { items, meta: { page, limit: 100, totalItems: items.length, totalPages } };
}

function createFakeLock(overrides: Partial<DistributedLock> = {}): DistributedLock {
  return {
    acquire: jest.fn().mockResolvedValue('token-1'),
    extend: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createDeps(overrides: Partial<LangfusePromptSyncRunnerDeps> = {}) {
  return {
    lock: createFakeLock(),
    promptService: { importSourceGroup: jest.fn().mockResolvedValue('created') },
    logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

function createRequest(
  overrides: Partial<LangfusePromptSyncRequest> = {},
): LangfusePromptSyncRequest {
  return {
    source: { destination: 'eu', projectId: 'project-1', tenantId: 't1' },
    listPrompts: jest.fn().mockResolvedValue(listResult([textItem('greeting')], 1)),
    lockLeaseMs: 300_000,
    maxPages: 50,
    ...overrides,
  };
}

describe('createLangfusePromptSyncRunner', () => {
  it('acquires and extends the lock with the per-request lease', async () => {
    const deps = createDeps();
    const run = createLangfusePromptSyncRunner(deps);
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('a')], 2, 1))
      .mockResolvedValueOnce(listResult([textItem('b')], 2, 2));

    await run(createRequest({ listPrompts, lockLeaseMs: 120_000 }));

    expect(deps.lock.acquire).toHaveBeenCalledWith('prompt-sync:langfuse:t1', 120_000);
    expect(deps.lock.extend).toHaveBeenCalledWith('prompt-sync:langfuse:t1', 'token-1', 120_000);
  });

  it('stops paging at the per-request maxPages', async () => {
    const deps = createDeps();
    const run = createLangfusePromptSyncRunner(deps);
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('a')], 5, 1))
      .mockResolvedValueOnce(listResult([textItem('b')], 5, 2))
      .mockResolvedValueOnce(listResult([textItem('c')], 5, 3));

    const result = await run(createRequest({ listPrompts, maxPages: 2 }));

    expect(result).toEqual({
      ok: true,
      value: { created: 2, unchanged: 0, skipped: 0, complete: false },
    });
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(listPrompts).toHaveBeenNthCalledWith(1, { type: 'text', limit: 100, page: 1 });
    expect(listPrompts).toHaveBeenNthCalledWith(2, { type: 'text', limit: 100, page: 2 });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('page cap'),
      expect.objectContaining({ maxPages: 2, totalPages: 5 }),
    );
  });

  it('uses the per-request listPrompts for every page and keeps the lock across requests', async () => {
    const deps = createDeps();
    const run = createLangfusePromptSyncRunner(deps);
    const first = createRequest({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
    });
    const second = createRequest({
      source: { destination: 'us', projectId: 'project-2' },
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('b')], 1)),
    });

    await run(first);
    await run(second);

    expect(first.listPrompts).toHaveBeenCalledTimes(1);
    expect(second.listPrompts).toHaveBeenCalledTimes(1);
    expect(deps.lock.acquire).toHaveBeenNthCalledWith(1, 'prompt-sync:langfuse:t1', 300_000);
    expect(deps.lock.acquire).toHaveBeenNthCalledWith(2, 'prompt-sync:langfuse:', 300_000);
  });

  it('returns already_running without listing when the lock is held', async () => {
    const deps = createDeps({
      lock: createFakeLock({ acquire: jest.fn().mockResolvedValue(null) }),
    });
    const run = createLangfusePromptSyncRunner(deps);
    const request = createRequest();

    const result = await run(request);

    expect(result).toEqual({ ok: false, error: { code: 'already_running' } });
    expect(request.listPrompts).not.toHaveBeenCalled();
    expect(deps.lock.release).not.toHaveBeenCalled();
  });

  it('passes a rejection from importSourceGroup to the caller', async () => {
    const deps = createDeps({
      promptService: { importSourceGroup: jest.fn().mockRejectedValue(new Error('boom')) },
    });
    const run = createLangfusePromptSyncRunner(deps);

    await expect(run(createRequest())).rejects.toThrow('boom');
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });
});
