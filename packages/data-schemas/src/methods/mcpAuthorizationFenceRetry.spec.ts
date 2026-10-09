import { createMCPAuthorizationFenceRetryStorage } from './mcpAuthorizationFenceRetry';

const mockBuildIndexWithRetry = jest.fn(
  async (build: () => Promise<unknown>, _label?: string, _options?: unknown) => build(),
);
const mockRunAsSystem = jest.fn(async (operation: () => Promise<unknown>) => operation());

jest.mock('~/utils/retry', () => ({
  buildIndexWithRetry: (build: () => Promise<unknown>, label?: string, options?: unknown) =>
    mockBuildIndexWithRetry(build, label, options),
}));
jest.mock('~/config/tenantContext', () => ({
  runAsSystem: (operation: () => Promise<unknown>) => mockRunAsSystem(operation),
}));

describe('MCP authorization fence retry storage', () => {
  it('guards its index and preserves exact-version mutations', async () => {
    const updateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    const deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
    const toArray = jest.fn().mockResolvedValue([{ version: 'v2' }]);
    const limit = jest.fn(() => ({ toArray }));
    const sort = jest.fn(() => ({ limit }));
    const createIndex = jest.fn().mockResolvedValue('updatedAt_1');
    const collection = { updateOne, deleteOne, find: jest.fn(() => ({ sort })), createIndex };
    const mongoose = {
      connection: { collection: jest.fn(() => collection) },
    } as unknown as typeof import('mongoose');
    const storage = createMCPAuthorizationFenceRetryStorage(mongoose);
    const scope = { userId: 'user-1', serverName: 'github' };
    const now = new Date('2026-01-01T00:00:00.000Z');

    await storage.upsert({ scope, tenantId: 'tenant-a', version: 'v2', now });
    await storage.deleteVersion({ scope, tenantId: 'tenant-a', version: 'v1' });
    await storage.deferVersion({
      scope,
      tenantId: 'tenant-a',
      version: 'v2',
      updatedAt: new Date(now.getTime() + 1),
    });
    await expect(storage.list(7)).resolves.toEqual([{ version: 'v2' }]);

    expect(deleteOne).toHaveBeenCalledWith({
      _id: JSON.stringify(['tenant-a', 'user-1', 'github', 'v1']),
      version: 'v1',
    });
    expect(updateOne).toHaveBeenLastCalledWith(
      { _id: JSON.stringify(['tenant-a', 'user-1', 'github', 'v2']), version: 'v2' },
      { $max: { updatedAt: new Date(now.getTime() + 1) } },
    );
    expect(mockBuildIndexWithRetry).toHaveBeenCalledWith(
      expect.any(Function),
      'mcp_authorization_fence_retries.updatedAt_1',
      undefined,
    );
    expect(createIndex).toHaveBeenCalledWith({ updatedAt: 1 }, { name: 'updatedAt_1' });
    expect(limit).toHaveBeenCalledWith(7);
    expect(mockRunAsSystem).toHaveBeenCalledWith(expect.any(Function));
  });
});
