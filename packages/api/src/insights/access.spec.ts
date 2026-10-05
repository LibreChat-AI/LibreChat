import { Types } from 'mongoose';
import { PermissionBits, PrincipalType, ResourceType, SystemRoles } from 'librechat-data-provider';
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
  it('does not promote an agent-specific grant into tenant-wide Studio access', async () => {
    const deps = createDeps();
    deps.findAccessibleResources.mockResolvedValue([agentA._id]);
    expect(
      await createInsightsAccessResolver(deps)({ id: 'user-id', tenantId: 'tenant-a' }),
    ).toEqual({
      agents: [{ id: 'agent-a', name: 'Zulu' }],
      media: false,
    });
  });

  it('allows a global Insights reader into Studio even when no agents exist', async () => {
    const deps = createDeps();
    deps.getAgents.mockResolvedValue([]);
    deps.hasCapabilityForPrincipals.mockResolvedValue(true);
    expect(
      await createInsightsAccessResolver(deps)({ id: 'user-id', tenantId: 'tenant-a' }),
    ).toEqual({ agents: [], media: true });
  });
  it('returns every tenant agent for a literal admin', async () => {
    const deps = createDeps();
    const resolve = createInsightsAccessResolver(deps);

    const result = await resolve({
      id: 'admin-id',
      role: SystemRoles.ADMIN,
      tenantId: 'tenant-a',
    });

    expect(deps.getAgents).toHaveBeenCalledWith({ tenantId: 'tenant-a' }, '_id id name tenantId');
    expect(deps.getUserPrincipals).not.toHaveBeenCalled();
    expect(result).toEqual({
      agents: [
        { id: 'agent-b', name: 'Alpha' },
        { id: 'agent-a', name: 'Zulu' },
      ],
      media: true,
    });
  });

  it('returns every tenant agent for a global read:insights grant', async () => {
    const deps = createDeps();
    deps.hasCapabilityForPrincipals.mockResolvedValue(true);
    const resolve = createInsightsAccessResolver(deps);

    const result = await resolve({ id: 'user-id', role: 'USER', tenantId: 'tenant-a' });

    expect(deps.findAccessibleResources).not.toHaveBeenCalled();
    expect(result.agents).toHaveLength(2);
    expect(result.media).toBe(true);
  });

  it('requires VIEW and VIEW_INSIGHTS on the same non-public ACL entry', async () => {
    const deps = createDeps();
    deps.findAccessibleResources.mockResolvedValue([agentA._id]);
    const resolve = createInsightsAccessResolver(deps);

    const result = await resolve({ id: 'user-id', role: 'USER', tenantId: 'tenant-a' });

    expect(deps.findAccessibleResources).toHaveBeenCalledWith(
      [expect.objectContaining({ principalType: PrincipalType.USER })],
      ResourceType.AGENT,
      PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
      [agentA._id, agentB._id],
    );
    expect(result).toEqual({ agents: [{ id: 'agent-a', name: 'Zulu' }], media: false });
  });

  it('returns no agents without a global or per-agent grant', async () => {
    const deps = createDeps();
    const resolve = createInsightsAccessResolver(deps);

    await expect(resolve({ id: 'user-id', role: 'USER', tenantId: 'tenant-a' })).resolves.toEqual({
      agents: [],
      media: false,
    });
  });
});
