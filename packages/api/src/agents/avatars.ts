import { logger } from '@librechat/data-schemas';
import { DEFAULT_AVATAR_REFRESH_COVERAGE_LIMIT, FileSources } from 'librechat-data-provider';
import type { Agent, AgentAvatar } from 'librechat-data-provider';

const MAX_AVATAR_REFRESH_AGENTS: number = 1000;
const AVATAR_REFRESH_BATCH_SIZE: number = 20;

export { MAX_AVATAR_REFRESH_AGENTS, AVATAR_REFRESH_BATCH_SIZE };

/**
 * Selects the agents whose S3 avatar URLs should be refreshed for one list response.
 * The caller supplies the already-paginated page, so refresh work follows the requested
 * ordering while retaining a hard upper bound for unusually large page limits.
 */
export const selectAvatarRefreshAgents = (
  agents: Agent[] | null | undefined,
  coveredIds: Iterable<string> = [],
): Agent[] => {
  const covered = new Set(coveredIds);
  return (agents ?? [])
    .filter(
      (agent) =>
        agent?.avatar?.source === FileSources.s3 &&
        Boolean(agent?.avatar?.filepath) &&
        Boolean(agent?.id) &&
        !covered.has(agent.id),
    )
    .slice(0, MAX_AVATAR_REFRESH_AGENTS);
};

export type AvatarRefreshUrl = {
  /** The avatar filepath this signed URL was generated for. */
  filepath: string;
  url: string;
};

export type AvatarRefreshCacheEntry = {
  /** Maps each agent ID to a signed URL and the source filepath it describes. */
  urlCache: Record<string, AvatarRefreshUrl>;
  /** Maps each covered agent ID to the absolute time at which its coverage expires. */
  coveredIds: Record<string, number>;
  /** Maps each covered agent ID to the source filepath checked during that pass. */
  coveredFilepaths: Record<string, string>;
};

type LegacyAvatarRefreshCacheEntry = {
  urlCache?: Record<string, string | AvatarRefreshUrl>;
  coveredIds?: string[] | Record<string, number>;
  coveredFilepaths?: Record<string, string>;
};

const getCachedAvatarFilepath = (entry: unknown, id: string): string | undefined => {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const cacheEntry = entry as LegacyAvatarRefreshCacheEntry;
  const coveredFilepath = cacheEntry.coveredFilepaths?.[id];
  if (typeof coveredFilepath === 'string') {
    return coveredFilepath;
  }
  const cachedUrl = cacheEntry.urlCache?.[id];
  return cachedUrl && typeof cachedUrl === 'object' && typeof cachedUrl.filepath === 'string'
    ? cachedUrl.filepath
    : undefined;
};

const getCachedAvatarUrl = (entry: unknown, id: string): AvatarRefreshUrl | undefined => {
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const cachedUrl = (entry as LegacyAvatarRefreshCacheEntry).urlCache?.[id];
  return cachedUrl &&
    typeof cachedUrl === 'object' &&
    typeof cachedUrl.filepath === 'string' &&
    typeof cachedUrl.url === 'string'
    ? cachedUrl
    : undefined;
};

/**
 * Lays a cached signed URL over the row it was signed for. A signed URL describes one
 * filepath, so it applies only while the row still carries that filepath and still names
 * S3; a row whose avatar has since been replaced keeps its own. Legacy cache values are
 * bare strings with no filepath binding, which {@link getCachedAvatarUrl} already refuses.
 *
 * The cache entry is read here rather than in the caller so the shape of the entry stays
 * private to this module and one reader decides what a usable entry is.
 */
export const applyCachedAvatarUrl = (agent: Agent, cacheEntry: unknown): Agent => {
  const avatar = agent?.avatar;
  if (!agent?.id || avatar?.source !== FileSources.s3 || !avatar.filepath) {
    return agent;
  }
  const cached = getCachedAvatarUrl(cacheEntry, agent.id);
  if (!cached || cached.filepath !== avatar.filepath) {
    return agent;
  }
  return { ...agent, avatar: { ...avatar, filepath: cached.url } };
};

const getAvatarRefreshCoverage = (
  entry: unknown,
  now: number,
  coverageTtl: number,
): Record<string, number> => {
  if (!entry || typeof entry !== 'object') {
    return {};
  }

  const cacheEntry = entry as LegacyAvatarRefreshCacheEntry;
  const coveredIds = cacheEntry.coveredIds;
  if (coveredIds && !Array.isArray(coveredIds) && typeof coveredIds === 'object') {
    return Object.fromEntries(
      Object.entries(coveredIds).filter(
        ([, expiresAt]) => Number.isFinite(expiresAt) && expiresAt > now,
      ),
    );
  }

  const legacyIds = Array.isArray(coveredIds) ? coveredIds : Object.keys(cacheEntry.urlCache ?? {});
  const expiresAt = now + Math.max(0, coverageTtl);
  return Object.fromEntries(
    legacyIds.filter((id) => typeof id === 'string').map((id) => [id, expiresAt]),
  );
};

