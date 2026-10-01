import { PermissionBits, PrincipalType, ResourceType, SystemRoles } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import {
  auditInsightsPermissionChanges,
  maskAgentInsightsBit,
  validateInsightsPermissionUpdates,
} from './insightsPermissions';

describe('Insights permissions', () => {
  test('allows only admins to assign a boolean agent Insights grant', () => {
    expect(
      validateInsightsPermissionUpdates({
        resourceType: ResourceType.AGENT,
        userRole: SystemRoles.USER,
        updatedPrincipals: [{ type: PrincipalType.USER, viewInsights: true }],
      }),
    ).toEqual({ status: 403, error: 'Only administrators can change Insights access' });
    expect(
      validateInsightsPermissionUpdates({
        resourceType: ResourceType.AGENT,
        userRole: SystemRoles.ADMIN,
        updatedPrincipals: [{ type: PrincipalType.USER, viewInsights: true }],
      }),
    ).toBeNull();
  });

  test('hides the Insights bit from non-admin effective permissions', () => {
    expect(
      maskAgentInsightsBit({
        resourceType: ResourceType.AGENT,
        userRole: SystemRoles.USER,
        permBits: PermissionBits.VIEW | PermissionBits.VIEW_INSIGHTS,
      }),
    ).toBe(PermissionBits.VIEW);
  });

  test('restores unaudited changes when fail-closed audit persistence fails', async () => {
    const restore = jest.fn().mockResolvedValue(undefined);
    const record = jest.fn().mockRejectedValue(new Error('audit unavailable'));
    const change = {
      action: 'assigned' as const,
      previousEntry: null,
      writtenEntry: null,
      principal: { type: PrincipalType.ROLE, id: SystemRoles.USER },
    };
    const req = {
      user: {
        _id: { toString: () => 'admin-id' },
        id: 'admin-id',
        email: 'admin@example.com',
        role: SystemRoles.ADMIN,
        tenantId: 'tenant-a',
      },
      headers: {},
    } as unknown as ServerRequest;

    await expect(
      auditInsightsPermissionChanges({
        req,
        resourceId: 'resource-id',
        changes: [change],
        failClosed: true,
        deps: {
          getAgent: jest.fn().mockResolvedValue({ id: 'agent-id', name: 'Agent' }),
          recordAuditEntry: record,
          restoreInsightsPermissionChanges: restore,
          logger: { error: jest.fn() },
        },
      }),
    ).rejects.toMatchObject({ statusCode: 500 });
    expect(restore).toHaveBeenCalledWith([change]);
  });
});
