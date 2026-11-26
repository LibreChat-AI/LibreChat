import { Types } from 'mongoose';
import { PermissionBits, PrincipalType, SystemRoles } from 'librechat-data-provider';
import type { InsightsAgentAccessDeps } from './access';
import { createInsightsAccessResolver } from './access';

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

  it('gives details for Insights grants, numbers for editing grants and nothing for viewing alone', async () => {
    const agentC = { _id: new Types.ObjectId(), id: 'agent-c', name: 'Mike', tenantId: 'tenant-a' };
    const grants = new Map([
      [PermissionBits.VIEW, [agentA._id, agentB._id, agentC._id]],
      [PermissionBits.VIEW | PermissionBits.EDIT, [agentA._id, agentB._id]],
      [PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS, [agentA._id]],
    ]);
    const deps = createDeps();
    deps.getAgents.mockResolvedValue([agentA, agentB, agentC]);
    deps.findAccessibleResources.mockImplementation(
      async (_principals, _type, bits) => grants.get(bits) ?? [],
    );

    expect(
      await createInsightsAccessResolver(deps)({ id: 'user-id', tenantId: 'tenant-a' }),
    ).toEqual({
      agents: [
        { id: 'agent-b', name: 'Alpha' },
        { id: 'agent-a', name: 'Zulu' },
      ],
      detailAgentIds: ['agent-a'],
    });
    const queriedTypes = deps.findAccessibleResources.mock.calls.flatMap(([principals]) =>
      principals.map(({ principalType }) => principalType),
    );
    expect(queriedTypes).not.toContain(PrincipalType.PUBLIC);
  });

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