export const getAvatarRefreshCoveredIds = (entry: unknown, now: number = Date.now()): string[] =>
  Object.keys(getAvatarRefreshCoverage(entry, now, 0)).filter(
    (id) => getCachedAvatarFilepath(entry, id) != null,
  );

const getAvatarRefreshCacheTtl = (
  entry: AvatarRefreshCacheEntry,
  now: number,
  fallbackTtl: number,
): number => {
  const furthestExpiry = Math.max(...Object.values(entry.coveredIds), now);
  return Math.max(1, furthestExpiry - now || fallbackTtl);
};

export type RefreshS3UrlFn = (avatar: AgentAvatar) => Promise<string | undefined>;

export type UpdateAgentFn = (params: {
  id: string;
  avatar: AgentAvatar;
  previousAvatar?: AgentAvatar | null;
}) => Promise<unknown>;

export type AvatarRefreshCache = {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: AvatarRefreshCacheEntry, ttl: number) => Promise<unknown>;
};

/* Every page for one user starts from the snapshot its request read before the list
   query, so merging into that snapshot would let whichever page finishes last drop the
   coverage and refreshed URLs the others added, and the next response would repeat their
   S3 work. Re-reading here narrows the overlap to the gap between this read and the
   write, instead of spanning the whole refresh. A failed read leaves the caller's
   snapshot in place, which is the behaviour this had before. */
const readLatestRefreshEntry = async (
  cache: AvatarRefreshCache,
  refreshKey: string,
  snapshot: unknown,
): Promise<unknown> => {
  try {
    return (await cache.get(refreshKey)) ?? snapshot;
  } catch (err) {
    logger.error('[resolveAvatarRefresh] Error re-reading the avatar refresh cache: %o', err);
    return snapshot;
  }
};

/** In-flight merge per refresh key, so one user's pages queue instead of racing. */
const avatarRefreshMergeChains = new Map<string, Promise<unknown>>();

/**
 * Runs one read-merge-write for a refresh key at a time. Two pages that both read
 * before either wrote would each persist their own view and drop the other's coverage,
 * so the next visit re-signs avatars the window says are covered. Within a process this
 * queue prevents that; two replicas can still interleave, and the re-read only narrows
 * the window rather than closing it. That is deliberate: a dropped merge costs signing
 * work the next page redoes, never a wrong URL, so it does not earn a distributed lock or
 * a cache that has to offer compare-and-set.
 */
