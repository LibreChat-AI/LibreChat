jest.mock('@microsoft/microsoft-graph-client');
jest.mock('~/strategies/openidStrategy');
jest.mock('~/cache/getLogStores');
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
  },
}));
jest.mock('~/config', () => ({
  logger: {
    error: jest.fn(),
    debug: jest.fn(),
  },
  createAxiosInstance: jest.fn(() => ({
    create: jest.fn(),
    defaults: {},
  })),
}));

jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(),
}));

const mongoose = require('mongoose');
const client = require('openid-client');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Client } = require('@microsoft/microsoft-graph-client');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const getLogStores = require('~/cache/getLogStores');
const GraphApiService = require('./GraphApiService');

describe('GraphApiService', () => {
  let mongoServer;
  let mockGraphClient;
  let mockTokensCache;
  let mockOpenIdConfig;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(() => {
    // Clean up environment variables
    delete process.env.OPENID_GRAPH_SCOPES;
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await mongoose.connection.dropDatabase();

    // Set up environment variable for People.Read scope
    process.env.OPENID_GRAPH_SCOPES = 'User.Read,People.Read,Group.Read.All';

    // Mock Graph client
    mockGraphClient = {
      api: jest.fn().mockReturnThis(),
      search: jest.fn().mockReturnThis(),
      filter: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      header: jest.fn().mockReturnThis(),
      top: jest.fn().mockReturnThis(),
      get: jest.fn(),
      post: jest.fn(),
    };

    Client.init.mockReturnValue(mockGraphClient);

    // Mock tokens cache
    mockTokensCache = {
      get: jest.fn(),
      set: jest.fn(),
    };
    getLogStores.mockReturnValue(mockTokensCache);

    // Mock OpenID config
    mockOpenIdConfig = {
      client_id: 'test-client-id',
      issuer: 'https://test-issuer.com',
    };
    getOpenIdConfig.mockReturnValue(mockOpenIdConfig);

    // Mock openid-client (using the existing jest mock configuration)
    if (client.genericGrantRequest) {
      client.genericGrantRequest.mockResolvedValue({
        access_token: 'mocked-graph-token',
        expires_in: 3600,
      });
    }
  });

  describe('Dependency Contract Tests', () => {
    it('should fail if getOpenIdConfig interface changes', () => {
      // Reason: Ensure getOpenIdConfig returns expected structure
      const config = getOpenIdConfig();

      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
      // Add specific property checks that GraphApiService depends on
      expect(config).toHaveProperty('client_id');
      expect(config).toHaveProperty('issuer');

      // Ensure the function is callable
      expect(typeof getOpenIdConfig).toBe('function');
    });

    it('should fail if openid-client.genericGrantRequest interface changes', () => {
      // Reason: Ensure client.genericGrantRequest maintains expected signature
      if (client.genericGrantRequest) {
        expect(typeof client.genericGrantRequest).toBe('function');

        // Test that it accepts the expected parameters
        const mockCall = client.genericGrantRequest(
          mockOpenIdConfig,
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
          {
            scope: 'test-scope',
            assertion: 'test-token',
            requested_token_use: 'on_behalf_of',
          },
        );

        expect(mockCall).toBeDefined();
      }
    });

    it('should fail if Microsoft Graph Client interface changes', () => {
      // Reason: Ensure Graph Client maintains expected fluent API
      expect(typeof Client.init).toBe('function');

      const client = Client.init({ authProvider: jest.fn() });
      expect(client).toHaveProperty('api');
      expect(typeof client.api).toBe('function');
    });
  });

  describe('createGraphClient', () => {
    it('should create graph client with exchanged token', async () => {
      const accessToken = 'test-access-token';
      const sub = 'test-user-id';

      const result = await GraphApiService.createGraphClient(accessToken, sub);

      expect(getOpenIdConfig).toHaveBeenCalled();
      expect(Client.init).toHaveBeenCalledWith({
        authProvider: expect.any(Function),
      });
      expect(result).toBe(mockGraphClient);
    });

    it('should handle token exchange errors gracefully', async () => {
      if (client.genericGrantRequest) {
        client.genericGrantRequest.mockRejectedValue(new Error('Token exchange failed'));
      }

      await expect(GraphApiService.createGraphClient('invalid-token', 'test-user')).rejects.toThrow(
        'Token exchange failed',
      );
    });
  });

  describe('exchangeTokenForGraphAccess', () => {
    it('should return cached token if available', async () => {
      const cachedToken = { access_token: 'cached-token' };
      mockTokensCache.get.mockResolvedValue(cachedToken);

      const result = await GraphApiService.exchangeTokenForGraphAccess(
        mockOpenIdConfig,
        'test-token',
        'test-user',
      );

      expect(result).toBe('cached-token');
      expect(mockTokensCache.get).toHaveBeenCalledWith('test-user:graph');
      if (client.genericGrantRequest) {
        expect(client.genericGrantRequest).not.toHaveBeenCalled();
      }
    });

    it('should exchange token and cache result', async () => {
      mockTokensCache.get.mockResolvedValue(null);

      const result = await GraphApiService.exchangeTokenForGraphAccess(
        mockOpenIdConfig,
        'test-token',
        'test-user',
      );

      if (client.genericGrantRequest) {
        expect(client.genericGrantRequest).toHaveBeenCalledWith(
          mockOpenIdConfig,
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
          {
            scope:
              'https://graph.microsoft.com/User.Read https://graph.microsoft.com/People.Read https://graph.microsoft.com/Group.Read.All',
            assertion: 'test-token',
            requested_token_use: 'on_behalf_of',
          },
        );
      }

      /** The entry expires 30s (OPENID_EXPIRY_BUFFER_SECONDS) before the credential it holds, so a
       *  token served from cache cannot expire in transit and 401 against Graph. */
      expect(mockTokensCache.set).toHaveBeenCalledWith(
        'test-user:graph',
        { access_token: 'mocked-graph-token' },
        3570000,
      );

      expect(result).toBe('mocked-graph-token');
    });

    it('should use custom scopes from environment', async () => {
      const originalEnv = process.env.OPENID_GRAPH_SCOPES;
      process.env.OPENID_GRAPH_SCOPES = 'Custom.Read,Custom.Write';

      mockTokensCache.get.mockResolvedValue(null);

      await GraphApiService.exchangeTokenForGraphAccess(
        mockOpenIdConfig,
        'test-token',
        'test-user',
      );

      if (client.genericGrantRequest) {
        expect(client.genericGrantRequest).toHaveBeenCalledWith(
          mockOpenIdConfig,
          'urn:ietf:params:oauth:grant-type:jwt-bearer',
          {
            scope:
              'https://graph.microsoft.com/Custom.Read https://graph.microsoft.com/Custom.Write',
            assertion: 'test-token',
            requested_token_use: 'on_behalf_of',
          },
        );
      }

      process.env.OPENID_GRAPH_SCOPES = originalEnv;
    });
  });

  describe('searchEntraIdPrincipals', () => {
    // Mock data used by multiple tests
    const mockContactsResponse = {
      value: [
        {
          id: 'contact-user-1',
          displayName: 'John Doe',
          userPrincipalName: 'john@company.com',
          mail: 'john@company.com',
          personType: { class: 'Person', subclass: 'OrganizationUser' },
          scoredEmailAddresses: [{ address: 'john@company.com', relevanceScore: 0.9 }],
        },
        {
          id: 'contact-group-1',
          displayName: 'Marketing Team',
          mail: 'marketing@company.com',
          personType: { class: 'Group', subclass: 'UnifiedGroup' },
          scoredEmailAddresses: [{ address: 'marketing@company.com', relevanceScore: 0.8 }],
        },
      ],
    };

    const mockUsersResponse = {
      value: [
        {
          id: 'dir-user-1',
          displayName: 'Jane Smith',
          userPrincipalName: 'jane@company.com',
          mail: 'jane@company.com',
        },
      ],
    };

    const mockGroupsResponse = {
      value: [
        {
          id: 'dir-group-1',
          displayName: 'Development Team',
          mail: 'dev@company.com',
        },
      ],
    };

    beforeEach(() => {
      // Reset mock call history for each test
      jest.clearAllMocks();

      // Re-apply the Client.init mock after clearAllMocks
      Client.init.mockReturnValue(mockGraphClient);

      // Re-apply openid-client mock
      if (client.genericGrantRequest) {
        client.genericGrantRequest.mockResolvedValue({
          access_token: 'mocked-graph-token',
          expires_in: 3600,
        });
      }

      // Re-apply cache mock
      mockTokensCache.get.mockResolvedValue(null); // Force token exchange
      mockTokensCache.set.mockResolvedValue();
      getLogStores.mockReturnValue(mockTokensCache);
      getOpenIdConfig.mockReturnValue(mockOpenIdConfig);
    });

    it('should return empty results for short queries', async () => {
      const result = await GraphApiService.searchEntraIdPrincipals('token', 'user', 'a', 'all', 10);

      expect(result).toEqual([]);
      expect(mockGraphClient.api).not.toHaveBeenCalled();
    });

    it('should search contacts first and additional users for users type', async () => {
      // Mock responses for this specific test
      const contactsFilteredResponse = {
        value: [
          {
            id: 'contact-user-1',
            displayName: 'John Doe',
            userPrincipalName: 'john@company.com',
            mail: 'john@company.com',
            personType: { class: 'Person', subclass: 'OrganizationUser' },
            scoredEmailAddresses: [{ address: 'john@company.com', relevanceScore: 0.9 }],
          },
        ],
      };

      mockGraphClient.get
        .mockResolvedValueOnce(contactsFilteredResponse) // contacts call
        .mockResolvedValueOnce(mockUsersResponse); // users call

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'john',
        'users',
        10,
      );

      // Should call contacts first with user filter
      expect(mockGraphClient.api).toHaveBeenCalledWith('/me/people');
      expect(mockGraphClient.search).toHaveBeenCalledWith('"john"');
      expect(mockGraphClient.filter).toHaveBeenCalledWith(
        "personType/subclass eq 'OrganizationUser'",
      );

      // Should call users endpoint for additional results
      expect(mockGraphClient.api).toHaveBeenCalledWith('/users');
      expect(mockGraphClient.search).toHaveBeenCalledWith(
        '"displayName:john" OR "userPrincipalName:john" OR "mail:john" OR "givenName:john" OR "surname:john"',
      );

      // Should return TPrincipalSearchResult array
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2); // 1 from contacts + 1 from users
      expect(result[0]).toMatchObject({
        id: null,
        type: 'user',
        name: 'John Doe',
        email: 'john@company.com',
        source: 'entra',
        idOnTheSource: 'contact-user-1',
      });
    });

    it('should search groups endpoint only for groups type', async () => {
      // Mock responses for this specific test - only groups endpoint called
      mockGraphClient.get.mockResolvedValueOnce(mockGroupsResponse); // only groups call

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'team',
        'groups',
        10,
      );

      // Should NOT call contacts for groups type
      expect(mockGraphClient.api).not.toHaveBeenCalledWith('/me/people');

      // Should call groups endpoint only
      expect(mockGraphClient.api).toHaveBeenCalledWith('/groups');
      expect(mockGraphClient.search).toHaveBeenCalledWith(
        '"displayName:team" OR "mail:team" OR "mailNickname:team"',
      );

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1); // 1 from groups only
    });

    it('should search all endpoints for all type', async () => {
      // Mock responses for this specific test
      mockGraphClient.get
        .mockResolvedValueOnce(mockContactsResponse) // contacts call (both user and group)
        .mockResolvedValueOnce(mockUsersResponse) // users call
        .mockResolvedValueOnce(mockGroupsResponse); // groups call

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'test',
        'all',
        10,
      );

      // Should call contacts first with user filter
      expect(mockGraphClient.api).toHaveBeenCalledWith('/me/people');
      expect(mockGraphClient.search).toHaveBeenCalledWith('"test"');
      expect(mockGraphClient.filter).toHaveBeenCalledWith(
        "personType/subclass eq 'OrganizationUser'",
      );

      // Should call both users and groups endpoints
      expect(mockGraphClient.api).toHaveBeenCalledWith('/users');
      expect(mockGraphClient.api).toHaveBeenCalledWith('/groups');

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(4); // 2 from contacts + 1 from users + 1 from groups
    });

    it('should early exit if contacts reach limit', async () => {
      // Mock contacts to return exactly the limit
      const limitedContactsResponse = {
        value: Array(10).fill({
          id: 'contact-1',
          displayName: 'Contact User',
          mail: 'contact@company.com',
          personType: { class: 'Person', subclass: 'OrganizationUser' },
        }),
      };

      mockGraphClient.get.mockResolvedValueOnce(limitedContactsResponse);

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'test',
        'all',
        10,
      );

      // Should call contacts first
      expect(mockGraphClient.api).toHaveBeenCalledWith('/me/people');
      expect(mockGraphClient.search).toHaveBeenCalledWith('"test"');
      // Should not call users endpoint since limit was reached
      expect(mockGraphClient.api).not.toHaveBeenCalledWith('/users');

      expect(result).toHaveLength(10);
    });

    it('should deduplicate results based on idOnTheSource', async () => {
      // Mock responses with duplicate IDs
      const duplicateContactsResponse = {
        value: [
          {
            id: 'duplicate-id',
            displayName: 'John Doe',
            mail: 'john@company.com',
            personType: { class: 'Person', subclass: 'OrganizationUser' },
          },
        ],
      };

      const duplicateUsersResponse = {
        value: [
          {
            id: 'duplicate-id', // Same ID as contact
            displayName: 'John Doe',
            mail: 'john@company.com',
          },
        ],
      };

      mockGraphClient.get
        .mockResolvedValueOnce(duplicateContactsResponse)
        .mockResolvedValueOnce(duplicateUsersResponse);

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'john',
        'users',
        10,
      );

      // Should only return one result despite duplicate IDs
      expect(result).toHaveLength(1);
      expect(result[0].idOnTheSource).toBe('duplicate-id');
    });

    it('should handle Graph API errors gracefully', async () => {
      mockGraphClient.get.mockRejectedValue(new Error('Graph API error'));

      const result = await GraphApiService.searchEntraIdPrincipals(
        'token',
        'user',
        'test',
        'all',
        10,
      );

      expect(result).toEqual([]);
    });
  });

  describe('getUserEntraGroups', () => {
    it('should fetch user groups using getMemberGroups endpoint', async () => {
      const mockGroupsResponse = {
        value: ['group-1', 'group-2'],
      };

      mockGraphClient.post.mockResolvedValue(mockGroupsResponse);

      const result = await GraphApiService.getUserEntraGroups('token', 'user');

      expect(mockGraphClient.api).toHaveBeenCalledWith('/me/getMemberGroups');
      expect(mockGraphClient.post).toHaveBeenCalledWith({ securityEnabledOnly: false });

      expect(result).toEqual(['group-1', 'group-2']);
    });

    it('should deduplicate returned group ids', async () => {
      mockGraphClient.post.mockResolvedValue({
        value: ['group-1', 'group-2', 'group-1'],
      });

      const result = await GraphApiService.getUserEntraGroups('token', 'user');

      expect(result).toEqual(['group-1', 'group-2']);
    });

    it('should return empty array on error', async () => {
      mockGraphClient.post.mockRejectedValue(new Error('API error'));

      const result = await GraphApiService.getUserEntraGroups('token', 'user');

      expect(result).toEqual([]);
    });

    it('should handle empty response', async () => {
      const mockGroupsResponse = {
        value: [],
      };

      mockGraphClient.post.mockResolvedValue(mockGroupsResponse);

      const result = await GraphApiService.getUserEntraGroups('token', 'user');

      expect(result).toEqual([]);
    });

    it('should handle missing value property', async () => {
      mockGraphClient.post.mockResolvedValue({});

      const result = await GraphApiService.getUserEntraGroups('token', 'user');

      expect(result).toEqual([]);
    });
  });

  describe('getUserOwnedEntraGroups', () => {
    it('should fetch owned groups with pagination support', async () => {
      const firstPage = {
        value: [
          {
            id: 'owned-group-1',
          },
        ],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/me/ownedObjects/microsoft.graph.group?$skiptoken=xyz',
      };

      const secondPage = {
        value: [
          {
            id: 'owned-group-2',
          },
        ],
      };

      mockGraphClient.get.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);

      const result = await GraphApiService.getUserOwnedEntraGroups('token', 'user');

      expect(mockGraphClient.api).toHaveBeenNthCalledWith(
        1,
        '/me/ownedObjects/microsoft.graph.group',
      );
      expect(mockGraphClient.api).toHaveBeenNthCalledWith(
        2,
        '/me/ownedObjects/microsoft.graph.group?$skiptoken=xyz',
      );
      expect(mockGraphClient.top).toHaveBeenCalledWith(999);
      expect(mockGraphClient.get).toHaveBeenCalledTimes(2);

      expect(result).toEqual(['owned-group-1', 'owned-group-2']);
    });

    it('should return empty array on error', async () => {
      mockGraphClient.get.mockRejectedValue(new Error('API error'));

      const result = await GraphApiService.getUserOwnedEntraGroups('token', 'user');

      expect(result).toEqual([]);
    });
  });

  describe('getGroupMembers', () => {
    it('should fetch transitive members and include only users', async () => {
      const firstPage = {
        value: [
          { id: 'user-1', '@odata.type': '#microsoft.graph.user' },
          { id: 'child-group', '@odata.type': '#microsoft.graph.group' },
        ],
        '@odata.nextLink':
          'https://graph.microsoft.com/v1.0/groups/group-id/transitiveMembers?$skiptoken=abc',
      };
      const secondPage = {
        value: [{ id: 'user-2', '@odata.type': '#microsoft.graph.user' }],
      };

      mockGraphClient.get.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);

      const result = await GraphApiService.getGroupMembers('token', 'user', 'group-id');

      expect(mockGraphClient.api).toHaveBeenNthCalledWith(1, '/groups/group-id/transitiveMembers');
      expect(mockGraphClient.api).toHaveBeenNthCalledWith(
        2,
        '/groups/group-id/transitiveMembers?$skiptoken=abc',
      );
      expect(mockGraphClient.top).toHaveBeenCalledWith(999);
      expect(result).toEqual(['user-1', 'user-2']);
    });

    it('should return empty array on error', async () => {
      mockGraphClient.get.mockRejectedValue(new Error('API error'));

      const result = await GraphApiService.getGroupMembers('token', 'user', 'group-id');

      expect(result).toEqual([]);
    });
  });

  describe('testGraphApiAccess', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should test all permissions and return success results', async () => {
      // Mock successful responses for all tests
      mockGraphClient.get
        .mockResolvedValueOnce({ id: 'user-123', displayName: 'Test User' }) // /me test
        .mockResolvedValueOnce({ value: [] }) // people OrganizationUser test
        .mockResolvedValueOnce({ value: [] }) // people UnifiedGroup test
        .mockResolvedValueOnce({ value: [] }) // /users endpoint test
        .mockResolvedValueOnce({ value: [] }); // /groups endpoint test

      const result = await GraphApiService.testGraphApiAccess('token', 'user');

      expect(result).toEqual({
        userAccess: true,
        peopleAccess: true,
        groupsAccess: true,
        usersEndpointAccess: true,
        groupsEndpointAccess: true,
        errors: [],
      });

      // Verify all endpoints were tested
      expect(mockGraphClient.api).toHaveBeenCalledWith('/me');
      expect(mockGraphClient.api).toHaveBeenCalledWith('/me/people');
      expect(mockGraphClient.api).toHaveBeenCalledWith('/users');
      expect(mockGraphClient.api).toHaveBeenCalledWith('/groups');
      expect(mockGraphClient.filter).toHaveBeenCalledWith(
        "personType/subclass eq 'OrganizationUser'",
      );
      expect(mockGraphClient.filter).toHaveBeenCalledWith("personType/subclass eq 'UnifiedGroup'");
      expect(mockGraphClient.search).toHaveBeenCalledWith('"displayName:test"');
    });

    it('should handle partial failures and record errors', async () => {
      // Mock mixed success/failure responses
      mockGraphClient.get
        .mockResolvedValueOnce({ id: 'user-123', displayName: 'Test User' }) // /me success
        .mockRejectedValueOnce(new Error('People access denied')) // people OrganizationUser fail
        .mockResolvedValueOnce({ value: [] }) // people UnifiedGroup success
        .mockRejectedValueOnce(new Error('Users endpoint access denied')) // /users fail
        .mockResolvedValueOnce({ value: [] }); // /groups success

      const result = await GraphApiService.testGraphApiAccess('token', 'user');

      expect(result).toEqual({
        userAccess: true,
        peopleAccess: false,
        groupsAccess: true,
        usersEndpointAccess: false,
        groupsEndpointAccess: true,
        errors: [
          'People.Read (OrganizationUser): People access denied',
          'Users endpoint: Users endpoint access denied',
        ],
      });
    });

    it('should handle complete Graph client creation failure', async () => {
      // Mock token exchange failure to test error handling
      if (client.genericGrantRequest) {
        client.genericGrantRequest.mockRejectedValue(new Error('Token exchange failed'));
      }

      const result = await GraphApiService.testGraphApiAccess('invalid-token', 'user');

      expect(result).toEqual({
        userAccess: false,
        peopleAccess: false,
        groupsAccess: false,
        usersEndpointAccess: false,
        groupsEndpointAccess: false,
        errors: ['Token exchange failed'],
      });
    });

    it('should record all permission errors', async () => {
      // Mock all requests to fail
      mockGraphClient.get
        .mockRejectedValueOnce(new Error('User.Read denied'))
        .mockRejectedValueOnce(new Error('People.Read OrganizationUser denied'))
        .mockRejectedValueOnce(new Error('People.Read UnifiedGroup denied'))
        .mockRejectedValueOnce(new Error('Users directory access denied'))
        .mockRejectedValueOnce(new Error('Groups directory access denied'));

      const result = await GraphApiService.testGraphApiAccess('token', 'user');

      expect(result).toEqual({
        userAccess: false,
        peopleAccess: false,
        groupsAccess: false,
        usersEndpointAccess: false,
        groupsEndpointAccess: false,
        errors: [
          'User.Read: User.Read denied',
          'People.Read (OrganizationUser): People.Read OrganizationUser denied',
          'People.Read (UnifiedGroup): People.Read UnifiedGroup denied',
          'Users endpoint: Users directory access denied',
          'Groups endpoint: Groups directory access denied',
        ],
      });
    });

    it('should test new endpoints with correct search patterns', async () => {
      // Mock successful responses for endpoint testing
      mockGraphClient.get
        .mockResolvedValueOnce({ id: 'user-123', displayName: 'Test User' }) // /me
        .mockResolvedValueOnce({ value: [] }) // people OrganizationUser
        .mockResolvedValueOnce({ value: [] }) // people UnifiedGroup
        .mockResolvedValueOnce({ value: [] }) // /users
        .mockResolvedValueOnce({ value: [] }); // /groups

      await GraphApiService.testGraphApiAccess('token', 'user');

      // Verify /users endpoint test
      expect(mockGraphClient.api).toHaveBeenCalledWith('/users');
      expect(mockGraphClient.search).toHaveBeenCalledWith('"displayName:test"');
      expect(mockGraphClient.select).toHaveBeenCalledWith('id,displayName,userPrincipalName');

      // Verify /groups endpoint test
      expect(mockGraphClient.api).toHaveBeenCalledWith('/groups');
      expect(mockGraphClient.select).toHaveBeenCalledWith('id,displayName,mail');
    });

    it('should handle endpoint-specific permission failures', async () => {
      // Mock specific endpoint failures
      mockGraphClient.get
        .mockResolvedValueOnce({ id: 'user-123', displayName: 'Test User' }) // /me success
        .mockResolvedValueOnce({ value: [] }) // people OrganizationUser success
        .mockResolvedValueOnce({ value: [] }) // people UnifiedGroup success
        .mockRejectedValueOnce(new Error('Insufficient privileges')) // /users fail (User.Read.All needed)
        .mockRejectedValueOnce(new Error('Access denied to groups')); // /groups fail (Group.Read.All needed)

      const result = await GraphApiService.testGraphApiAccess('token', 'user');

      expect(result).toEqual({
        userAccess: true,
        peopleAccess: true,
        groupsAccess: true,
        usersEndpointAccess: false,
        groupsEndpointAccess: false,
        errors: [
          'Users endpoint: Insufficient privileges',
          'Groups endpoint: Access denied to groups',
        ],
      });
    });
  });
});
