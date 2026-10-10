import { DEFAULT_AVATAR_REFRESH_COVERAGE_LIMIT, FileSources } from 'librechat-data-provider';
const defaultCoverageLimit = DEFAULT_AVATAR_REFRESH_COVERAGE_LIMIT;
import type { Agent, AgentAvatar, AgentModelParameters } from 'librechat-data-provider';
import type {
  AvatarRefreshCacheEntry,
  AvatarRefreshCache,
  RefreshS3UrlFn,
  UpdateAgentFn,
} from './avatars';
import {
  AVATAR_REFRESH_BATCH_SIZE,
  MAX_AVATAR_REFRESH_AGENTS,
  applyCachedAvatarUrl,
  getAvatarRefreshCoveredIds,
  mergeAvatarRefreshCacheEntry,
  refreshListAvatars,
  resolveAvatarRefresh,
  selectAvatarRefreshAgents,
} from './avatars';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { logger } from '@librechat/data-schemas';

describe('selectAvatarRefreshAgents', () => {
  const agent = (id: string): Agent =>
    ({
      id,
      avatar: { source: FileSources.s3, filepath: `${id}.jpg` },
    }) as Agent;

  it('keeps page order, skips covered rows, and enforces the S3 work cap', () => {
    const agents = Array.from({ length: MAX_AVATAR_REFRESH_AGENTS + 2 }, (_, i) =>
      agent(`agent${i}`),
    );
    const selected = selectAvatarRefreshAgents(agents, ['agent0', 'agent2']);

    expect(selected).toHaveLength(MAX_AVATAR_REFRESH_AGENTS);
    expect(selected[0].id).toBe('agent1');
    expect(selected[selected.length - 1]?.id).toBe(`agent${MAX_AVATAR_REFRESH_AGENTS + 1}`);
  });
});

