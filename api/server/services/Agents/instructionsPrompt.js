const { logger } = require('@librechat/data-schemas');
const {
  checkAccess,
  createPromptService,
  assertModelBoundContent,
  createInstructionsPromptAccess,
} = require('@librechat/api');
const { Permissions, PermissionTypes } = require('librechat-data-provider');
const {
  grantPermission,
  getResourcePermissionsMap,
} = require('~/server/services/PermissionService');
const db = require('~/models');

/** Wiring only: the write/present decision logic lives in `@librechat/api` (`createInstructionsPromptAccess`, `checkInstructionsPromptWrite`). */
const instructionsPromptAccess = createInstructionsPromptAccess({
  getResourcePermissionsMap,
  promptService: createPromptService({ db, grantPermission }),
  assertAgentInstructionsContent: ({ instructions, filters }) =>
    assertModelBoundContent({ filters, agents: [{ instructions }] }),
  /** The same role-level gate `checkPromptAccess` applies to every `/prompts` route
   *  (`PermissionTypes.PROMPTS`, `Permissions.USE`). Only `.role` is read, so the
   *  `{ id, role }` identity `validateLinkWrite` carries is enough. */
  canUsePrompts: (user, req) =>
    checkAccess({
      req,
      user,
      permissionType: PermissionTypes.PROMPTS,
      permissions: [Permissions.USE],
      getRoleByName: db.getRoleByName,
    }),
  logger,
});

module.exports = { instructionsPromptAccess };