const serializeAvatarRefreshMerge = async <T>(
  refreshKey: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = avatarRefreshMergeChains.get(refreshKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  avatarRefreshMergeChains.set(refreshKey, current);
  try {
    return await current;
  } finally {
    if (avatarRefreshMergeChains.get(refreshKey) === current) {
      avatarRefreshMergeChains.delete(refreshKey);
    }
  }
};

export type ResolveAvatarRefreshParams = {
  agents: Agent[];
  userId: string;
  cachedRefreshEntry: unknown;
  cache: AvatarRefreshCache;
  refreshKey: string;
  cacheTtl: number;
  coverageLimit?: number;
  refreshS3Url: RefreshS3UrlFn;
  updateAgent: UpdateAgentFn;
};

export type RefreshListAvatarsParams = {
  agents: Agent[];
  userId: string;
  refreshS3Url: RefreshS3UrlFn;
  updateAgent: UpdateAgentFn;
};

export type RefreshStats = {
  updated: number;
  not_s3: number;
  no_id: number;
  no_change: number;
  s3_error: number;
  persist_error: number;
  /** Maps agentId to the freshly signed URL and the filepath it was signed for. */
  urlCache: Record<string, AvatarRefreshUrl>;
  /** IDs whose S3 URL refresh was attempted during this pass, including unchanged/error results. */
  coveredIds: string[];
  /** Source filepaths checked for each covered agent ID. */
  coveredFilepaths: Record<string, string>;
};
/**
 * Resolves the cache and refresh work for one already-paginated agent page.
 * Cache coverage is page-independent: each response contributes the rows it saw,
 * so later pages can refresh rows absent from earlier responses.
 */
export const resolveAvatarRefresh = async ({
  agents,
  userId,
  cachedRefreshEntry,
  cache,
  refreshKey,
  cacheTtl,
  coverageLimit = DEFAULT_AVATAR_REFRESH_COVERAGE_LIMIT,
  refreshS3Url,
  updateAgent,
}: ResolveAvatarRefreshParams): Promise<AvatarRefreshCacheEntry | null> => {
  const now = Date.now();
  const isValidCachedRefresh =
    cachedRefreshEntry != null &&
    typeof cachedRefreshEntry === 'object' &&
    (cachedRefreshEntry as Partial<AvatarRefreshCacheEntry>).urlCache != null;
  const cachedCoverage = getAvatarRefreshCoverage(cachedRefreshEntry, now, cacheTtl);
  /* Coverage belongs to an avatar, not to an agent id: the owner can replace the file and
     leave the id alone, and a URL signed for the old one is then a link to something the
     agent no longer shows. Coverage therefore only counts while the filepath it was taken
     for is still the filepath on the row, which also drops entries written before this
     binding existed - they cannot be checked, so they are refreshed. */
  const loadedFilepaths = new Map(
    agents.map((agent) => [agent?.id, agent?.avatar?.filepath] as const),
  );
  const coverage: Record<string, number> = {};
  for (const [id, deadline] of Object.entries(cachedCoverage)) {
    const filepath = getCachedAvatarFilepath(cachedRefreshEntry, id);
    if (filepath != null && loadedFilepaths.get(id) === filepath) {
      coverage[id] = deadline;
    }
  }
  const refreshAgents = selectAvatarRefreshAgents(agents, Object.keys(coverage));
  if (!refreshAgents.length && isValidCachedRefresh) {
    logger.debug(
      '[resolveAvatarRefresh] S3 avatar refresh already checked for this page, skipping',
    );
    const urlCache: Record<string, AvatarRefreshUrl> = {};
    const coveredFilepaths: Record<string, string> = {};
    for (const id of Object.keys(coverage)) {
      const filepath = getCachedAvatarFilepath(cachedRefreshEntry, id);
      const cachedUrl = getCachedAvatarUrl(cachedRefreshEntry, id);
      if (filepath != null) {
        coveredFilepaths[id] = filepath;
      }
      if (cachedUrl != null) {
        urlCache[id] = cachedUrl;
      }
    }
    return { urlCache, coveredIds: coverage, coveredFilepaths };
  }

  try {
    const { urlCache, coveredIds, coveredFilepaths } = await refreshListAvatars({
      agents: refreshAgents,
      userId,
      refreshS3Url,
      updateAgent,
    });
    const refreshEntry = await serializeAvatarRefreshMerge(refreshKey, async () => {
      const latestEntry = await readLatestRefreshEntry(cache, refreshKey, cachedRefreshEntry);
      const mergedEntry = mergeAvatarRefreshCacheEntry(
        latestEntry,
        { urlCache, coveredIds, coveredFilepaths },
        cacheTtl,
        coverageLimit,
      );
      const refreshedAt = Date.now();
      try {
        await cache.set(
          refreshKey,
          mergedEntry,
          getAvatarRefreshCacheTtl(mergedEntry, refreshedAt, cacheTtl),
        );
      } catch (err) {
        logger.error('[resolveAvatarRefresh] Error writing the avatar refresh cache: %o', err);
      }
      return mergedEntry;
    });
    return refreshEntry;
  } catch (err) {
    logger.error('[resolveAvatarRefresh] Error refreshing avatars for list page: %o', err);
    return null;
  }
};

export const mergeAvatarRefreshCacheEntry = (
  previous: unknown,
  stats: Pick<RefreshStats, 'urlCache' | 'coveredIds'> &
    Partial<Pick<RefreshStats, 'coveredFilepaths'>>,
  coverageTtl: number = 30 * 60 * 1000,
  coverageLimit: number = DEFAULT_AVATAR_REFRESH_COVERAGE_LIMIT,
  now: number = Date.now(),
): AvatarRefreshCacheEntry => {
  const previousEntry =
    previous && typeof previous === 'object'
      ? (previous as Partial<AvatarRefreshCacheEntry>)
      : undefined;
  const coverage = getAvatarRefreshCoverage(previous, now, coverageTtl);
  const filepaths = { ...(previousEntry?.coveredFilepaths ?? {}) };
  const expiresAt = now + Math.max(0, coverageTtl);
  for (const id of stats.coveredIds) {
    delete coverage[id];
    coverage[id] = expiresAt;
    const filepath = stats.coveredFilepaths?.[id];
    if (typeof filepath === 'string') {
      filepaths[id] = filepath;
    } else {
      delete filepaths[id];
    }
  }
  /* Expired deadlines go first; past the limit the furthest ones are kept, because they
     are the coverage a reader still browsing is about to need. */
  const retainedCoverage = Object.entries(coverage)
    .filter(([id, deadline]) => deadline > now && typeof filepaths[id] === 'string')
    .sort(([, firstDeadline], [, secondDeadline]) => firstDeadline - secondDeadline)
    .slice(-coverageLimit);
  const coveredIds = Object.fromEntries(retainedCoverage);
  const retainedIds = new Set(Object.keys(coveredIds));
  const coveredFilepaths = Object.fromEntries(
    Object.entries(filepaths).filter(
      ([id, filepath]) => retainedIds.has(id) && typeof filepath === 'string',
    ),
  );
  /* A cached URL says which filepath it was signed for, and it is applied only to a row
     that still carries that filepath - a page read before the refresh landed. It is
     deliberately not required to match the coverage path, which names what is stored now:
     a successful re-sign moves the stored path forward while pages already in flight keep
     the old one. Entries written before that binding existed carry a bare string and
     cannot be checked at all, so they are dropped and the next page signs again. */
  const urlCache: Record<string, AvatarRefreshUrl> = {};
  for (const source of [previousEntry?.urlCache ?? {}, stats.urlCache]) {
    for (const id of Object.keys(source)) {
      const value = getCachedAvatarUrl({ urlCache: source }, id);
      if (retainedIds.has(id) && value != null) {
        urlCache[id] = value;
      }
    }
  }

  return { urlCache, coveredIds, coveredFilepaths };
};

/**
 * Opportunistically refreshes S3-backed avatars for agent list responses.
 * Processes agents in batches to prevent database connection pool exhaustion.
 * Only list responses are refreshed because they're the highest-traffic surface and
 * the avatar URLs have a short-lived TTL. Per-user cache coverage suppresses repeat
 * refreshes for agents already attempted within 30 minutes while allowing a later page
 * to refresh rows not yet covered.
 *
 * Any user with VIEW access to an agent can refresh its avatar URL. This ensures
 * avatars remain accessible even when the owner hasn't logged in recently.
 * The agents array should already be filtered to only include agents the user can access.
 */
export const refreshListAvatars = async ({
  agents,
  refreshS3Url,
  updateAgent,
}: RefreshListAvatarsParams): Promise<RefreshStats> => {
  const stats: RefreshStats = {
    updated: 0,
    not_s3: 0,
    no_id: 0,
    no_change: 0,
    s3_error: 0,
    persist_error: 0,
    urlCache: {},
    coveredIds: [],
    coveredFilepaths: {},
  };

  if (!agents?.length) {
    return stats;
  }

  logger.debug('[refreshListAvatars] Refreshing S3 avatars for agents: %d', agents.length);

  for (let i = 0; i < agents.length; i += AVATAR_REFRESH_BATCH_SIZE) {
    const batch = agents.slice(i, i + AVATAR_REFRESH_BATCH_SIZE);

    await Promise.all(
      batch.map(async (agent) => {
        if (agent?.avatar?.source !== FileSources.s3 || !agent?.avatar?.filepath) {
          stats.not_s3++;
          return;
        }

        if (!agent?.id) {
          logger.debug(
            '[refreshListAvatars] Skipping S3 avatar refresh for agent: %s, ID is not set',
            agent._id,
          );
          stats.no_id++;
          return;
        }
        stats.coveredIds.push(agent.id);
        stats.coveredFilepaths[agent.id] = agent.avatar.filepath;

        try {
          logger.debug('[refreshListAvatars] Refreshing S3 avatar for agent: %s', agent._id);
          const newPath = await refreshS3Url(agent.avatar);

          if (!newPath || newPath === agent.avatar.filepath) {
            stats.no_change++;
            return;
          }

          stats.urlCache[agent.id] = { filepath: agent.avatar.filepath, url: newPath };

          try {
            const persisted = await updateAgent({
              id: agent.id,
              avatar: { filepath: newPath, source: agent.avatar.source },
              previousAvatar: agent.avatar,
            });
            if (persisted === false) {
              delete stats.urlCache[agent.id];
              logger.debug(
                '[refreshListAvatars] Avatar refresh skipped because the stored avatar changed: %s',
                agent.id,
              );
              return;
            }
            /* Coverage answers "has this avatar been checked", so it has to name the path a
               later page will read - which is the one just written. The URL keeps the path
               the page in hand still carries, because that is the row it applies to. */
            stats.coveredFilepaths[agent.id] = newPath;
            stats.updated++;
          } catch (persistErr) {
            logger.error('[refreshListAvatars] Avatar refresh persist error: %o', persistErr);
            stats.persist_error++;
          }
        } catch (err) {
          logger.error('[refreshListAvatars] S3 avatar refresh error: %o', err);
          stats.s3_error++;
        }
      }),
    );
  }

  const { urlCache: _urlCache, ...loggableStats } = stats;
  logger.info('[refreshListAvatars] Avatar refresh summary: %o', {
    ...loggableStats,
    urlCacheSize: Object.keys(_urlCache).length,
  });
  return stats;
};
