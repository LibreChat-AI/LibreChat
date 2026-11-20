import { Types } from 'mongoose';
import { PermissionBits, PrincipalType, ResourceType, SystemRoles } from 'librechat-data-provider';
import type { InsightsAgentAccessDeps } from './access';
import { createInsightsAccessResolver, createInsightsAgentAccessResolver } from './access';

const agentA = { _id: new Types.ObjectId(), id: 'agent-a', name: 'Zulu', tenantId: 'tenant-a' };
const agentB = { _id: new Types.ObjectId(), id: 'agent-b', name: 'Alpha', tenantId: 'tenant-a' };

const createDeps = (): jest.Mocked<InsightsAgentAccessDeps> =>
  ({
    getAgents: jest.fn().mockResolvedValue([agentA, agentB]),
    getUserPrincipals: jest
      .fn()
      .mockResolvedValue([
        { principalType: PrincipalType.USER, principalId: new Types.ObjectId() },
        { principalType: PrincipalType.PUBLIC },
      ]),
    hasCapabilityForPrincipals: jest.fn().mockResolvedValue(false),
    findAccessibleResources: jest.fn().mockResolvedValue([]),
  }) as jest.Mocked<InsightsAgentAccessDeps>;

describe('createInsightsAgentAccessResolver', () => {
  it('returns every tenant agent for a literal admin', async () => {
    const deps = createDeps();
    const resolve = createInsightsAgentAccessResolver(deps);

    const result = await resolve({
      id: 'admin-id',
      role: SystemRoles.ADMIN,
      tenantId: 'tenant-a',
    });

    expect(deps.getAgents).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, '_id id name tenantId');
    expect(deps.getUserPrincipals).not.toHaveBeenCalled();
    expect(result).toEqual([
      { id: 'agent-b', name: 'Alpha' },
      { id: 'agent-a', name: 'Zulu' },
    ]);
  });

  it('returns every tenant agent for a global read:insights grant', async () => {
    const deps = createDeps();
    deps.hasCapabilityForPrincipals.mockResolvedValue(true);
    const resolve = createInsightsAgentAccessResolver(deps);

    const result = await resolve({ id: 'user-id', role: 'USER', tenantId: 'tenant-a' });

    expect(deps.findAccessibleResources).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it('requires VIEW and VIEW_INSIGHTS on the same non-public ACL entry', async () => {
    const deps = createDeps();
    deps.findAccessibleResources.mockResolvedValue([agentA._id]);
    const resolve = createInsightsAgentAccessResolver(deps);

    const result = await resolve({ id: 'user-id', role: 'USER', tenantId: 'tenant-a' });

    expect(deps.findAccessibleResources).toHaveBeenCalledWith(
      [expect.objectContaining({ principalType: PrincipalType.USER })],
      ResourceType.AGENT,
      PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
      [agentA._id, agentB._id],
    );
    expect(result).toEqual([{ id: 'agent-a', name: 'Zulu' }]);
  });

  it('returns no agents without a global or per-agent grant', async () => {
    const deps = createDeps();
    const resolve = createInsightsAgentAccessResolver(deps);

    await expect(resolve({ id: 'user-id', role: 'USER', tenantId: 'tenant-a' })).resolves.toEqual(
      [],
    );
  });
});

describe('createInsightsAccessResolver', () => {
  it.each([SystemRoles.ADMIN, 'global-reader'])(
    'preserves tenant-wide statistics and inspection eligibility for %s',
    async (role) => {
      const deps = createDeps();
      deps.hasCapabilityForPrincipals.mockResolvedValue(role === 'global-reader');

      const result = await createInsightsAccessResolver(deps)({
        id: 'user-id',
        role,
        tenantId: 'tenant-a',
      });

      expect(result.agents).toEqual([
        { id: 'agent-b', name: 'Alpha' },
        { id: 'agent-a', name: 'Zulu' },
      ]);
      expect(new Set(result.detailAgentIds)).toEqual(new Set(['agent-a', 'agent-b']));
      expect(deps.findAccessibleResources).not.toHaveBeenCalled();
      expect(deps.getAgents).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, '_id id name tenantId');
    },
  );

  it.each([
    'getAgents',
    'getUserPrincipals',
    'hasCapabilityForPrincipals',
    'findAccessibleResources',
  ] as const)(
    'propagates %s failures instead of returning a broader access result',
    async (method) => {
      const deps = createDeps();
      const error = new Error('lookup failed');
      deps[method].mockRejectedValueOnce(error);
      await expect(
        createInsightsAccessResolver(deps)({ id: 'user-id', tenantId: 'tenant-a' }),
      ).rejects.toBe(error);
    },
  );
});
