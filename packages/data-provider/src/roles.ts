import { z } from 'zod';
import {
  Permissions,
  PermissionTypes,
  permissionsSchema,
  agentPermissionsSchema,
  promptPermissionsSchema,
  skillPermissionsSchema,
  memoryPermissionsSchema,
  runCodePermissionsSchema,
  bookmarkPermissionsSchema,
  webSearchPermissionsSchema,
  fileSearchPermissionsSchema,
  multiConvoPermissionsSchema,
  mcpServersPermissionsSchema,
  schedulesPermissionsSchema,
  sharedLinksPermissionsSchema,
  peoplePickerPermissionsSchema,
  remoteAgentsPermissionsSchema,
  temporaryChatPermissionsSchema,
  fileCitationsPermissionsSchema,
} from './permissions';

/**
 * Enum for System Defined Roles
 */
export enum SystemRoles {
  /**
   * The Admin role
   */
  ADMIN = 'ADMIN',
  /**
   * The default user role
   */
  USER = 'USER',
}

export const roleSchema = z.object({
  name: z.string(),
  permissions: permissionsSchema,
});

export type TRole = z.infer<typeof roleSchema>;

const defaultRolesSchema = z.object({
  [SystemRoles.ADMIN]: roleSchema.extend({
    name: z.literal(SystemRoles.ADMIN),
    permissions: permissionsSchema.extend({
      [PermissionTypes.PROMPTS]: promptPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
        [Permissions.CREATE]: z.boolean().default(true),
        [Permissions.SHARE]: z.boolean().default(true),
        [Permissions.SHARE_PUBLIC]: z.boolean().default(true),
      }),
      [PermissionTypes.BOOKMARKS]: bookmarkPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
      }),
      [PermissionTypes.MEMORIES]: memoryPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
        [Permissions.CREATE]: z.boolean().default(true),
        [Permissions.UPDATE]: z.boolean().default(true),
        [Permissions.READ]: z.boolean().default(true),
        [Permissions.OPT_OUT]: z.boolean().default(true),
      }),
      [PermissionTypes.AGENTS]: agentPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
        [Permissions.CREATE]: z.boolean().default(true),
        [Permissions.SHARE]: z.boolean().default(true),
        [Permissions.SHARE_PUBLIC]: z.boolean().default(true),
      }),
      [PermissionTypes.MULTI_CONVO]: multiConvoPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
      }),
      [PermissionTypes.TEMPORARY_CHAT]: temporaryChatPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
      }),
      [PermissionTypes.RUN_CODE]: runCodePermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
      }),
      [PermissionTypes.WEB_SEARCH]: webSearchPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
      }),
      [PermissionTypes.PEOPLE_PICKER]: peoplePickerPermissionsSchema.extend({
        [Permissions.VIEW_USERS]: z.boolean().default(true),
        [Permissions.VIEW_GROUPS]: z.boolean().default(true),
        [Permissions.VIEW_ROLES]: z.boolean().default(true),
      }),
      [PermissionTypes.MARKETPLACE]: z.object({
        [Permissions.USE]: z.boolean().default(false),
      }),
      [PermissionTypes.FILE_SEARCH]: fileSearchPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
      }),
      [PermissionTypes.FILE_CITATIONS]: fileCitationsPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
      }),
      [PermissionTypes.MCP_SERVERS]: mcpServersPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
        [Permissions.CREATE]: z.boolean().default(true),
        [Permissions.SHARE]: z.boolean().default(true),
        [Permissions.SHARE_PUBLIC]: z.boolean().default(true),
        [Permissions.CONFIGURE_OBO]: z.boolean().default(true),
      }),
      [PermissionTypes.REMOTE_AGENTS]: remoteAgentsPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
        [Permissions.CREATE]: z.boolean().default(true),
        [Permissions.SHARE]: z.boolean().default(true),
        [Permissions.SHARE_PUBLIC]: z.boolean().default(true),
      }),
      [PermissionTypes.SKILLS]: skillPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
        [Permissions.CREATE]: z.boolean().default(true),
        [Permissions.SHARE]: z.boolean().default(true),
        [Permissions.SHARE_PUBLIC]: z.boolean().default(true),
      }),
      [PermissionTypes.SHARED_LINKS]: sharedLinksPermissionsSchema.extend({
        [Permissions.CREATE]: z.boolean().default(true),
        [Permissions.SHARE]: z.boolean().default(true),
        [Permissions.SHARE_PUBLIC]: z.boolean().default(true),
      }),
      [PermissionTypes.SCHEDULES]: schedulesPermissionsSchema.extend({
        [Permissions.USE]: z.boolean().default(true),
        [Permissions.CREATE]: z.boolean().default(true),
      }),
    }),
  }),
  [SystemRoles.USER]: roleSchema.extend({
    name: z.literal(SystemRoles.USER),
    permissions: permissionsSchema,
  }),
});

