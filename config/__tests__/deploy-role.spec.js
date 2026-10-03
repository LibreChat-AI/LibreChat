const {
  deployRole,
  getDeploymentScope,
  loadRoleDefinitions: parseRoleDefinitions,
  mergePermissions,
  validateRoleDefinitions: parseAndValidateRoleDefinitions,
} = require('../deploy-role');

const validateMetadata = jest.fn();
const loadRoleDefinitions = (args) => parseRoleDefinitions(args, validateMetadata);
const validateRoleDefinitions = (input) => parseAndValidateRoleDefinitions(input, validateMetadata);

beforeEach(() => {
  validateMetadata.mockReset();
});

describe('deploy role script', () => {
  it('does not deploy config after an existing-role replacement fails', async () => {
    const green = console.green;
    console.green = jest.fn();
    const service = {
      getRole: jest
        .fn()
        .mockResolvedValueOnce({ name: 'USER', permissions: {} })
        .mockResolvedValueOnce({ name: 'BETA', permissions: {} }),
      updateRole: jest.fn(async () => {
        throw new Error('role replacement failed');
      }),
      upsertRoleConfig: jest.fn(async () => undefined),
    };

    try {
      await expect(
        deployRole(
          {
            name: 'BETA',
            inheritPermissionsFrom: 'USER',
            permissionOverrides: {},
            config: { priority: 10, overrides: {} },
          },
          service,
        ),
      ).rejects.toThrow('role replacement failed');
      expect(service.updateRole).toHaveBeenCalledWith('BETA', {
        permissions: expect.any(Object),
      });
      expect(service.upsertRoleConfig).not.toHaveBeenCalled();
    } finally {
      console.green = green;
    }
  });

  it('requires an explicit base or tenant scope', () => {
    expect(getDeploymentScope(['--base'])).toEqual({ base: true });
    expect(getDeploymentScope(['--tenant', 'tenant-123'])).toEqual({ tenantId: 'tenant-123' });
    expect(() => getDeploymentScope([])).toThrow('exactly one deployment scope');
    expect(() => getDeploymentScope(['--tenant'])).toThrow('requires a tenant ID');
    expect(() => getDeploymentScope(['--tenant', '__SYSTEM__'])).toThrow('reserved tenant ID');
    expect(() => getDeploymentScope(['--tenant=__SYSTEM__'])).toThrow('reserved tenant ID');
    expect(() => getDeploymentScope(['--base', '--tenant', 'tenant-123'])).toThrow(
      'exactly one deployment scope',
    );
  });

  it('does not interpret the tenant ID as a definitions file', () => {
    process.env.ROLE_DEFINITIONS_JSON = JSON.stringify([
      {
        name: 'BETA',
        inheritPermissionsFrom: 'USER',
        permissionOverrides: {},
        config: { priority: 10, overrides: {} },
      },
    ]);

    expect(loadRoleDefinitions(['--tenant', 'tenant-123'])[0].name).toBe('BETA');
    delete process.env.ROLE_DEFINITIONS_JSON;
  });

  it('merges permission overrides without mutating the baseline', () => {
    const baseline = { AGENTS: { USE: true, CREATE: false } };

    expect(mergePermissions(baseline, { AGENTS: { CREATE: true } })).toEqual({
      AGENTS: { USE: true, CREATE: true },
    });
    expect(baseline.AGENTS.CREATE).toBe(false);
  });

  it('fills missing system baseline permissions from current defaults', async () => {
    const green = console.green;
    console.green = jest.fn();
    const service = {
      getRole: jest
        .fn()
        .mockResolvedValueOnce({ name: 'USER', permissions: { AGENTS: { USE: false } } })
        .mockResolvedValueOnce(null),
      createRole: jest.fn(async () => undefined),
      upsertRoleConfig: jest.fn(async () => undefined),
    };

    try {
      await deployRole(
        {
          name: 'BETA',
          inheritPermissionsFrom: 'USER',
          permissionOverrides: {},
          config: { priority: 10, overrides: {} },
        },
        service,
      );

      expect(service.createRole).toHaveBeenCalledWith(
        expect.objectContaining({
          permissions: expect.objectContaining({
            AGENTS: expect.objectContaining({ USE: false }),
            PROMPTS: expect.any(Object),
          }),
        }),
      );
    } finally {
      console.green = green;
    }
  });

  it('loads definitions from an inline parameter', () => {
    const definitions = loadRoleDefinitions([
      '--roles',
      JSON.stringify([
        {
          name: 'BETA',
          inheritPermissionsFrom: 'USER',
          permissionOverrides: {},
          config: { priority: 10, overrides: {} },
        },
      ]),
    ]);

    expect(definitions[0].name).toBe('BETA');
  });

  it('does not add config defaults to partial overrides', () => {
    const [definition] = validateRoleDefinitions([
      {
        name: 'BETA',
        inheritPermissionsFrom: 'USER',
        permissionOverrides: {},
        config: {
          priority: 10,
          overrides: { endpoints: { agents: { capabilities: ['memory'] } } },
        },
      },
    ]);

    expect(definition.config.overrides).toEqual({
      endpoints: { agents: { capabilities: ['memory'] } },
    });
  });

  it('rejects unknown permission and config fields', () => {
    const definition = {
      name: 'BETA',
      inheritPermissionsFrom: 'USER',
      permissionOverrides: {},
      config: { priority: 10, overrides: {} },
    };

    expect(() =>
      validateRoleDefinitions([{ ...definition, permissionOverrides: { AGNETS: {} } }]),
    ).toThrow('AGNETS');
    expect(() =>
      validateRoleDefinitions([
        { ...definition, config: { priority: 10, overrides: { memroy: {} } } },
      ]),
    ).toThrow('memroy');
    expect(() =>
      validateRoleDefinitions([
        { ...definition, config: { priority: 10, overrides: { toString: true } } },
      ]),
    ).toThrow('toString');
  });

  it('rejects system roles as deployment targets', () => {
    expect(() =>
      validateRoleDefinitions([
        {
          name: 'USER',
          inheritPermissionsFrom: 'USER',
          permissionOverrides: {},
          config: { priority: 10, overrides: {} },
        },
      ]),
    ).toThrow('System roles');
  });

  it('rejects self-referential permission inheritance', () => {
    expect(() =>
      validateRoleDefinitions([
        {
          name: 'BETA',
          inheritPermissionsFrom: 'BETA',
          permissionOverrides: {},
          config: { priority: 10, overrides: {} },
        },
      ]),
    ).toThrow('cannot inherit permissions from itself');
  });

  it('rejects indirect permission inheritance cycles', () => {
    expect(() =>
      validateRoleDefinitions([
        {
          name: 'ALPHA',
          inheritPermissionsFrom: 'BETA',
          permissionOverrides: {},
          config: { priority: 10, overrides: {} },
        },
        {
          name: 'BETA',
          inheritPermissionsFrom: 'ALPHA',
          permissionOverrides: {},
          config: { priority: 20, overrides: {} },
        },
      ]),
    ).toThrow('cannot contain a cycle');
  });

  it('orders declared baselines before roles that inherit from them', () => {
    const definitions = validateRoleDefinitions([
      {
        name: 'CHILD',
        inheritPermissionsFrom: 'PARENT',
        permissionOverrides: {},
        config: { priority: 20, overrides: {} },
      },
      {
        name: 'PARENT',
        inheritPermissionsFrom: 'USER',
        permissionOverrides: {},
        config: { priority: 10, overrides: {} },
      },
    ]);

    expect(definitions.map(({ name }) => name)).toEqual(['PARENT', 'CHILD']);
  });

  it('rejects duplicate role definitions', () => {
    const definition = {
      name: 'BETA',
      inheritPermissionsFrom: 'USER',
      permissionOverrides: {},
      config: { priority: 10, overrides: {} },
    };

    expect(() => validateRoleDefinitions([definition, definition])).toThrow(
      'defined more than once',
    );
  });

  it('validates every role description before deployment starts', () => {
    const definition = {
      inheritPermissionsFrom: 'USER',
      permissionOverrides: {},
      config: { priority: 10, overrides: {} },
    };

    validateMetadata.mockImplementation((name, description) => {
      if (description?.length > 2000) {
        throw new TypeError('description must not exceed 2000 characters');
      }
    });

    expect(() =>
      validateRoleDefinitions([
        { ...definition, name: 'ALPHA', description: 'valid' },
        { ...definition, name: 'BETA', description: 'x'.repeat(2001) },
      ]),
    ).toThrow('description must not exceed 2000 characters');
    expect(validateMetadata).toHaveBeenCalledTimes(2);
  });

  it('does not add config defaults inside arrays', () => {
    const [definition] = validateRoleDefinitions([
      {
        name: 'BETA',
        inheritPermissionsFrom: 'USER',
        permissionOverrides: {},
        config: {
          priority: 10,
          overrides: {
            modelSpecs: {
              list: [{ name: 'beta', label: 'Beta', preset: { endpoint: 'agents' } }],
            },
          },
        },
      },
    ]);

    expect(definition.config.overrides.modelSpecs.list[0]).toEqual({
      name: 'beta',
      label: 'Beta',
      preset: { endpoint: 'agents' },
    });
  });
});
