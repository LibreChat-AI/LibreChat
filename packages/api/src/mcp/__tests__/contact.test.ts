import { PermissionBits, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';
import { resolveMCPServerOwnerContacts, type MCPContactDependencies } from '~/mcp/contact';

const OWNER_PERMISSION_BITS =
  PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE;

type ServerContactConfig = Pick<ParsedServerConfig, 'dbId' | 'author' | 'support_contact'>;

const createDependencies = (
  overrides: Partial<MCPContactDependencies> = {},
): jest.Mocked<MCPContactDependencies> =>
  ({
    aggregateAclEntries: jest.fn().mockResolvedValue([]),
    findUsers: jest.fn().mockResolvedValue([]),
    warn: jest.fn(),
    ...overrides,
  }) as jest.Mocked<MCPContactDependencies>;

const server = (values: Partial<ServerContactConfig> = {}): ServerContactConfig => ({
  dbId: 'resource-1',
  author: 'author-1',
  ...values,
});

describe('resolveMCPServerOwnerContacts', () => {
  it('skips explicit contacts and operator-managed servers', async () => {
    const dependencies = createDependencies();

    const result = await resolveMCPServerOwnerContacts(
      {
        explicit: server({ support_contact: { email: 'support@example.com' } }),
        yaml: server({ dbId: undefined, author: undefined }),
      },
      dependencies,
    );

    expect(result).toEqual(new Map());
    expect(dependencies.aggregateAclEntries).not.toHaveBeenCalled();
    expect(dependencies.findUsers).not.toHaveBeenCalled();
  });

  it('uses the first ACL owner and batches owner lookups', async () => {
    const dependencies = createDependencies({
      aggregateAclEntries: jest.fn().mockResolvedValue([
        { _id: 'resource-1', principalId: 'owner-1' },
        { _id: 'resource-2', principalId: 'owner-2' },
      ]),
      findUsers: jest.fn().mockResolvedValue([
        { _id: 'owner-1', name: 'First Owner' },
        { _id: 'owner-2', username: 'Second Owner' },
      ]),
    });

    const result = await resolveMCPServerOwnerContacts(
      {
        first: server(),
        second: server({ dbId: 'resource-2', author: 'author-2' }),
      },
      dependencies,
    );

    expect(dependencies.aggregateAclEntries).toHaveBeenCalledWith([
      {
        $match: {
          resourceType: ResourceType.MCPSERVER,
          resourceId: { $in: ['resource-1', 'resource-2'] },
          principalType: PrincipalType.USER,
          permBits: OWNER_PERMISSION_BITS,
        },
      },
      { $sort: { grantedAt: 1, createdAt: 1, _id: 1 } },
      { $group: { _id: '$resourceId', principalId: { $first: '$principalId' } } },
    ]);
    expect(dependencies.findUsers).toHaveBeenCalledTimes(1);
    expect(dependencies.findUsers).toHaveBeenCalledWith(
      { _id: { $in: ['owner-1', 'owner-2'] } },
      'name username',
    );
    expect(result).toEqual(
      new Map([
        ['first', { name: 'First Owner' }],
        ['second', { name: 'Second Owner' }],
      ]),
    );
  });

  it('falls back to the stored author when no ACL owner exists', async () => {
    const dependencies = createDependencies({
      findUsers: jest.fn().mockResolvedValue([{ _id: 'author-1', name: 'Legacy Owner' }]),
    });

    const result = await resolveMCPServerOwnerContacts({ legacy: server() }, dependencies);

    expect(result.get('legacy')).toEqual({ name: 'Legacy Owner' });
  });

  it('does not expose email-shaped owner display values', async () => {
    const dependencies = createDependencies({
      findUsers: jest
        .fn()
        .mockResolvedValue([
          { _id: 'author-1', name: 'owner@example.com', username: 'safe-owner' },
        ]),
    });

    const result = await resolveMCPServerOwnerContacts({ server: server() }, dependencies);

    expect(result.get('server')).toEqual({ name: 'safe-owner' });
  });

  it('omits contacts for missing users and wholly unsafe display values', async () => {
    const missingDependencies = createDependencies();
    const unsafeDependencies = createDependencies({
      findUsers: jest
        .fn()
        .mockResolvedValue([{ _id: 'author-1', name: 'owner@example.com', username: 'x@y.test' }]),
    });

    expect(await resolveMCPServerOwnerContacts({ server: server() }, missingDependencies)).toEqual(
      new Map(),
    );
    expect(await resolveMCPServerOwnerContacts({ server: server() }, unsafeDependencies)).toEqual(
      new Map(),
    );
  });

  it('falls back to authors and logs when the ACL lookup fails', async () => {
    const error = new Error('ACL unavailable');
    const dependencies = createDependencies({
      aggregateAclEntries: jest.fn().mockRejectedValue(error),
      findUsers: jest.fn().mockResolvedValue([{ _id: 'author-1', name: 'Author Owner' }]),
    });

    const result = await resolveMCPServerOwnerContacts({ server: server() }, dependencies);

    expect(result.get('server')).toEqual({ name: 'Author Owner' });
    expect(dependencies.warn).toHaveBeenCalledWith(
      '[MCP] Failed to resolve MCP server owner ACL entries',
      error,
    );
  });

  it('returns no contacts and logs when the user lookup fails', async () => {
    const error = new Error('Users unavailable');
    const dependencies = createDependencies({ findUsers: jest.fn().mockRejectedValue(error) });

    const result = await resolveMCPServerOwnerContacts({ server: server() }, dependencies);

    expect(result).toEqual(new Map());
    expect(dependencies.warn).toHaveBeenCalledWith(
      '[MCP] Failed to resolve MCP server owner users',
      error,
    );
  });

  it('does not mutate source configurations', async () => {
    const config = server();
    const dependencies = createDependencies({
      findUsers: jest.fn().mockResolvedValue([{ _id: 'author-1', name: 'Owner' }]),
    });

    await resolveMCPServerOwnerContacts({ server: config }, dependencies);

    expect(config).toEqual(server());
    expect(config).not.toHaveProperty('owner_contact');
  });
});
