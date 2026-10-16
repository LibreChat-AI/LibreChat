import type { LangfusePromptSyncRunnerDeps, LangfusePromptSyncRequest } from './promptSyncRunner';
import type { LangfusePromptListItem, LangfusePromptListResult } from './prompts';
import type { DistributedLock } from '~/cache/lock';
import { createLangfusePromptSyncRunner } from './promptSyncRunner';
import { makeSourceAuthorId } from '~/utils/author';

function textItem(name: string): LangfusePromptListItem {
  return { name, type: 'text', versions: [1], labels: [], tags: [], lastUpdatedAt: '2026-01-01' };
}

function listResult(
  items: LangfusePromptListItem[],
  totalPages: number,
  page = 1,
): LangfusePromptListResult {
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
    findLangfusePromptGroup: jest.fn().mockResolvedValue(null),
    createLangfusePromptGroup: jest.fn().mockResolvedValue({ _id: 'group-1' }),
    deletePromptGroup: jest.fn().mockResolvedValue({ message: 'Prompt group deleted' }),
    grantPermission: jest.fn().mockResolvedValue(undefined),
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
  it('creates a pointer group for a new prompt and grants the PUBLIC viewer as the system user', async () => {
    const deps = createDeps();
    const run = createLangfusePromptSyncRunner(deps);

    const result = await run(createRequest());

    expect(result).toEqual({ ok: true, value: { created: 1, unchanged: 0, skipped: 0 } });
    expect(deps.findLangfusePromptGroup).toHaveBeenCalledWith({
      sourceDestination: 'eu',
      sourceProjectId: 'project-1',
      sourcePromptName: 'greeting',
    });
    expect(deps.createLangfusePromptGroup).toHaveBeenCalledWith({
      name: 'greeting',
      author: makeSourceAuthorId('langfuse', 'project-1', 't1'),
      authorName: 'Langfuse Sync',
      sourceDestination: 'eu',
      sourceProjectId: 'project-1',
      sourcePromptName: 'greeting',
    });
    expect(deps.grantPermission).toHaveBeenCalledTimes(1);
    expect(deps.grantPermission).toHaveBeenCalledWith({
      principalType: 'public',
      principalId: null,
      resourceType: 'promptGroup',
      resourceId: 'group-1',
      accessRoleId: 'promptGroup_viewer',
      grantedBy: '000000000000000000000000',
    });
    expect(deps.deletePromptGroup).not.toHaveBeenCalled();
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('counts an existing group as unchanged without creating or granting', async () => {
    const deps = createDeps({
      findLangfusePromptGroup: jest.fn().mockResolvedValue({ _id: 'existing-id' }),
    });
    const run = createLangfusePromptSyncRunner(deps);

    const result = await run(createRequest());

    expect(result).toEqual({ ok: true, value: { created: 0, unchanged: 1, skipped: 0 } });
    expect(deps.createLangfusePromptGroup).not.toHaveBeenCalled();
    expect(deps.grantPermission).not.toHaveBeenCalled();
  });

  it('maps a duplicate-key error (code 11000) on create to unchanged without granting', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    const deps = createDeps({
      createLangfusePromptGroup: jest.fn().mockRejectedValue(duplicateError),
    });
    const run = createLangfusePromptSyncRunner(deps);

    const result = await run(createRequest());

    expect(result).toEqual({ ok: true, value: { created: 0, unchanged: 1, skipped: 0 } });
    expect(deps.grantPermission).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('maps a ValidationError on create to skipped with a warning', async () => {
    const validationError = new Error('invalid document');
    validationError.name = 'ValidationError';
    const deps = createDeps({
      createLangfusePromptGroup: jest.fn().mockRejectedValue(validationError),
    });
    const run = createLangfusePromptSyncRunner(deps);

    const result = await run(createRequest());

    expect(result).toEqual({ ok: true, value: { created: 0, unchanged: 0, skipped: 1 } });
    expect(deps.grantPermission).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed validation'),
      'greeting',
      validationError,
    );
  });

  it('rethrows an unexpected create error, which is neither a duplicate key nor a validation failure', async () => {
    const deps = createDeps({
      createLangfusePromptGroup: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const run = createLangfusePromptSyncRunner(deps);

    await expect(run(createRequest())).rejects.toThrow('boom');
    expect(deps.grantPermission).not.toHaveBeenCalled();
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

  it('deletes the created group and rethrows when the grant fails', async () => {
    const grantError = new Error('grant failed');
    const deps = createDeps({ grantPermission: jest.fn().mockRejectedValue(grantError) });
    const run = createLangfusePromptSyncRunner(deps);

    await expect(run(createRequest())).rejects.toBe(grantError);
    expect(deps.deletePromptGroup).toHaveBeenCalledWith({ _id: 'group-1' });
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Could not grant public access'),
      grantError,
    );
    expect(deps.lock.release).toHaveBeenCalledTimes(1);
  });

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

    expect(result).toEqual({ ok: true, value: { created: 2, unchanged: 0, skipped: 0 } });
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
    expect(deps.createLangfusePromptGroup).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sourceDestination: 'us',
        sourceProjectId: 'project-2',
        author: makeSourceAuthorId('langfuse', 'project-2'),
      }),
    );
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
});
