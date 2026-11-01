import { PermissionBits, ResourceType } from 'librechat-data-provider';
import { hasAgentBasedFileAccess } from './access';

const params = { userId: 'user-1', role: 'USER', fileId: 'file-1', fileOwner: 'owner-1' };

describe('hasAgentBasedFileAccess', () => {
  it('reads permissions for every shared agent in one batch', async () => {
    const getResourcePermissionsMap = jest.fn(
      async () => new Map([['agent-b', PermissionBits.VIEW]]),
    );
    const deps = {
      getAgents: jest.fn(async () => [
        { _id: 'agent-a', id: 'a', author: 'someone' },
        { _id: 'agent-b', id: 'b', author: 'someone-else' },
        { _id: 'agent-c', id: 'c', author: null },
      ]),
      getResourcePermissionsMap,
    };

    await expect(hasAgentBasedFileAccess(params, deps)).resolves.toBe(true);
    expect(getResourcePermissionsMap).toHaveBeenCalledTimes(1);
    expect(getResourcePermissionsMap).toHaveBeenCalledWith({
      userId: 'user-1',
      role: 'USER',
      resourceType: ResourceType.AGENT,
      resourceIds: ['agent-a', 'agent-b'],
    });
  });

  it('grants authors without a permission read', async () => {
    const getResourcePermissionsMap = jest.fn(async () => new Map<string, number>());
    const deps = {
      getAgents: jest.fn(async () => [{ _id: 'agent-a', id: 'a', author: 'user-1' }]),
      getResourcePermissionsMap,
    };

    await expect(hasAgentBasedFileAccess(params, deps)).resolves.toBe(true);
    expect(getResourcePermissionsMap).not.toHaveBeenCalled();
  });

  it('denies when no shared agent grants VIEW or the permission read fails', async () => {
    const getAgents = jest.fn(async () => [{ _id: 'agent-a', id: 'a', author: 'someone' }]);

    await expect(
      hasAgentBasedFileAccess(params, {
        getAgents,
        getResourcePermissionsMap: async () => new Map([['agent-a', 0]]),
      }),
    ).resolves.toBe(false);
    await expect(
      hasAgentBasedFileAccess(params, {
        getAgents,
        getResourcePermissionsMap: async () => {
          throw new Error('acl down');
        },
      }),
    ).resolves.toBe(false);
  });
});
