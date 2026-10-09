const fs = require('fs');
const path = require('path');
const { ResourceType } = require('librechat-data-provider');

/**
 * Maps each ResourceType to the cleanup function name that must appear in
 * deleteUserController's source to prove it is handled during user deletion.
 *
 * When a new ResourceType is added, this test will fail until a corresponding
 * entry is added here (or to NO_USER_CLEANUP_NEEDED) AND the actual cleanup
 * logic is implemented.
 */
const HANDLED_RESOURCE_TYPES = {
  [ResourceType.AGENT]: 'deleteUserAgents',
  [ResourceType.CODE_ENVIRONMENT]: 'deleteUserCodeEnvironments',
  [ResourceType.REMOTE_AGENT]: 'deleteUserAgents',
  [ResourceType.PROMPTGROUP]: 'deleteUserPrompts',
  [ResourceType.MCPSERVER]: 'deleteUserMcpServers',
  [ResourceType.SKILL]: 'deleteUserSkills',
  [ResourceType.SHARED_LINK]: 'deleteAllSharedLinksWithCleanup',
};

/**
 * ResourceTypes that are ACL-tracked but have no per-user deletion semantics
 * (e.g., system resources, public-only). Must be explicitly listed here with
 * a justification to prevent silent omissions.
 */
const NO_USER_CLEANUP_NEEDED = new Set([
  // Example: ResourceType.SYSTEM_TEMPLATE — public/system; not user-owned
]);

describe('deleteUserController - resource type coverage guard', () => {
  let controllerSource;

  beforeAll(() => {
    controllerSource = fs.readFileSync(path.resolve(__dirname, '../UserController.js'), 'utf-8');
  });

  test('every ResourceType must have a documented cleanup handler or explicit exclusion', () => {
    const allTypes = Object.values(ResourceType);
    const handledTypes = Object.keys(HANDLED_RESOURCE_TYPES);
    const unhandledTypes = allTypes.filter(
      (t) => !handledTypes.includes(t) && !NO_USER_CLEANUP_NEEDED.has(t),
    );

    expect(unhandledTypes).toEqual([]);
  });

  test('every cleanup handler referenced in HANDLED_RESOURCE_TYPES must appear in the controller source', () => {
    const uniqueHandlers = [...new Set(Object.values(HANDLED_RESOURCE_TYPES))];

    for (const handler of uniqueHandlers) {
      expect(controllerSource).toContain(handler);
    }
  });
});