describe('refreshListAvatars', () => {
  let mockRefreshS3Url: jest.MockedFunction<RefreshS3UrlFn>;
  let mockUpdateAgent: jest.MockedFunction<UpdateAgentFn>;
  const userId = 'user123';

  beforeEach(() => {
    mockRefreshS3Url = jest.fn();
    mockUpdateAgent = jest.fn();
    jest.clearAllMocks();
  });

  /** Stands in for the shared store: `get` returns whatever was written last. */
  const createRefreshCache = (
    stored: { entry: AvatarRefreshCacheEntry | null } = { entry: null },
  ) => {
    const cache: AvatarRefreshCache = {
      get: jest.fn(async () => stored.entry),
      set: jest.fn(async (_key: string, value: AvatarRefreshCacheEntry) => {
        stored.entry = value;
      }),
    };
    return { cache, stored };
  };

  const createAgent = (overrides: Partial<Agent> = {}): Agent => ({
    _id: 'obj1',
    id: 'agent1',
    name: 'Test Agent',
    author: userId,
    description: 'Test',
    created_at: Date.now(),
    avatar: {
      source: FileSources.s3,
      filepath: 'old-path.jpg',
    },
    instructions: null,
    provider: 'openai',
    model: 'gpt-4',
    model_parameters: {} as AgentModelParameters,
    ...overrides,
  });

  it('should return empty stats for empty agents array', async () => {
    const stats = await refreshListAvatars({
      agents: [],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.updated).toBe(0);
    expect(stats.urlCache).toEqual({});
    expect(mockRefreshS3Url).not.toHaveBeenCalled();
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it('should skip non-S3 avatars', async () => {
    const agent = createAgent({
      avatar: { source: 'local', filepath: 'local-path.jpg' } as AgentAvatar,
    });

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.not_s3).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.urlCache).toEqual({});
    expect(mockRefreshS3Url).not.toHaveBeenCalled();
  });

  it('should skip agents without id', async () => {
    const agent = createAgent({ id: '' });

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.no_id).toBe(1);
    expect(mockRefreshS3Url).not.toHaveBeenCalled();
  });

  it('should refresh avatars for agents owned by other users (VIEW access)', async () => {
    const agent = createAgent({ author: 'otherUser' });
    mockRefreshS3Url.mockResolvedValue('new-path.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.updated).toBe(1);
    expect(mockRefreshS3Url).toHaveBeenCalled();
    expect(mockUpdateAgent).toHaveBeenCalled();
  });

  it('should refresh and persist S3 avatars', async () => {
    const agent = createAgent();
    mockRefreshS3Url.mockResolvedValue('new-path.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.updated).toBe(1);
    expect(stats.urlCache).toEqual({ agent1: { filepath: 'old-path.jpg', url: 'new-path.jpg' } });
    expect(mockRefreshS3Url).toHaveBeenCalledWith(agent.avatar);
    expect(mockUpdateAgent).toHaveBeenCalledWith({
      id: 'agent1',
      avatar: { filepath: 'new-path.jpg', source: FileSources.s3 },
      previousAvatar: agent.avatar,
    });
  });

  it('omits a refreshed URL when the conditional avatar write is skipped', async () => {
    const agent = createAgent();
    const { cache } = createRefreshCache();
    mockRefreshS3Url.mockResolvedValue('new-path.jpg');
    mockUpdateAgent.mockResolvedValue(false);

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });
    const entry = await resolveAvatarRefresh({
      agents: [agent],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.updated).toBe(0);
    expect(stats.urlCache).toEqual({});
    expect(entry?.urlCache).toEqual({});

    expect(mockUpdateAgent).toHaveBeenCalledWith({
      id: 'agent1',
      avatar: { filepath: 'new-path.jpg', source: FileSources.s3 },
      previousAvatar: agent.avatar,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      '[refreshListAvatars] Avatar refresh skipped because the stored avatar changed: %s',
      'agent1',
    );
  });

  it('should not update if S3 URL unchanged', async () => {
    const agent = createAgent();
    mockRefreshS3Url.mockResolvedValue('old-path.jpg');

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.no_change).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.urlCache).toEqual({});
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it('should handle S3 refresh errors gracefully', async () => {
    const agent = createAgent();
    mockRefreshS3Url.mockRejectedValue(new Error('S3 error'));

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.s3_error).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.urlCache).toEqual({});
  });

  it('should handle database persist errors gracefully', async () => {
    const agent = createAgent();
    mockRefreshS3Url.mockResolvedValue('new-path.jpg');
    mockUpdateAgent.mockRejectedValue(new Error('DB error'));

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.persist_error).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.urlCache).toEqual({ agent1: { filepath: 'old-path.jpg', url: 'new-path.jpg' } });
  });

  it('should process agents in batches', async () => {
    const agents = Array.from({ length: 25 }, (_, i) =>
      createAgent({
        _id: `obj${i}`,
        id: `agent${i}`,
        avatar: { source: FileSources.s3, filepath: `path${i}.jpg` },
      }),
    );

    mockRefreshS3Url.mockImplementation((avatar) =>
      Promise.resolve(avatar.filepath.replace('.jpg', '-new.jpg')),
    );
    mockUpdateAgent.mockResolvedValue({});

    const stats = await refreshListAvatars({
      agents,
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.updated).toBe(25);
    expect(Object.keys(stats.urlCache)).toHaveLength(25);
    expect(mockRefreshS3Url).toHaveBeenCalledTimes(25);
    expect(mockUpdateAgent).toHaveBeenCalledTimes(25);
  });

  it('should not populate urlCache when refreshS3Url resolves with falsy', async () => {
    const agent = createAgent();
    mockRefreshS3Url.mockResolvedValue(undefined);

    const stats = await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.no_change).toBe(1);
    expect(stats.urlCache).toEqual({});
    expect(mockUpdateAgent).not.toHaveBeenCalled();
  });

  it('should redact urlCache from log output', async () => {
    const agent = createAgent();
    mockRefreshS3Url.mockResolvedValue('new-path.jpg');
    mockUpdateAgent.mockResolvedValue({});

    await refreshListAvatars({
      agents: [agent],
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    const loggerInfo = logger.info as jest.Mock;
    const summaryCall = loggerInfo.mock.calls.find(([msg]) =>
      msg.includes('Avatar refresh summary'),
    );
    expect(summaryCall).toBeDefined();
    const loggedPayload = summaryCall[1];
    expect(loggedPayload).toHaveProperty('urlCacheSize', 1);
    expect(loggedPayload).not.toHaveProperty('urlCache');
  });

  it('should track mixed statistics correctly', async () => {
    const agents = [
      createAgent({ id: 'agent1' }),
      createAgent({ id: 'agent2', author: 'otherUser' }),
      createAgent({
        id: 'agent3',
        avatar: { source: 'local', filepath: 'local.jpg' } as AgentAvatar,
      }),
      createAgent({ id: '' }), // no id
    ];

    mockRefreshS3Url.mockResolvedValue('new-path.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const stats = await refreshListAvatars({
      agents,
      userId,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(stats.updated).toBe(2); // agent1 and agent2 (other user's agent now refreshed)
    expect(stats.not_s3).toBe(1); // agent3
    expect(stats.no_id).toBe(1); // agent with empty id
    expect(stats.urlCache).toEqual({
      agent1: { filepath: 'old-path.jpg', url: 'new-path.jpg' },
      agent2: { filepath: 'old-path.jpg', url: 'new-path.jpg' },
    });
  });
  it('refreshes covered agents when their avatar filepath changes', async () => {
    const { cache } = createRefreshCache();
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const firstAgent = createAgent({
      avatar: { source: FileSources.s3, filepath: 'old-path.jpg' },
    });
    const changedAgent = createAgent({
      avatar: { source: FileSources.s3, filepath: 'replacement-path.jpg' },
    });
    mockRefreshS3Url
      .mockResolvedValueOnce('old-signed-url.jpg')
      .mockResolvedValueOnce('replacement-signed-url.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const firstEntry = await resolveAvatarRefresh({
      agents: [firstAgent],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });
    const secondEntry = await resolveAvatarRefresh({
      agents: [changedAgent],
      userId,
      cachedRefreshEntry: firstEntry,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(mockRefreshS3Url).toHaveBeenCalledTimes(2);
    expect(secondEntry?.urlCache.agent1).toEqual({
      filepath: 'replacement-path.jpg',
      url: 'replacement-signed-url.jpg',
    });
    now.mockRestore();
  });

  it('skips a covered agent when the refresh found nothing to change', async () => {
    /* Nothing was written, so the path the row carries is the path coverage was taken
       for, and the next page inside the window asks S3 nothing. */
    const { cache } = createRefreshCache();
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const agent = createAgent({
      avatar: { source: FileSources.s3, filepath: 'stable-path.jpg' },
    });
    mockRefreshS3Url.mockResolvedValue('stable-path.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const firstEntry = await resolveAvatarRefresh({
      agents: [agent],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });
    const secondEntry = await resolveAvatarRefresh({
      agents: [agent],
      userId,
      cachedRefreshEntry: firstEntry,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(mockRefreshS3Url).toHaveBeenCalledTimes(1);
    expect(mockUpdateAgent).not.toHaveBeenCalled();
    expect(secondEntry?.coveredIds.agent1).toBeDefined();
    now.mockRestore();
  });

  it('covers the path it persisted, so the row it wrote is not signed again', async () => {
    /* A successful re-sign stores the new path, which is what the next page reads. If
       coverage still named the path the refresh started from, every window would re-sign
       every row it had just written. */
    const { cache } = createRefreshCache();
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const agent = createAgent({
      avatar: { source: FileSources.s3, filepath: 'expired-url.jpg' },
    });
    mockRefreshS3Url.mockResolvedValue('signed-url.jpg');
    mockUpdateAgent.mockResolvedValue(true);

    const firstEntry = await resolveAvatarRefresh({
      agents: [agent],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });
    expect(firstEntry?.urlCache.agent1).toEqual({
      filepath: 'expired-url.jpg',
      url: 'signed-url.jpg',
    });

    const persistedAgent = createAgent({
      avatar: { source: FileSources.s3, filepath: 'signed-url.jpg' },
    });
    const secondEntry = await resolveAvatarRefresh({
      agents: [persistedAgent],
      userId,
      cachedRefreshEntry: firstEntry,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(mockRefreshS3Url).toHaveBeenCalledTimes(1);
    expect(secondEntry?.coveredIds.agent1).toBeDefined();
    now.mockRestore();
  });

  it('refreshes legacy entries without filepath information instead of applying their URL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const { cache } = createRefreshCache();
    const agent = createAgent({
      avatar: { source: FileSources.s3, filepath: 'current-path.jpg' },
    });
    mockRefreshS3Url.mockResolvedValue('current-signed-url.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const entry = await resolveAvatarRefresh({
      agents: [agent],
      userId,
      cachedRefreshEntry: {
        urlCache: { agent1: 'removed-signed-url.jpg' },
        coveredIds: { agent1: 30 * 60 * 1000 },
      },
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(mockRefreshS3Url).toHaveBeenCalledTimes(1);
    expect(entry?.urlCache.agent1).toEqual({
      filepath: 'current-path.jpg',
      url: 'current-signed-url.jpg',
    });
    expect(entry?.urlCache.agent1.url).not.toBe('removed-signed-url.jpg');
    now.mockRestore();
  });

  it('expires coverage per agent instead of renewing earlier pages', async () => {
    const { cache } = createRefreshCache();
    const cacheSet = cache.set as jest.MockedFunction<AvatarRefreshCache['set']>;
    const firstAgent = createAgent({
      id: 'agent1',
      avatar: { source: FileSources.s3, filepath: 'one.jpg' },
    });
    const secondAgent = createAgent({
      id: 'agent2',
      avatar: { source: FileSources.s3, filepath: 'two.jpg' },
    });
    const now = jest.spyOn(Date, 'now');
    mockRefreshS3Url
      .mockResolvedValueOnce('one-new.jpg')
      .mockResolvedValueOnce('two-new.jpg')
      .mockResolvedValueOnce('one-newer.jpg');
    mockUpdateAgent.mockResolvedValue({});

    now.mockReturnValue(0);
    const firstEntry = await resolveAvatarRefresh({
      agents: [firstAgent],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    now.mockReturnValue(29 * 60 * 1000);
    const secondEntry = await resolveAvatarRefresh({
      agents: [secondAgent],
      userId,
      cachedRefreshEntry: firstEntry,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(secondEntry?.coveredIds.agent1).toBe(30 * 60 * 1000);
    expect(secondEntry?.coveredIds.agent2).toBe(59 * 60 * 1000);
    expect(cacheSet.mock.calls[1]?.[2]).toBe(30 * 60 * 1000);

    now.mockReturnValue(30 * 60 * 1000 + 1);
    const afterExpiry = await resolveAvatarRefresh({
      agents: [firstAgent],
      userId,
      cachedRefreshEntry: secondEntry,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(mockRefreshS3Url).toHaveBeenCalledTimes(3);
    expect(afterExpiry?.coveredIds.agent1).toBe(60 * 60 * 1000 + 1);
  });

  it('bounds retained coverage while keeping the newest ids covered', async () => {
    const retainedIds = Array.from({ length: defaultCoverageLimit }, (_, index) => `agent${index}`);
    const firstEntry = mergeAvatarRefreshCacheEntry(
      null,
      {
        urlCache: {},
        coveredIds: retainedIds,
        coveredFilepaths: Object.fromEntries(retainedIds.map((id) => [id, 'old-path.jpg'])),
      },
      30 * 60 * 1000,
      defaultCoverageLimit,
      0,
    );
    const boundedEntry = mergeAvatarRefreshCacheEntry(
      firstEntry,
      {
        urlCache: {},
        coveredIds: ['agent1000'],
        coveredFilepaths: { agent1000: 'old-path.jpg' },
      },
      30 * 60 * 1000,
      defaultCoverageLimit,
      1,
    );

    expect(Object.keys(boundedEntry.coveredIds)).toHaveLength(defaultCoverageLimit);
    expect(getAvatarRefreshCoveredIds(boundedEntry, 1)).not.toContain('agent0');
    expect(getAvatarRefreshCoveredIds(boundedEntry, 1)).toContain('agent1000');

    const { cache } = createRefreshCache();
    const now = jest.spyOn(Date, 'now').mockReturnValue(1);
    await resolveAvatarRefresh({
      agents: [createAgent({ id: 'agent1000' })],
      userId,
      cachedRefreshEntry: boundedEntry,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(mockRefreshS3Url).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('uses the configured coverage limit while defaulting to 1000', () => {
    const configuredEntry = mergeAvatarRefreshCacheEntry(
      null,
      {
        urlCache: {},
        coveredIds: ['agent0', 'agent1', 'agent2', 'agent3'],
        coveredFilepaths: {
          agent0: 'agent0.jpg',
          agent1: 'agent1.jpg',
          agent2: 'agent2.jpg',
          agent3: 'agent3.jpg',
        },
      },
      30 * 60 * 1000,
      2,
      0,
    );

    expect(Object.keys(configuredEntry.coveredIds)).toHaveLength(2);
    expect(Object.keys(configuredEntry.coveredIds)).toEqual(['agent2', 'agent3']);
    expect(defaultCoverageLimit).toBe(1000);
  });

  it('keeps the coverage a concurrent page wrote while this one was refreshing', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    /* Both pages read a null snapshot before their list queries; the other page finished
       first and wrote agent2 while this one was still talking to S3. */
    const { cache, stored } = createRefreshCache();
    stored.entry = mergeAvatarRefreshCacheEntry(
      null,
      {
        urlCache: { agent2: { filepath: 'two.jpg', url: 'two-new.jpg' } },
        coveredIds: ['agent2'],
        coveredFilepaths: { agent2: 'two.jpg' },
      },
      30 * 60 * 1000,
      defaultCoverageLimit,
      0,
    );
    mockRefreshS3Url.mockResolvedValue('one-new.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const entry = await resolveAvatarRefresh({
      agents: [
        createAgent({ id: 'agent1', avatar: { source: FileSources.s3, filepath: 'one.jpg' } }),
      ],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(Object.keys(entry?.coveredIds ?? {}).sort()).toEqual(['agent1', 'agent2']);
    expect(entry?.urlCache).toEqual({
      agent1: { filepath: 'one.jpg', url: 'one-new.jpg' },
      agent2: { filepath: 'two.jpg', url: 'two-new.jpg' },
    });
    expect(stored.entry).toEqual(entry);
    now.mockRestore();
  });

  it('returns refreshed URLs when persisting the cache entry fails', async () => {
    const { cache } = createRefreshCache();
    (cache.set as jest.MockedFunction<AvatarRefreshCache['set']>).mockRejectedValue(
      new Error('cache down'),
    );
    mockRefreshS3Url.mockResolvedValue('one-new.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const entry = await resolveAvatarRefresh({
      agents: [
        createAgent({ id: 'agent1', avatar: { source: FileSources.s3, filepath: 'one.jpg' } }),
      ],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(entry?.urlCache).toEqual({
      agent1: { filepath: 'one.jpg', url: 'one-new.jpg' },
    });
    expect(logger.error).toHaveBeenCalledWith(
      '[resolveAvatarRefresh] Error writing the avatar refresh cache: %o',
      expect.any(Error),
    );
  });

  it('serializes refresh cache merges for the same key', async () => {
    const stored: { entry: AvatarRefreshCacheEntry | null } = { entry: null };
    let setCalls = 0;
    const firstSetGate = Promise.withResolvers<void>();
    const firstSetRelease = Promise.withResolvers<void>();
    const cache: AvatarRefreshCache = {
      get: jest.fn(async () => stored.entry),
      set: jest.fn(async (_key, value) => {
        setCalls++;
        if (setCalls === 1) {
          firstSetGate.resolve();
          await firstSetRelease.promise;
        }
        stored.entry = value;
      }),
    };
    const first = createAgent({
      id: 'agent1',
      avatar: { source: FileSources.s3, filepath: 'one.jpg' },
    });
    const second = createAgent({
      id: 'agent2',
      avatar: { source: FileSources.s3, filepath: 'two.jpg' },
    });
    mockRefreshS3Url.mockImplementation((avatar) =>
      Promise.resolve(avatar.filepath === 'one.jpg' ? 'one-new.jpg' : 'two-new.jpg'),
    );
    mockUpdateAgent.mockResolvedValue({});

    const firstRefresh = resolveAvatarRefresh({
      agents: [first],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });
    await firstSetGate.promise;
    const secondRefresh = resolveAvatarRefresh({
      agents: [second],
      userId,
      cachedRefreshEntry: null,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });
    const releaseTimer = Promise.withResolvers<void>();
    setTimeout(releaseTimer.resolve, 0);
    await releaseTimer.promise;
    firstSetRelease.resolve();
    await Promise.all([firstRefresh, secondRefresh]);

    expect(Object.keys(stored.entry?.coveredIds ?? {}).sort()).toEqual(['agent1', 'agent2']);
    expect(stored.entry?.urlCache).toEqual({
      agent1: { filepath: 'one.jpg', url: 'one-new.jpg' },
      agent2: { filepath: 'two.jpg', url: 'two-new.jpg' },
    });
  });

  it('falls back to the request snapshot when the cache re-read fails', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    const snapshot = mergeAvatarRefreshCacheEntry(
      null,
      {
        urlCache: { agent2: { filepath: 'two.jpg', url: 'two-new.jpg' } },
        coveredIds: ['agent2'],
        coveredFilepaths: { agent2: 'two.jpg' },
      },
      30 * 60 * 1000,
      defaultCoverageLimit,
      0,
    );
    const { cache } = createRefreshCache();
    (cache.get as jest.MockedFunction<AvatarRefreshCache['get']>).mockRejectedValue(
      new Error('cache down'),
    );
    mockRefreshS3Url.mockResolvedValue('one-new.jpg');
    mockUpdateAgent.mockResolvedValue({});

    const entry = await resolveAvatarRefresh({
      agents: [
        createAgent({ id: 'agent1', avatar: { source: FileSources.s3, filepath: 'one.jpg' } }),
      ],
      userId,
      cachedRefreshEntry: snapshot,
      cache,
      refreshKey: 'avatars:user123',
      cacheTtl: 30 * 60 * 1000,
      refreshS3Url: mockRefreshS3Url,
      updateAgent: mockUpdateAgent,
    });

    expect(Object.keys(entry?.coveredIds ?? {}).sort()).toEqual(['agent1', 'agent2']);
    expect(cache.set).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    now.mockRestore();
  });
});

describe('applyCachedAvatarUrl', () => {
  const s3Agent = (filepath: string): Agent =>
    ({ id: 'agent1', avatar: { source: FileSources.s3, filepath } }) as Agent;
  const entry = (filepath: string, url: string) => ({ urlCache: { agent1: { filepath, url } } });

  it('serves the signed URL for the filepath it was signed from', () => {
    const applied = applyCachedAvatarUrl(s3Agent('a.jpg'), entry('a.jpg', 'https://signed/a'));

    expect(applied.avatar).toEqual({ source: FileSources.s3, filepath: 'https://signed/a' });
  });

  it('leaves a replaced avatar alone rather than serving the URL of the old one', () => {
    const agent = s3Agent('b.jpg');
    const applied = applyCachedAvatarUrl(agent, entry('a.jpg', 'https://signed/a'));

    expect(applied).toBe(agent);
    expect(applied.avatar?.filepath).toBe('b.jpg');
  });

  it('ignores a legacy string cache value, which carries no filepath binding', () => {
    const agent = s3Agent('a.jpg');
    const applied = applyCachedAvatarUrl(agent, { urlCache: { agent1: 'https://signed/a' } });

    expect(applied).toBe(agent);
  });

  it('leaves a non-S3 avatar alone and tolerates a missing or malformed entry', () => {
    const local = {
      id: 'agent1',
      avatar: { source: FileSources.local, filepath: 'a.jpg' },
    } as Agent;
    expect(applyCachedAvatarUrl(local, entry('a.jpg', 'https://signed/a'))).toBe(local);

    const agent = s3Agent('a.jpg');
    expect(applyCachedAvatarUrl(agent, undefined)).toBe(agent);
    expect(applyCachedAvatarUrl(agent, {})).toBe(agent);
    expect(applyCachedAvatarUrl(agent, { urlCache: { agent1: { filepath: 'a.jpg' } } })).toBe(
      agent,
    );
  });

  it('does not mutate the row it was handed', () => {
    const agent = s3Agent('a.jpg');
    applyCachedAvatarUrl(agent, entry('a.jpg', 'https://signed/a'));

    expect(agent.avatar?.filepath).toBe('a.jpg');
  });
});

describe('Constants', () => {
  it('should export MAX_AVATAR_REFRESH_AGENTS as 1000', () => {
    expect(MAX_AVATAR_REFRESH_AGENTS).toBe(1000);
  });

  it('should export AVATAR_REFRESH_BATCH_SIZE as 20', () => {
    expect(AVATAR_REFRESH_BATCH_SIZE).toBe(20);
  });
});
