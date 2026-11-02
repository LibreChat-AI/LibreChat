import type { TLangfusePromptListItem, TLangfusePromptListResponse } from 'librechat-data-provider';
import type { PromptCatalogSyncDeps, PromptCatalogSyncSource } from './promptCatalogSync';
import { syncLangfusePromptCatalog } from './promptCatalogSync';
import { makeSourceAuthorId } from '~/utils/author';

function textItem(name: string): TLangfusePromptListItem {
  return { name, type: 'text', versions: [1], labels: [], tags: [], lastUpdatedAt: '2026-01-01' };
}

function chatItem(name: string): TLangfusePromptListItem {
  return { name, type: 'chat', versions: [1], labels: [], tags: [], lastUpdatedAt: '2026-01-01' };
}

function listResult(
  items: TLangfusePromptListItem[],
  totalPages: number,
  page = 1,
): TLangfusePromptListResponse {
  return { items, meta: { page, limit: 100, totalItems: items.length, totalPages } };
}

function createDeps(overrides: Partial<PromptCatalogSyncDeps> = {}): PromptCatalogSyncDeps {
  return {
    listPrompts: jest.fn().mockResolvedValue(listResult([], 0)),
    promptService: { importSourceGroup: jest.fn().mockResolvedValue('created') },
    lock: {
      acquire: jest.fn().mockResolvedValue('token'),
      extend: jest.fn().mockResolvedValue(true),
      release: jest.fn().mockResolvedValue(undefined),
    },
    lockLeaseMs: 300000,
    logger: { warn: jest.fn(), error: jest.fn() },
    ...overrides,
  };
}

const source: PromptCatalogSyncSource = { destination: 'us', projectId: 'project-1' };

