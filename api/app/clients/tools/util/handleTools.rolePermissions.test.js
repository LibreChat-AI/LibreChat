/**
 * `loadTools` is the shared boundary every runtime crosses to equip
 * `file_search` and `execute_code` — agents, and the Assistants required-action
 * flow through `processRequiredActions`, which never passes the agent capability
 * filter. Before this gate, a role with `FILE_SEARCH.USE` or `RUN_CODE.USE` set
 * to false still got the tool: the permission was stored and served, never
 * checked.
 */

const mockGetRoleByName = jest.fn();
const mockPrimeSearchFiles = jest.fn(async () => ({ files: [], toolContext: undefined }));
const mockPrimeCodeFiles = jest.fn(async () => ({ files: [], toolContext: undefined }));
const mockCreateFileSearchTool = jest.fn(async () => ({ name: 'file_search' }));
const mockCreateCodeExecutionTool = jest.fn(() => ({ name: 'execute_code' }));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createCodeExecutionTool: (...args) => mockCreateCodeExecutionTool(...args),
}));

jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  getRoleByName: (...args) => mockGetRoleByName(...args),
}));

jest.mock('~/server/services/Config', () => ({
  ...jest.requireActual('~/server/services/Config'),
  checkCapability: jest.fn(async () => false),
  getMCPServerTools: jest.fn(async () => ({})),
}));

jest.mock('./fileSearch', () => ({
  primeFiles: (...args) => mockPrimeSearchFiles(...args),
  createFileSearchTool: (...args) => mockCreateFileSearchTool(...args),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  primeFiles: (...args) => mockPrimeCodeFiles(...args),
}));

const { Tools, Permissions, PermissionTypes } = require('librechat-data-provider');
const { logger } = require('@librechat/data-schemas');
const { loadTools } = require('./handleTools');

/** Role document shape `checkAccess` reads; both role-gated tools granted. */
const buildRole = (overrides = {}) => ({
  name: 'USER',
  permissions: {
    [PermissionTypes.FILE_SEARCH]: { [Permissions.USE]: true },
    [PermissionTypes.RUN_CODE]: { [Permissions.USE]: true },
    ...overrides,
  },
});

const deny = (permissionType) =>
  mockGetRoleByName.mockResolvedValue(
    buildRole({ [permissionType]: { [Permissions.USE]: false } }),
  );

/** `loadTools` takes the request under a nested `options` key — passing `req` at
 * the top level silently skips every `options.req`-guarded branch. */
const buildOptions = (tools = [Tools.file_search]) => ({
  user: 'user-1',
  tools,
  options: {
    req: { user: { id: 'user-1', role: 'USER' }, config: {}, app: { locals: {} } },
  },
});

const loadedNames = async (tools) => {
  const { loadedTools } = await loadTools(buildOptions(tools));
  return loadedTools.map((tool) => tool.name);
};

describe('loadTools — tool role permission gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetRoleByName.mockResolvedValue(buildRole());
  });

  it('equips file_search when the role permits it', async () => {
    expect(await loadedNames([Tools.file_search])).toContain(Tools.file_search);
  });

  it('does not equip file_search when the role denies it', async () => {
    deny(PermissionTypes.FILE_SEARCH);

    expect(await loadedNames([Tools.file_search])).not.toContain(Tools.file_search);
    /** The tool must not even be constructed — a denied user should never get a
     * tool that merely fails later. */
    expect(mockCreateFileSearchTool).not.toHaveBeenCalled();
  });

  it('equips execute_code when the role permits it', async () => {
    expect(await loadedNames([Tools.execute_code])).toContain(Tools.execute_code);
  });

  /** The Assistants required-action flow reaches this loader directly, so
   *  `RUN_CODE` has to be enforced here and not only on the tool-call route. */
  it('does not equip execute_code when the role denies it', async () => {
    deny(PermissionTypes.RUN_CODE);

    expect(await loadedNames([Tools.execute_code])).not.toContain(Tools.execute_code);
    expect(mockCreateCodeExecutionTool).not.toHaveBeenCalled();
  });

  it('denies only the tool whose permission is missing', async () => {
    deny(PermissionTypes.RUN_CODE);

    const names = await loadedNames([Tools.file_search, Tools.execute_code]);
    expect(names).toContain(Tools.file_search);
    expect(names).not.toContain(Tools.execute_code);
  });

  it('logs the denial with the permission type and user', async () => {
    deny(PermissionTypes.FILE_SEARCH);

    await loadTools(buildOptions([Tools.file_search]));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(PermissionTypes.FILE_SEARCH));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('user-1'));
  });

  it('denies when the role lookup itself throws', async () => {
    mockGetRoleByName.mockRejectedValue(new Error('role lookup failed'));

    /** Fail closed: an unreachable role store must not hand out the tools. */
    const names = await loadedNames([Tools.file_search, Tools.execute_code]);
    expect(names).not.toContain(Tools.file_search);
    expect(names).not.toContain(Tools.execute_code);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('loadTools — GitHub comparison execution eligibility', () => {
  it.each([undefined, new Map()])(
    'does not load an unregistered model-emitted compare call (%p)',
    async (toolRegistry) => {
      const params = buildOptions(['github_compare']);
      params.options.req.config.githubCompare = { enabled: true };
      params.options.toolRegistry = toolRegistry;
      const { loadedTools } = await loadTools(params);
      expect(loadedTools).toEqual([]);
    },
  );
  it('does not load a stale registered comparison when the request disables it', async () => {
    const params = buildOptions(['github_compare']);
    params.options.toolRegistry = new Map([['github_compare', { name: 'github_compare' }]]);
    params.options.req.config.githubCompare = { enabled: false };
    const { loadedTools } = await loadTools(params);
    expect(loadedTools).toEqual([]);
  });
  it('loads the published SDK tool without code capability or workspace admission', async () => {
    const params = buildOptions(['github_compare']);
    params.options.toolRegistry = new Map([['github_compare', { name: 'github_compare' }]]);
    params.options.req.config.githubCompare = { enabled: true };
    const { loadedTools } = await loadTools(params);
    const { GitHubCompareTool } = require('@librechat/agents');
    expect(loadedTools).toHaveLength(1);
    expect(loadedTools[0]).toBeInstanceOf(GitHubCompareTool);
    expect(mockPrimeCodeFiles).not.toHaveBeenCalled();
  });
});
