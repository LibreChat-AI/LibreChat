import { logger } from '@librechat/data-schemas';
import { FileSources } from 'librechat-data-provider';
import type { AgentAvatar } from 'librechat-data-provider';
import type { RefreshS3UrlFn } from './avatars';
import { AVATAR_REFRESH_BATCH_SIZE, MAX_AVATAR_REFRESH_AGENTS } from './avatars';

type AvatarRefreshEntry = {
  urlCache: Record<string, string>;
  /** Stored pathname corresponding to each signed page URL, used to detect avatar replacements. */
  avatarPaths?: Record<string, string>;
  scope?: 'page';
  expiresAt?: number;
};
type ListedAgent = { id?: string; avatar?: AgentAvatar };

/** The list writer and avatar upload invalidator must always use the same tenant-scoped key. */
export function getAgentListAvatarRefreshKey(user: {
  id: string;
  tenantId?: string | null;
}): string {
  return `${user.id}:${user.tenantId ?? ''}:agents_avatar_refresh`;
}

function validRefreshEntry(entry: unknown): entry is AvatarRefreshEntry {
  return (
    entry != null &&
    typeof entry === 'object' &&
    'urlCache' in entry &&
    entry.urlCache != null &&
    typeof entry.urlCache === 'object' &&
    !Array.isArray(entry.urlCache)
  );
}

export function isFullAgentListAvatarCacheEntry(entry: unknown): boolean {
  return validRefreshEntry(entry) && entry.scope !== 'page';
}

/** Only ACL-scoped lists use the full-set refresh, which must finish before a cursor snapshot. */
export async function refreshAgentListAvatarsBeforePage(
  accessibleIds: string[] | null,
  cachedEntry: unknown,
  refreshAll: () => Promise<AvatarRefreshEntry | null>,
): Promise<AvatarRefreshEntry | null> {
  if (accessibleIds === null) {
    return validRefreshEntry(cachedEntry) ? cachedEntry : null;
  }
  return refreshAll();
}

/**
 * A manager has access to the whole tenant, but refreshing all of its avatars before each
 * search can presign and write hundreds of unrelated agents. Refresh only the visible page.
 * Do not persist these URL changes: updating `updatedAt` after taking a cursor snapshot would
 * reorder later pages, and legacy users without tenant context cannot safely update by public ID.
 */
export async function refreshManagedAgentListPageAvatars({
  accessibleIds,
  agents,
  cachedEntry,
  refreshS3Url,
  cacheSet,
  cacheKey,
  ttl,
}: {
  accessibleIds: string[] | null;
  agents: ListedAgent[];
  cachedEntry: AvatarRefreshEntry | null;
  refreshS3Url: RefreshS3UrlFn;
  cacheSet: (key: string, entry: AvatarRefreshEntry, ttl: number) => Promise<unknown>;
  cacheKey: string;
  ttl: number;
}): Promise<AvatarRefreshEntry | null> {
  if (accessibleIds !== null || agents.length === 0) {
    return cachedEntry;
  }

  const now = Date.now();
  const cachedExpiresAt = cachedEntry?.scope === 'page' ? cachedEntry.expiresAt : undefined;
  const cachedPageIsFresh = typeof cachedExpiresAt === 'number' && cachedExpiresAt > now;
  const urlCache = cachedPageIsFresh ? { ...cachedEntry?.urlCache } : {};
  const avatarPaths = cachedPageIsFresh ? { ...cachedEntry?.avatarPaths } : {};
  const expiresAt = cachedPageIsFresh ? cachedExpiresAt : now + ttl;
  // A different user can replace an agent's avatar without clearing this viewer's cache.
  // Never overlay a new avatar with a signed URL for an older stored pathname.
  for (const agent of agents) {
    if (
      agent.id &&
      Object.prototype.hasOwnProperty.call(urlCache, agent.id) &&
      (agent.avatar?.source !== FileSources.s3 ||
        !agent.avatar.filepath ||
        avatarPaths[agent.id] !== agent.avatar.filepath)
    ) {
      delete urlCache[agent.id];
      delete avatarPaths[agent.id];
    }
  }
  const pending = agents.filter(
    (agent) =>
      agent.id &&
      agent.avatar?.source === FileSources.s3 &&
      agent.avatar.filepath &&
      !Object.prototype.hasOwnProperty.call(urlCache, agent.id),
  );
  if (pending.length === 0) {
    return cachedPageIsFresh ? { urlCache, avatarPaths, scope: 'page', expiresAt } : null;
  }

  let changed = false;
  for (let index = 0; index < pending.length; index += AVATAR_REFRESH_BATCH_SIZE) {
    await Promise.all(
      pending.slice(index, index + AVATAR_REFRESH_BATCH_SIZE).map(async (agent) => {
        try {
          const url = await refreshS3Url(agent.avatar!);
          if (url && agent.id) {
            urlCache[agent.id] = url;
            avatarPaths[agent.id] = agent.avatar!.filepath!;
            changed = true;
          }
        } catch (error) {
          logger.warn('[AgentList] Failed to refresh visible avatar: %o', error);
        }
      }),
    );
  }

  if (changed) {
    // A manager can visit far more agents than the full-set refresh ever loads.
    // Bound one user's Redis entry to the existing avatar-refresh budget.
    const cacheIds = Object.keys(urlCache);
    for (const id of cacheIds.slice(0, Math.max(0, cacheIds.length - MAX_AVATAR_REFRESH_AGENTS))) {
      delete urlCache[id];
      delete avatarPaths[id];
    }
  }
  const entry: AvatarRefreshEntry = { urlCache, avatarPaths, scope: 'page', expiresAt };
  if (changed) {
    try {
      await cacheSet(cacheKey, entry, Math.max(1, expiresAt - Date.now()));
    } catch (error) {
      logger.warn('[AgentList] Failed to cache refreshed avatars: %o', error);
    }
  }
  return entry;
}