describe('syncLangfusePromptCatalog', () => {
  it('returns already_running and never lists when the lock is held', async () => {
    const deps = createDeps({
      lock: { ...createDeps().lock, acquire: jest.fn().mockResolvedValue(null) },
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: false, error: { code: 'already_running' } });
    expect(deps.listPrompts).not.toHaveBeenCalled();
    expect(deps.lock.release).not.toHaveBeenCalled();
  });

  it('extends the lock once per page that is followed by another page', async () => {
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('a')], 3, 1))
      .mockResolvedValueOnce(listResult([textItem('b')], 3, 2))
      .mockResolvedValueOnce(listResult([textItem('c')], 3, 3));
    const deps = createDeps({ listPrompts });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 3, unchanged: 0, skipped: 0, complete: true },
    });
    expect(listPrompts).toHaveBeenCalledTimes(3);
    expect(listPrompts).toHaveBeenNthCalledWith(1, { type: 'text', limit: 100, page: 1 });
    expect(listPrompts).toHaveBeenNthCalledWith(2, { type: 'text', limit: 100, page: 2 });
    expect(listPrompts).toHaveBeenNthCalledWith(3, { type: 'text', limit: 100, page: 3 });
    // Pages 1 and 2 are each followed by another page, so each extends once;
    // page 3 is the last, so no extend follows it.
    expect(deps.lock.extend).toHaveBeenCalledTimes(2);
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('does not extend the lock after the only page', async () => {
    const listPrompts = jest.fn().mockResolvedValueOnce(listResult([textItem('a')], 1, 1));
    const deps = createDeps({ listPrompts });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 1, unchanged: 0, skipped: 0, complete: true },
    });
    expect(deps.lock.extend).not.toHaveBeenCalled();
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('stops with lock_lost once extend fails, releasing the lock', async () => {
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('a')], 3, 1))
      .mockResolvedValueOnce(listResult([textItem('b')], 3, 2));
    const extend = jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const deps = createDeps({ listPrompts, lock: { ...createDeps().lock, extend } });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: false, error: { code: 'lock_lost' } });
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page before reaching totalPages', async () => {
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('a')], 5, 1))
      .mockResolvedValueOnce(listResult([], 5, 2));
    const deps = createDeps({ listPrompts });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 1, unchanged: 0, skipped: 0, complete: true },
    });
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('stops at the maxPages cap even when more pages are reported', async () => {
    const listPrompts = jest
      .fn()
      .mockImplementation((query: { page: number }) =>
        Promise.resolve(listResult([textItem(`item-${query.page}`)], 1000, query.page)),
      );
    const deps = createDeps({ listPrompts, maxPages: 2 });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 2, unchanged: 0, skipped: 0, complete: false },
    });
    expect(listPrompts).toHaveBeenCalledTimes(2);
  });

  it('warns once when the page cap stops the loop before totalPages', async () => {
    const listPrompts = jest
      .fn()
      .mockImplementation((query: { page: number }) =>
        Promise.resolve(listResult([textItem(`item-${query.page}`)], 5, query.page)),
      );
    const deps = createDeps({ listPrompts, maxPages: 2 });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 2, unchanged: 0, skipped: 0, complete: false },
    });
    expect(listPrompts).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[langfuse] Langfuse prompt sync stopped at the page cap',
      { maxPages: 2, totalPages: 5 },
    );
  });

  it('does not extend the lock after the page cap is reached', async () => {
    const listPrompts = jest
      .fn()
      .mockImplementation((query: { page: number }) =>
        Promise.resolve(listResult([textItem(`item-${query.page}`)], 3, query.page)),
      );
    const deps = createDeps({ listPrompts, maxPages: 1 });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 1, unchanged: 0, skipped: 0, complete: false },
    });
    expect(deps.lock.extend).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[langfuse] Langfuse prompt sync stopped at the page cap',
      { maxPages: 1, totalPages: 3 },
    );
  });

  it('respects an injected pageLimit', async () => {
    const listPrompts = jest.fn().mockResolvedValue(listResult([], 0));
    const deps = createDeps({ listPrompts, pageLimit: 25 });

    await syncLangfusePromptCatalog(source, deps);

    expect(listPrompts).toHaveBeenCalledWith({ type: 'text', limit: 25, page: 1 });
  });

  it('counts an unchanged outcome without affecting other counters', async () => {
    const importSourceGroup = jest.fn().mockResolvedValue('unchanged');
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      promptService: { importSourceGroup },
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 0, unchanged: 1, skipped: 0, complete: true },
    });
  });

  it('counts a created outcome and passes the identity, author and author name', async () => {
    const importSourceGroup = jest.fn().mockResolvedValue('created');
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      promptService: { importSourceGroup },
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 1, unchanged: 0, skipped: 0, complete: true },
    });
    expect(importSourceGroup).toHaveBeenCalledWith({
      identity: {
        sourceDestination: 'us',
        sourceProjectId: 'project-1',
        sourcePromptName: 'a',
      },
      name: 'a',
      author: makeSourceAuthorId('langfuse', 'project-1', undefined),
      authorName: 'Langfuse Sync',
    });
  });

  it('counts a skipped outcome from importSourceGroup and continues the loop', async () => {
    const importSourceGroup = jest
      .fn()
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('created');
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a'), textItem('b')], 1)),
      promptService: { importSourceGroup },
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 1, unchanged: 0, skipped: 1, complete: true },
    });
  });

  it('rejects when importSourceGroup rejects, stops paging and releases the lock once', async () => {
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('a')], 2, 1))
      .mockResolvedValueOnce(listResult([textItem('b')], 2, 2));
    const importSourceGroup = jest.fn().mockRejectedValue(new Error('boom'));
    const deps = createDeps({ listPrompts, promptService: { importSourceGroup } });

    await expect(syncLangfusePromptCatalog(source, deps)).rejects.toThrow('boom');
    expect(listPrompts).toHaveBeenCalledTimes(1);
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('warns and counts a non-text item as skipped', async () => {
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([chatItem('chat-1')], 1)),
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 0, unchanged: 0, skipped: 1, complete: true },
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('chat-1'));
    expect(deps.promptService.importSourceGroup).not.toHaveBeenCalled();
  });

  it('counts a name repeated across pages only once', async () => {
    const importSourceGroup = jest.fn().mockResolvedValue('created');
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('dup')], 2, 1))
      .mockResolvedValueOnce(listResult([textItem('dup')], 2, 2));
    const deps = createDeps({ listPrompts, promptService: { importSourceGroup } });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 1, unchanged: 0, skipped: 0, complete: true },
    });
    expect(importSourceGroup).toHaveBeenCalledTimes(1);
  });

  it('releases the lock when listPrompts throws, and the error still propagates', async () => {
    class LangfusePromptRequestError extends Error {
      code = 'upstream';
    }
    const listPrompts = jest.fn().mockRejectedValue(new LangfusePromptRequestError('boom'));
    const deps = createDeps({ listPrompts });

    await expect(syncLangfusePromptCatalog(source, deps)).rejects.toThrow('boom');
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('resolves ok with counts when lock.release rejects after a successful run', async () => {
    const release = jest.fn().mockRejectedValue(new Error('release failed'));
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      lock: { ...createDeps().lock, release },
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({
      ok: true,
      value: { created: 1, unchanged: 0, skipped: 0, complete: true },
    });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not release'),
      expect.any(Error),
    );
  });

  it('seeds the author id from the project id alone when no tenant is given', async () => {
    const importSourceGroup = jest.fn().mockResolvedValue('created');
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      promptService: { importSourceGroup },
    });

    await syncLangfusePromptCatalog({ destination: 'us', projectId: 'project-1' }, deps);

    expect(importSourceGroup).toHaveBeenCalledWith(
      expect.objectContaining({ author: makeSourceAuthorId('langfuse', 'project-1', undefined) }),
    );
  });

  it('seeds a different author id per tenant for the same project', async () => {
    const importSourceGroup = jest.fn().mockResolvedValue('created');
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      promptService: { importSourceGroup },
    });

    await syncLangfusePromptCatalog(
      { destination: 'us', projectId: 'project-1', tenantId: 'tenant-a' },
      deps,
    );

    expect(importSourceGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        author: makeSourceAuthorId('langfuse', 'project-1', 'tenant-a'),
      }),
    );
    expect(importSourceGroup).not.toHaveBeenCalledWith(
      expect.objectContaining({ author: makeSourceAuthorId('langfuse', 'project-1', undefined) }),
    );
  });

  it('uses the lock key prompt-sync:langfuse:<tenantId>, empty for single-tenant', async () => {
    const deps = createDeps();

    await syncLangfusePromptCatalog({ destination: 'us', projectId: 'project-1' }, deps);
    expect(deps.lock.acquire).toHaveBeenCalledWith('prompt-sync:langfuse:', deps.lockLeaseMs);

    const tenantDeps = createDeps();
    await syncLangfusePromptCatalog(
      { destination: 'us', projectId: 'project-1', tenantId: 'tenant-a' },
      tenantDeps,
    );
    expect(tenantDeps.lock.acquire).toHaveBeenCalledWith(
      'prompt-sync:langfuse:tenant-a',
      tenantDeps.lockLeaseMs,
    );
  });

  it('always passes the Langfuse Sync author name', async () => {
    const importSourceGroup = jest.fn().mockResolvedValue('created');
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      promptService: { importSourceGroup },
    });

    await syncLangfusePromptCatalog(source, deps);

    expect(importSourceGroup).toHaveBeenCalledWith(
      expect.objectContaining({ authorName: 'Langfuse Sync' }),
    );
  });
});
