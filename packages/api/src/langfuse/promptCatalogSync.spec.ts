import type { PromptCatalogSyncDeps, PromptCatalogSyncSource } from './promptCatalogSync';
import type { LangfusePromptListItem, LangfusePromptListResult } from './prompts';
import { syncLangfusePromptCatalog } from './promptCatalogSync';
import { makeSourceAuthorId } from '~/utils/author';

function textItem(name: string): LangfusePromptListItem {
  return { name, type: 'text', versions: [1], labels: [], tags: [], lastUpdatedAt: '2026-01-01' };
}

function chatItem(name: string): LangfusePromptListItem {
  return { name, type: 'chat', versions: [1], labels: [], tags: [], lastUpdatedAt: '2026-01-01' };
}

function listResult(
  items: LangfusePromptListItem[],
  totalPages: number,
  page = 1,
): LangfusePromptListResult {
  return { items, meta: { page, limit: 100, totalItems: items.length, totalPages } };
}

function createDeps(overrides: Partial<PromptCatalogSyncDeps> = {}): PromptCatalogSyncDeps {
  return {
    listPrompts: jest.fn().mockResolvedValue(listResult([], 0)),
    findPromptGroup: jest.fn().mockResolvedValue(null),
    createPromptGroup: jest.fn().mockResolvedValue({ _id: 'group-1' }),
    isDuplicateKeyError: jest.fn().mockReturnValue(false),
    isValidationError: jest.fn().mockReturnValue(false),
    grantPublicViewer: jest.fn().mockResolvedValue(undefined),
    deletePromptGroup: jest.fn().mockResolvedValue(undefined),
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

    expect(result).toEqual({ ok: true, value: { created: 3, unchanged: 0, skipped: 0 } });
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

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 0 } });
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

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 0 } });
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

    expect(result).toEqual({ ok: true, value: { created: 2, unchanged: 0, skipped: 0 } });
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

    expect(result).toEqual({ ok: true, value: { created: 2, unchanged: 0, skipped: 0 } });
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

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 0 } });
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

  it('counts a found match as unchanged without creating or granting', async () => {
    const findPromptGroup = jest.fn().mockResolvedValue({ _id: 'existing' });
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      findPromptGroup,
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: true, value: { created: 0, unchanged: 1, skipped: 0 } });
    expect(deps.createPromptGroup).not.toHaveBeenCalled();
    expect(deps.grantPublicViewer).not.toHaveBeenCalled();
  });

  it('creates and grants a new group on a miss', async () => {
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 0 } });
    expect(deps.createPromptGroup).toHaveBeenCalledWith({
      sourceDestination: 'us',
      sourceProjectId: 'project-1',
      sourcePromptName: 'a',
      name: 'a',
      author: makeSourceAuthorId('langfuse', 'project-1', undefined),
      authorName: 'Langfuse Sync',
    });
    expect(deps.grantPublicViewer).toHaveBeenCalledWith('group-1');
  });

  it('counts a duplicate-key create as unchanged without granting', async () => {
    const createPromptGroup = jest.fn().mockRejectedValue(new Error('E11000'));
    const isDuplicateKeyError = jest.fn().mockReturnValue(true);
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      createPromptGroup,
      isDuplicateKeyError,
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: true, value: { created: 0, unchanged: 1, skipped: 0 } });
    expect(deps.grantPublicViewer).not.toHaveBeenCalled();
  });

  it('rejects when create fails with an unexpected error, releasing the lock once', async () => {
    const createPromptGroup = jest.fn().mockRejectedValueOnce(new Error('boom'));
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      createPromptGroup,
    });

    await expect(syncLangfusePromptCatalog(source, deps)).rejects.toThrow('boom');
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('counts a validation error on create as skipped and continues the loop', async () => {
    const createPromptGroup = jest
      .fn()
      .mockRejectedValueOnce(new Error('invalid'))
      .mockResolvedValueOnce({ _id: 'group-2' });
    const isValidationError = jest.fn().mockReturnValue(true);
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a'), textItem('b')], 1)),
      createPromptGroup,
      isValidationError,
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 1 } });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('validation'),
      'a',
      expect.any(Error),
    );
  });

  it('rolls back and rejects with the original grant error when the grant throws', async () => {
    const grantPublicViewer = jest.fn().mockRejectedValue(new Error('grant failed'));
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      grantPublicViewer,
    });

    await expect(syncLangfusePromptCatalog(source, deps)).rejects.toThrow('grant failed');
    expect(deps.deletePromptGroup).toHaveBeenCalledWith('group-1');
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('still rejects with the original grant error and error-logs when the rollback delete also throws', async () => {
    const grantPublicViewer = jest.fn().mockRejectedValue(new Error('grant failed'));
    const deletePromptGroup = jest.fn().mockRejectedValue(new Error('delete failed'));
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
      grantPublicViewer,
      deletePromptGroup,
    });

    await expect(syncLangfusePromptCatalog(source, deps)).rejects.toThrow('grant failed');
    expect(deps.logger.error).toHaveBeenCalledTimes(2);
  });

  it('warns and counts a non-text item as skipped', async () => {
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([chatItem('chat-1')], 1)),
    });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: true, value: { created: 0, unchanged: 0, skipped: 1 } });
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('chat-1'));
    expect(deps.findPromptGroup).not.toHaveBeenCalled();
  });

  it('counts a name repeated across pages only once', async () => {
    const listPrompts = jest
      .fn()
      .mockResolvedValueOnce(listResult([textItem('dup')], 2, 1))
      .mockResolvedValueOnce(listResult([textItem('dup')], 2, 2));
    const deps = createDeps({ listPrompts });

    const result = await syncLangfusePromptCatalog(source, deps);

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 0 } });
    expect(deps.findPromptGroup).toHaveBeenCalledTimes(1);
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

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 0 } });
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not release'),
      expect.any(Error),
    );
  });

  it('seeds the author id from the project id alone when no tenant is given', async () => {
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
    });

    await syncLangfusePromptCatalog({ destination: 'us', projectId: 'project-1' }, deps);

    expect(deps.createPromptGroup).toHaveBeenCalledWith(
      expect.objectContaining({ author: makeSourceAuthorId('langfuse', 'project-1', undefined) }),
    );
  });

  it('seeds a different author id per tenant for the same project', async () => {
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
    });

    await syncLangfusePromptCatalog(
      { destination: 'us', projectId: 'project-1', tenantId: 'tenant-a' },
      deps,
    );

    expect(deps.createPromptGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        author: makeSourceAuthorId('langfuse', 'project-1', 'tenant-a'),
      }),
    );
    expect(deps.createPromptGroup).not.toHaveBeenCalledWith(
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
    const deps = createDeps({
      listPrompts: jest.fn().mockResolvedValue(listResult([textItem('a')], 1)),
    });

    await syncLangfusePromptCatalog(source, deps);

    expect(deps.createPromptGroup).toHaveBeenCalledWith(
      expect.objectContaining({ authorName: 'Langfuse Sync' }),
    );
  });
});
