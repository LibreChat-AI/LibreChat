import { Permissions, PermissionTypes, permissionsSchema } from './permissions';
import { SystemRoles, roleDefaults } from './roles';

const RESOURCE_MANAGEMENT_FIELDS: Permissions[] = [
  Permissions.CREATE,
  Permissions.SHARE,
  Permissions.SHARE_PUBLIC,
];

/**
 * Permission types where CREATE/SHARE/SHARE_PUBLIC must default to false for USER.
 * MEMORIES is excluded: its CREATE/READ/UPDATE apply to the user's own private data.
 * AGENTS/PROMPTS are excluded: CREATE=true is intentional (users own their agents/prompts).
 * Add new types here if they gate shared/multi-user resources.
 */
const RESOURCE_PERMISSION_TYPES: PermissionTypes[] = [
  PermissionTypes.MCP_SERVERS,
  PermissionTypes.REMOTE_AGENTS,
];

describe('roleDefaults', () => {
  describe('USER role', () => {
    const userPerms = roleDefaults[SystemRoles.USER].permissions;

    it('should have explicit values for every field in every multi-field permission type', () => {
      const schemaShape = permissionsSchema.shape;

      for (const [permType, subSchema] of Object.entries(schemaShape)) {
        const fieldNames = Object.keys(subSchema.shape);
        if (fieldNames.length <= 1) {
          continue;
        }

        const userValues = userPerms[permType as PermissionTypes] as Record<string, boolean>;

        for (const field of fieldNames) {
          expect({
            permType,
            field,
            value: userValues[field],
          }).toEqual(
            expect.objectContaining({
              permType,
              field,
              value: expect.any(Boolean),
            }),
          );
        }
      }
    });

    it('should never grant CREATE, SHARE, or SHARE_PUBLIC by default for resource-management types', () => {
      for (const permType of RESOURCE_PERMISSION_TYPES) {
        const permissions = userPerms[permType] as Record<string, boolean>;
        for (const field of RESOURCE_MANAGEMENT_FIELDS) {
          if (permissions[field] === undefined) {
            continue;
          }
          expect({
            permType,
            field,
            value: permissions[field],
          }).toEqual(
            expect.objectContaining({
              permType,
              field,
              value: false,
            }),
          );
        }
      }
    });

    it('should cover every permission type that has CREATE, SHARE, or SHARE_PUBLIC fields', () => {
      const schemaShape = permissionsSchema.shape;
      const restrictedSet = new Set<string>(RESOURCE_PERMISSION_TYPES);

      for (const [permType, subSchema] of Object.entries(schemaShape)) {
        const fieldNames = Object.keys(subSchema.shape);
        const hasResourceFields = fieldNames.some((f) =>
          RESOURCE_MANAGEMENT_FIELDS.includes(f as Permissions),
        );
        if (!hasResourceFields) {
          continue;
        }

        const isTracked =
          restrictedSet.has(permType) ||
          permType === PermissionTypes.MEMORIES ||
          permType === PermissionTypes.PROMPTS ||
          permType === PermissionTypes.AGENTS ||
          permType === PermissionTypes.SKILLS ||
          permType === PermissionTypes.SHARED_LINKS ||
          permType === PermissionTypes.SCHEDULES;

        expect({
          permType,
          tracked: isTracked,
        }).toEqual(
          expect.objectContaining({
            permType,
            tracked: true,
          }),
        );
      }
    });
  });

  describe('ADMIN role', () => {
    const adminPerms = roleDefaults[SystemRoles.ADMIN].permissions;

    it('should have explicit values for every field in every permission type', () => {
      const schemaShape = permissionsSchema.shape;

      for (const [permType, subSchema] of Object.entries(schemaShape)) {
        const fieldNames = Object.keys(subSchema.shape);
        const adminValues = adminPerms[permType as PermissionTypes] as Record<string, boolean>;

        for (const field of fieldNames) {
          expect({
            permType,
            field,
            value: adminValues[field],
          }).toEqual(
            expect.objectContaining({
              permType,
              field,
              value: expect.any(Boolean),
            }),
          );
        }
      }
    });
  });

  describe('SKILLS permission defaults', () => {
    it('grants ADMIN all four skill permissions by default', () => {
      const adminSkills = roleDefaults[SystemRoles.ADMIN].permissions[
        PermissionTypes.SKILLS
      ] as Record<string, boolean>;
      expect(adminSkills).toEqual({
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
      });
    });

    it('grants USER USE+CREATE but no sharing by default', () => {
      const userSkills = roleDefaults[SystemRoles.USER].permissions[
        PermissionTypes.SKILLS
      ] as Record<string, boolean>;
      expect(userSkills).toEqual({
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: false,
        [Permissions.SHARE_PUBLIC]: false,
      });
    });
  });

  describe('MCP_SERVERS.CONFIGURE_OBO defaults', () => {
    it('grants ADMIN CONFIGURE_OBO by default', () => {
      const adminMcp = roleDefaults[SystemRoles.ADMIN].permissions[
        PermissionTypes.MCP_SERVERS
      ] as Record<string, boolean>;
      expect(adminMcp[Permissions.CONFIGURE_OBO]).toBe(true);
    });

    it('does not grant CONFIGURE_OBO to USER by default — gates the OBO config layer', () => {
      const userMcp = roleDefaults[SystemRoles.USER].permissions[
        PermissionTypes.MCP_SERVERS
      ] as Record<string, boolean>;
      expect(userMcp[Permissions.CONFIGURE_OBO]).toBe(false);
    });
  });
});
