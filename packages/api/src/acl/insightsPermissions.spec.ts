import { PermissionBits, PrincipalType, ResourceType, SystemRoles } from 'librechat-data-provider';
import { maskAgentInsightsBit, validateInsightsPermissionUpdates } from './insightsPermissions';

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
});
