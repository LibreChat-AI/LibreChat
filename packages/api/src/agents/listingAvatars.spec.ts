import { FileSources } from 'librechat-data-provider';
import {
  isFullAgentListAvatarCacheEntry,
  getAgentListAvatarRefreshKey,
  refreshAgentListAvatarsBeforePage,
  refreshManagedAgentListPageAvatars,
} from './listingAvatars';
import { MAX_AVATAR_REFRESH_AGENTS } from './avatars';

const visible = { id: 'agent-visible', avatar: { source: FileSources.s3, filepath: 'old.jpg' } };
const nextPage = { id: 'agent-next', avatar: { source: FileSources.s3, filepath: 'next.jpg' } };
const local = { id: 'agent-local', avatar: { source: FileSources.local, filepath: 'local.jpg' } };

function params() {
  return {
    accessibleIds: null,
    agents: [visible, local],
    cachedEntry: null,
    refreshS3Url: jest.fn().mockResolvedValue('signed-visible.jpg'),
    cacheSet: jest.fn().mockResolvedValue(undefined),
    cacheKey: 'user:tenant:avatars',
    ttl: 1800,
  };
}

describe('Agent listing avatar scope', () => {
  it('uses the same tenant-qualified key for listing and upload, including legacy users', () => {
    expect(getAgentListAvatarRefreshKey({ id: 'alice', tenantId: 'tenant-a' })).toBe(
      'alice:tenant-a:agents_avatar_refresh',
    );
    expect(getAgentListAvatarRefreshKey({ id: 'alice', tenantId: 'tenant-b' })).not.toBe(
      getAgentListAvatarRefreshKey({ id: 'alice', tenantId: 'tenant-a' }),
    );
    expect(getAgentListAvatarRefreshKey({ id: 'alice' })).toBe('alice::agents_avatar_refresh');
  });

  it('does not load every tenant avatar before a manager list query', async () => {
    const refreshAll = jest.fn().mockResolvedValue({ urlCache: { 'agent-visible': 'signed.jpg' } });
    await expect(refreshAgentListAvatarsBeforePage(null, null, refreshAll)).resolves.toBeNull();
    expect(refreshAll).not.toHaveBeenCalled();

    const previous = { urlCache: { 'agent-visible': 'signed.jpg' } };
    await expect(refreshAgentListAvatarsBeforePage(null, previous, refreshAll)).resolves.toEqual(
      previous,
    );
    expect(refreshAll).not.toHaveBeenCalled();
    await expect(refreshAgentListAvatarsBeforePage([], null, refreshAll)).resolves.toEqual(
      previous,
    );
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(isFullAgentListAvatarCacheEntry(previous)).toBe(true);
    expect(isFullAgentListAvatarCacheEntry({ ...previous, scope: 'page' })).toBe(false);
  });

  it('presigns only the manager search page without writing agent documents', async () => {
    const options = params();
    const result = await refreshManagedAgentListPageAvatars(options);

    expect(options.refreshS3Url).toHaveBeenCalledTimes(1);
    expect(options.refreshS3Url).toHaveBeenCalledWith(visible.avatar);
    expect(result?.urlCache).toEqual({ 'agent-visible': 'signed-visible.jpg' });
    expect(options.cacheSet).toHaveBeenCalledWith(options.cacheKey, result, expect.any(Number));
    expect(options.cacheSet.mock.calls[0][2]).toBeLessThanOrEqual(options.ttl);

    await refreshManagedAgentListPageAvatars({
      ...options,
      cachedEntry: result,
      agents: [visible],
    });
    expect(options.refreshS3Url).toHaveBeenCalledTimes(1);

    await refreshManagedAgentListPageAvatars({
      ...options,
      cachedEntry: result,
      agents: [nextPage],
    });
    expect(options.refreshS3Url).toHaveBeenCalledTimes(2);
  });

  it('bounds each manager cache entry while retaining the newest entries', async () => {
    const options = params();
    const all = Array.from({ length: MAX_AVATAR_REFRESH_AGENTS + 1 }, (_, index) => ({
      id: `agent-${index}`,
      avatar: { source: FileSources.s3, filepath: `old-${index}.jpg` },
    }));
    const first = await refreshManagedAgentListPageAvatars({
      ...options,
      agents: all.slice(0, MAX_AVATAR_REFRESH_AGENTS),
    });
    const next = await refreshManagedAgentListPageAvatars({
      ...options,
      cachedEntry: first,
      agents: all.slice(MAX_AVATAR_REFRESH_AGENTS),
    });

    expect(Object.keys(next!.urlCache)).toHaveLength(MAX_AVATAR_REFRESH_AGENTS);
    expect(next!.urlCache['agent-0']).toBeUndefined();
    expect(next!.urlCache[`agent-${MAX_AVATAR_REFRESH_AGENTS}`]).toBe('signed-visible.jpg');
    expect(options.cacheSet).toHaveBeenCalledTimes(2);
  });

  it('re-signs entries after their original TTL even when later pages updated the cache', async () => {
    const options = params();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const first = await refreshManagedAgentListPageAvatars(options);
      expect(first?.expiresAt).toBe(1000 + options.ttl);
      clock.mockReturnValue(1000 + options.ttl - 1);
      const second = await refreshManagedAgentListPageAvatars({
        ...options,
        cachedEntry: first,
        agents: [nextPage],
      });
      expect(options.cacheSet.mock.calls[1][2]).toBe(1);

      clock.mockReturnValue(1000 + options.ttl);
      const renewed = await refreshManagedAgentListPageAvatars({
        ...options,
        cachedEntry: second,
        agents: [visible],
      });
      expect(renewed?.expiresAt).toBe(1000 + options.ttl * 2);
      expect(options.refreshS3Url).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
    }
  });

  it('re-signs when another user replaces a cached avatar', async () => {
    const options = params();
    const previous = await refreshManagedAgentListPageAvatars(options);
    const replacement = {
      id: visible.id,
      avatar: { source: FileSources.s3, filepath: 'replacement.jpg' },
    };
    options.refreshS3Url.mockResolvedValueOnce('signed-replacement.jpg');

    const refreshed = await refreshManagedAgentListPageAvatars({
      ...options,
      cachedEntry: previous,
      agents: [replacement],
    });

    expect(options.refreshS3Url).toHaveBeenCalledTimes(2);
    expect(refreshed?.urlCache[visible.id]).toBe('signed-replacement.jpg');
    expect(refreshed?.avatarPaths?.[visible.id]).toBe('replacement.jpg');
    expect(options.cacheSet).toHaveBeenCalledTimes(2);
  });

  it('leaves an ordinary ACL viewer on the pre-query full-list refresh path', async () => {
    const options = params();
    const previous = { urlCache: { 'agent-visible': 'signed.jpg' } };
    const result = await refreshManagedAgentListPageAvatars({
      ...options,
      accessibleIds: ['507f1f77bcf86cd799439011'],
      cachedEntry: previous,
    });
    expect(result).toBe(previous);
    expect(options.refreshS3Url).not.toHaveBeenCalled();
    expect(options.cacheSet).not.toHaveBeenCalled();
  });

  it('allows retry after an S3 failure without failing the list response', async () => {
    const options = params();
    options.refreshS3Url.mockRejectedValueOnce(new Error('S3 unavailable'));
    const result = await refreshManagedAgentListPageAvatars(options);
    expect(result?.urlCache).toEqual({});
    expect(options.cacheSet).not.toHaveBeenCalled();
    await refreshManagedAgentListPageAvatars({ ...options, cachedEntry: result });
    expect(options.cacheSet).toHaveBeenCalledTimes(1);
  });
});
