import { Schema } from 'mongoose';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { IRole } from '~/types';

/**
 * Uses a sub-schema for permissions. Notice we disable `_id` for this subdocument.
 */
const rolePermissionsSchema = new Schema(
  {
    [PermissionTypes.BOOKMARKS]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.PROMPTS]: {
      [Permissions.USE]: { type: Boolean },
      [Permissions.CREATE]: { type: Boolean },
      [Permissions.SHARE]: { type: Boolean },
      [Permissions.SHARE_PUBLIC]: { type: Boolean },
    },
    [PermissionTypes.MEMORIES]: {
      [Permissions.USE]: { type: Boolean },
      [Permissions.CREATE]: { type: Boolean },
      [Permissions.UPDATE]: { type: Boolean },
      [Permissions.READ]: { type: Boolean },
      [Permissions.OPT_OUT]: { type: Boolean },
    },
    [PermissionTypes.AGENTS]: {
      [Permissions.USE]: { type: Boolean },
      [Permissions.CREATE]: { type: Boolean },
      [Permissions.SHARE]: { type: Boolean },
      [Permissions.SHARE_PUBLIC]: { type: Boolean },
    },
    [PermissionTypes.MULTI_CONVO]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.TEMPORARY_CHAT]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.RUN_CODE]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.WEB_SEARCH]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.PEOPLE_PICKER]: {
      [Permissions.VIEW_USERS]: { type: Boolean },
      [Permissions.VIEW_GROUPS]: { type: Boolean },
      [Permissions.VIEW_ROLES]: { type: Boolean },
    },
    [PermissionTypes.MARKETPLACE]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.FILE_SEARCH]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.FILE_CITATIONS]: {
      [Permissions.USE]: { type: Boolean },
    },
    [PermissionTypes.MCP_SERVERS]: {
      [Permissions.USE]: { type: Boolean },
      [Permissions.CREATE]: { type: Boolean },
      [Permissions.SHARE]: { type: Boolean },
      [Permissions.SHARE_PUBLIC]: { type: Boolean },
      [Permissions.CONFIGURE_OBO]: { type: Boolean },
    },
    [PermissionTypes.REMOTE_AGENTS]: {
      [Permissions.USE]: { type: Boolean },
      [Permissions.CREATE]: { type: Boolean },
      [Permissions.SHARE]: { type: Boolean },
      [Permissions.SHARE_PUBLIC]: { type: Boolean },
    },
    [PermissionTypes.SKILLS]: {
      [Permissions.USE]: { type: Boolean },
      [Permissions.CREATE]: { type: Boolean },
      [Permissions.SHARE]: { type: Boolean },
      [Permissions.SHARE_PUBLIC]: { type: Boolean },
    },
    [PermissionTypes.SHARED_LINKS]: {
      [Permissions.CREATE]: { type: Boolean },
      [Permissions.SHARE]: { type: Boolean },
      [Permissions.SHARE_PUBLIC]: { type: Boolean },
    },
    [PermissionTypes.SCHEDULES]: {
      [Permissions.USE]: { type: Boolean },
      [Permissions.CREATE]: { type: Boolean },
    },
  },
  { _id: false },
);

const roleSchema: Schema<IRole> = new Schema({
  name: { type: String, required: true, index: true },
  description: { type: String, default: '' },
  permissions: {
    type: rolePermissionsSchema,
  },
  tenantId: {
    type: String,
    index: true,
  },
});

roleSchema.index({ name: 1, tenantId: 1 }, { unique: true });

export default roleSchema;