const systemRoleSet = new Set(Object.values(SystemRoles).map((r) => r.toUpperCase()));

/** Case-insensitive check for reserved system role names. */
export function isSystemRoleName(name: string | undefined | null): boolean {
  if (!name) {
    return false;
  }
  return systemRoleSet.has(name.toUpperCase());
}

export const roleDefaults = defaultRolesSchema.parse({
  [SystemRoles.ADMIN]: {
    name: SystemRoles.ADMIN,
    permissions: {
      [PermissionTypes.PROMPTS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
      },
      [PermissionTypes.BOOKMARKS]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.MEMORIES]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.UPDATE]: true,
        [Permissions.READ]: true,
        [Permissions.OPT_OUT]: true,
      },
      [PermissionTypes.AGENTS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
      },
      [PermissionTypes.MULTI_CONVO]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.TEMPORARY_CHAT]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.RUN_CODE]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.WEB_SEARCH]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.PEOPLE_PICKER]: {
        [Permissions.VIEW_USERS]: true,
        [Permissions.VIEW_GROUPS]: true,
        [Permissions.VIEW_ROLES]: true,
      },
      [PermissionTypes.MARKETPLACE]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.FILE_SEARCH]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.FILE_CITATIONS]: {
        [Permissions.USE]: true,
      },
      [PermissionTypes.MCP_SERVERS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
        [Permissions.CONFIGURE_OBO]: true,
      },
      [PermissionTypes.REMOTE_AGENTS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
      },
      [PermissionTypes.SKILLS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
      },
      [PermissionTypes.SHARED_LINKS]: {
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
      },
      [PermissionTypes.SCHEDULES]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
      },
    },
  },
  [SystemRoles.USER]: {
    name: SystemRoles.USER,
    permissions: {
      [PermissionTypes.PROMPTS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: false,
        [Permissions.SHARE_PUBLIC]: false,
      },
      [PermissionTypes.BOOKMARKS]: {},
      [PermissionTypes.MEMORIES]: {},
      [PermissionTypes.AGENTS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: false,
        [Permissions.SHARE_PUBLIC]: false,
      },
      [PermissionTypes.MULTI_CONVO]: {},
      [PermissionTypes.TEMPORARY_CHAT]: {},
      [PermissionTypes.RUN_CODE]: {},
      [PermissionTypes.WEB_SEARCH]: {},
      [PermissionTypes.PEOPLE_PICKER]: {
        [Permissions.VIEW_USERS]: false,
        [Permissions.VIEW_GROUPS]: false,
        [Permissions.VIEW_ROLES]: false,
      },
      [PermissionTypes.MARKETPLACE]: {
        [Permissions.USE]: false,
      },
      [PermissionTypes.FILE_SEARCH]: {},
      [PermissionTypes.FILE_CITATIONS]: {},
      [PermissionTypes.MCP_SERVERS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: false,
        [Permissions.SHARE]: false,
        [Permissions.SHARE_PUBLIC]: false,
        [Permissions.CONFIGURE_OBO]: false,
      },
      [PermissionTypes.REMOTE_AGENTS]: {
        [Permissions.USE]: false,
        [Permissions.CREATE]: false,
        [Permissions.SHARE]: false,
        [Permissions.SHARE_PUBLIC]: false,
      },
      [PermissionTypes.SKILLS]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: false,
        [Permissions.SHARE_PUBLIC]: false,
      },
      [PermissionTypes.SHARED_LINKS]: {
        [Permissions.CREATE]: true,
        [Permissions.SHARE]: true,
        [Permissions.SHARE_PUBLIC]: true,
      },
      [PermissionTypes.SCHEDULES]: {
        [Permissions.USE]: true,
        [Permissions.CREATE]: true,
      },
    },
  },
});
