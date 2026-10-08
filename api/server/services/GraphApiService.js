const client = require('openid-client');
const {
  isEnabled,
  getTokenCacheTtlMs,
  DEFAULT_OAUTH_TOKEN_TTL_SECONDS,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { Client } = require('@microsoft/microsoft-graph-client');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const getLogStores = require('~/cache/getLogStores');

/**
 * @import { TPrincipalSearchResult, TGraphPerson, TGraphUser, TGraphGroup, TGraphPeopleResponse, TGraphUsersResponse, TGraphGroupsResponse } from 'librechat-data-provider'
 */

/**
 * Checks if Entra ID principal search feature is enabled based on environment variables and user authentication
 * @param {Object} user - User object from request
 * @param {string} user.provider - Authentication provider
 * @param {string} user.openidId - OpenID subject identifier
 * @returns {boolean} True if Entra ID principal search is enabled and user is authenticated via OpenID
 */
const entraIdPrincipalFeatureEnabled = (user) => {
  return (
    isEnabled(process.env.USE_ENTRA_ID_FOR_PEOPLE_SEARCH) &&
    isEnabled(process.env.OPENID_REUSE_TOKENS) &&
    user?.provider === 'openid' &&
    user?.openidId
  );
};

/**
 * Creates a Microsoft Graph client with on-behalf-of token exchange
 * @param {string} accessToken - OpenID Connect access token from user
 * @param {string} sub - Subject identifier from token claims
 * @returns {Promise<Client>} Authenticated Graph API client
 */
const createGraphClient = async (accessToken, sub) => {
  try {
    // Reason: Use existing OpenID configuration and token exchange pattern from openidStrategy.js
    const openidConfig = getOpenIdConfig();
    const exchangedToken = await exchangeTokenForGraphAccess(openidConfig, accessToken, sub);

    const graphClient = Client.init({
      authProvider: (done) => {
        done(null, exchangedToken);
      },
    });

    return graphClient;
  } catch (error) {
    logger.error('[createGraphClient] Error creating Graph client:', error);
    throw error;
  }
};

/**
 * Exchange OpenID token for Graph API access using on-behalf-of flow
 * Similar to exchangeAccessTokenIfNeeded in openidStrategy.js but for Graph scopes
 * @param {Configuration} config - OpenID configuration
 * @param {string} accessToken - Original access token
 * @param {string} sub - Subject identifier
 * @returns {Promise<string>} Graph API access token
 */
const exchangeTokenForGraphAccess = async (config, accessToken, sub) => {
  try {
    const tokensCache = getLogStores(CacheKeys.OPENID_EXCHANGED_TOKENS);
    const cacheKey = `${sub}:graph`;

    const cachedToken = await tokensCache.get(cacheKey);
    if (cachedToken) {
      return cachedToken.access_token;
    }

    const graphScopes = process.env.OPENID_GRAPH_SCOPES || 'User.Read,People.Read,Group.Read.All';
    const scopeString = graphScopes
      .split(',')
      .map((scope) => `https://graph.microsoft.com/${scope}`)
      .join(' ');

    const grantResponse = await client.genericGrantRequest(
      config,
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      {
        scope: scopeString,
        assertion: accessToken,
        requested_token_use: 'on_behalf_of',
      },
    );

    await tokensCache.set(
      cacheKey,
      {
        access_token: grantResponse.access_token,
      },
      getTokenCacheTtlMs(grantResponse.expires_in, DEFAULT_OAUTH_TOKEN_TTL_SECONDS),
    );

    return grantResponse.access_token;
  } catch (error) {
    logger.error('[exchangeTokenForGraphAccess] Token exchange failed:', error);
    throw error;
  }
};

/**
 * Search for principals (people and groups) using Microsoft Graph API
 * Uses searchContacts first, then searchUsers and searchGroups to fill remaining slots
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string} query - Search query string
 * @param {string} type - Type filter ('users', 'groups', or 'all')
 * @param {number} limit - Maximum number of results
 * @returns {Promise<TPrincipalSearchResult[]>} Array of principal search results
 */
const searchEntraIdPrincipals = async (accessToken, sub, query, type = 'all', limit = 10) => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }
    const graphClient = await createGraphClient(accessToken, sub);
    let allResults = [];

    if (type === 'users' || type === 'all') {
      const contactResults = await searchContacts(graphClient, query, limit);
      allResults.push(...contactResults);
    }
    if (allResults.length >= limit) {
      return allResults.slice(0, limit);
    }

    if (type === 'users') {
      const userResults = await searchUsers(graphClient, query, limit);
      allResults.push(...userResults);
    } else if (type === 'groups') {
      const groupResults = await searchGroups(graphClient, query, limit);
      allResults.push(...groupResults);
    } else if (type === 'all') {
      const [userResults, groupResults] = await Promise.all([
        searchUsers(graphClient, query, limit),
        searchGroups(graphClient, query, limit),
      ]);

      allResults.push(...userResults, ...groupResults);
    }

    const seenIds = new Set();
    const uniqueResults = allResults.filter((result) => {
      if (seenIds.has(result.idOnTheSource)) {
        return false;
      }
      seenIds.add(result.idOnTheSource);
      return true;
    });

    return uniqueResults.slice(0, limit);
  } catch (error) {
    logger.error('[searchEntraIdPrincipals] Error searching principals:', error);
    return [];
  }
};

/**
 * Get current user's Entra ID group memberships from Microsoft Graph
 * Uses /me/getMemberGroups endpoint to get transitive groups the user is a member of
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @returns {Promise<Array<string>>} Array of group ID strings (GUIDs)
 */
const getUserEntraGroups = async (accessToken, sub) => {
  try {
    const graphClient = await createGraphClient(accessToken, sub);
    const response = await graphClient
      .api('/me/getMemberGroups')
      .post({ securityEnabledOnly: false });

    const groupIds = Array.isArray(response?.value) ? response.value : [];
    return [...new Set(groupIds.map((groupId) => String(groupId)))];
  } catch (error) {
    logger.error('[getUserEntraGroups] Error fetching user groups:', error);
    return [];
  }
};

/**
 * Get current user's owned Entra ID groups from Microsoft Graph
 * Uses /me/ownedObjects/microsoft.graph.group endpoint to get groups the user owns
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @returns {Promise<Array<string>>} Array of group ID strings (GUIDs)
 */
const getUserOwnedEntraGroups = async (accessToken, sub) => {
  try {
    const graphClient = await createGraphClient(accessToken, sub);
    const allGroupIds = [];
    let nextLink = '/me/ownedObjects/microsoft.graph.group';

    while (nextLink) {
      const response = await graphClient.api(nextLink).select('id').top(999).get();
      const groups = response?.value || [];
      allGroupIds.push(...groups.map((group) => group.id));

      nextLink = response['@odata.nextLink']
        ? response['@odata.nextLink']
            .replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')
            .trim() || null
        : null;
    }

    return allGroupIds;
  } catch (error) {
    logger.error('[getUserOwnedEntraGroups] Error fetching user owned groups:', error);
    return [];
  }
};

/**
 * Get group members from Microsoft Graph API
 * Recursively fetches all members using pagination (@odata.nextLink)
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string} groupId - Entra ID group object ID
 * @returns {Promise<Array>} Array of member IDs (idOnTheSource values)
 */
const getGroupMembers = async (accessToken, sub, groupId) => {
  try {
    const graphClient = await createGraphClient(accessToken, sub);
    const allMembers = new Set();
    let nextLink = `/groups/${groupId}/transitiveMembers`;

    while (nextLink) {
      const membersResponse = await graphClient.api(nextLink).select('id').top(999).get();

      const members = membersResponse?.value || [];
      members.forEach((member) => {
        if (typeof member?.id === 'string' && member['@odata.type'] === '#microsoft.graph.user') {
          allMembers.add(member.id);
        }
      });

      nextLink = membersResponse['@odata.nextLink']
        ? membersResponse['@odata.nextLink']
            .replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, '')
            .trim() || null
        : null;
    }

    return Array.from(allMembers);
  } catch (error) {
    logger.error('[getGroupMembers] Error fetching group members:', error);
    return [];
  }
};
/**
 * Get group owners from Microsoft Graph API
 * Recursively fetches all owners using pagination (@odata.nextLink)
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string} groupId - Entra ID group object ID
 * @returns {Promise<Array>} Array of owner IDs (idOnTheSource values)
 */
const getGroupOwners = async (accessToken, sub, groupId) => {
  try {
    const graphClient = await createGraphClient(accessToken, sub);
    const allOwners = [];
    let nextLink = `/groups/${groupId}/owners`;

    while (nextLink) {
      const ownersResponse = await graphClient.api(nextLink).select('id').top(999).get();

      const owners = ownersResponse.value || [];
      allOwners.push(...owners.map((member) => member.id));

      nextLink = ownersResponse['@odata.nextLink']
        ? ownersResponse['@odata.nextLink'].split('/v1.0')[1]
        : null;
    }

    return allOwners;
  } catch (error) {
    logger.error('[getGroupOwners] Error fetching group owners:', error);
    return [];
  }
};

/**
 * Get detailed information for specific Entra ID groups using batch requests
 * Efficiently fetches group details for multiple groups in batches of 20 (Microsoft Graph limit)
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @param {string[]} groupIds - Array of group IDs (GUIDs) to fetch details for
 * @returns {Promise<Array<{id: string, name: string, description?: string, email?: string}>>} Array of group details
 */
const getEntraGroupDetailsBatch = async (accessToken, sub, groupIds) => {
  try {
    if (!groupIds || groupIds.length === 0) {
      return [];
    }

    // Safety check: warn if user has an unusually large number of groups
    const MAX_REASONABLE_GROUPS = 200;
    if (groupIds.length > MAX_REASONABLE_GROUPS) {
      logger.warn(
        `[getEntraGroupDetailsBatch] User has ${groupIds.length} groups (>${MAX_REASONABLE_GROUPS}). This may impact performance.`,
      );
    }

    const graphClient = await createGraphClient(accessToken, sub);
    const batchSize = 20; // Microsoft Graph batch API limit
    const maxConcurrent = 5; // Limit concurrent batch requests

    // Helper function to process a single batch with retry logic for throttling
    const processBatch = async (batchIds, retryCount = 0) => {
      const batchRequest = {
        requests: batchIds.map((id) => ({
          id,
          method: 'GET',
          url: `/groups/${id}?$select=id,displayName,mail,description`,
        })),
      };

      try {
        const batchResponse = await graphClient.api('/$batch').post(batchRequest);
        const results = [];
        const throttledIds = [];

        // Process batch responses
        if (batchResponse.responses) {
          for (const response of batchResponse.responses) {
            if (response.status === 200 && response.body) {
              results.push({
                id: response.body.id,
                name: response.body.displayName,
                email:
                  typeof response.body.mail === 'string'
                    ? response.body.mail.toLowerCase()
                    : response.body.mail,
                description: response.body.description,
              });
            } else if (response.status === 429 || response.status === 503) {
              // Track throttled/unavailable groups for retry
              throttledIds.push(response.id);
              logger.warn(
                `[getEntraGroupDetailsBatch] Group ${response.id} throttled/unavailable (${response.status}), will retry`,
              );
            } else {
              logger.warn(
                `[getEntraGroupDetailsBatch] Failed to fetch group ${response.id}. Status: ${response.status}`,
              );
            }
          }
        }

        // Retry throttled requests after a brief delay (max 2 retries)
        if (throttledIds.length > 0 && retryCount < 2) {
          const retryAfter = 1000 * (retryCount + 1); // Exponential backoff: 1s, 2s
          logger.info(
            `[getEntraGroupDetailsBatch] Retrying ${throttledIds.length} throttled groups after ${retryAfter}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, retryAfter));
          const retryResults = await processBatch(throttledIds, retryCount + 1);
          results.push(...retryResults);
        }

        return results;
      } catch (batchError) {
        logger.error(`[getEntraGroupDetailsBatch] Error processing batch:`, batchError);
        return [];
      }
    };

    // Split groups into batches and process with limited concurrency
    const batches = [];
    for (let i = 0; i < groupIds.length; i += batchSize) {
      batches.push(groupIds.slice(i, i + batchSize));
    }

    // Process batches with controlled concurrency
    const allGroupDetails = [];
    for (let i = 0; i < batches.length; i += maxConcurrent) {
      const batchSlice = batches.slice(i, i + maxConcurrent);
      const batchPromises = batchSlice.map((batch) => processBatch(batch));
      const batchResults = await Promise.all(batchPromises);
      allGroupDetails.push(...batchResults.flat());
    }

    return allGroupDetails;
  } catch (error) {
    logger.error('[getEntraGroupDetailsBatch] Error fetching group details:', error);
    return [];
  }
};

/**
 * Search for contacts (users only) using Microsoft Graph /me/people endpoint
 * Returns mapped TPrincipalSearchResult objects for users only
 * @param {Client} graphClient - Authenticated Microsoft Graph client
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 10)
 * @returns {Promise<TPrincipalSearchResult[]>} Array of mapped user contact results
 */
const searchContacts = async (graphClient, query, limit = 10) => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }
    if (
      process.env.OPENID_GRAPH_SCOPES &&
      !process.env.OPENID_GRAPH_SCOPES.toLowerCase().includes('people.read')
    ) {
      logger.warn('[searchContacts] People.Read scope is not enabled, skipping contact search');
      return [];
    }
    // Reason: Search only for OrganizationUser (person) type, not groups
    const filter = "personType/subclass eq 'OrganizationUser'";

    let apiCall = graphClient
      .api('/me/people')
      .search(`"${query}"`)
      .select(
        'id,displayName,givenName,surname,userPrincipalName,jobTitle,department,companyName,scoredEmailAddresses,personType,phones',
      )
      .header('ConsistencyLevel', 'eventual')
      .filter(filter)
      .top(limit);

    const contactsResponse = await apiCall.get();
    return (contactsResponse.value || []).map(mapContactToTPrincipalSearchResult);
  } catch (error) {
    logger.error('[searchContacts] Error searching contacts:', error);
    return [];
  }
};

/**
 * Search for users using Microsoft Graph /users endpoint
 * Returns mapped TPrincipalSearchResult objects
 * @param {Client} graphClient - Authenticated Microsoft Graph client
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 10)
 * @returns {Promise<TPrincipalSearchResult[]>} Array of mapped user results
 */
const searchUsers = async (graphClient, query, limit = 10) => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }

    // Reason: Search users by display name, email, and user principal name
    const usersResponse = await graphClient
      .api('/users')
      .search(
        `"displayName:${query}" OR "userPrincipalName:${query}" OR "mail:${query}" OR "givenName:${query}" OR "surname:${query}"`,
      )
      .select(
        'id,displayName,givenName,surname,userPrincipalName,jobTitle,department,companyName,mail,phones',
      )
      .header('ConsistencyLevel', 'eventual')
      .top(limit)
      .get();

    return (usersResponse.value || []).map(mapUserToTPrincipalSearchResult);
  } catch (error) {
    logger.error('[searchUsers] Error searching users:', error);
    return [];
  }
};

/**
 * Search for groups using Microsoft Graph /groups endpoint
 * Returns mapped TPrincipalSearchResult objects, includes all group types
 * @param {Client} graphClient - Authenticated Microsoft Graph client
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 10)
 * @returns {Promise<TPrincipalSearchResult[]>} Array of mapped group results
 */
const searchGroups = async (graphClient, query, limit = 10) => {
  try {
    if (!query || query.trim().length < 2) {
      return [];
    }

    // Reason: Search all groups by display name and email without filtering group types
    const groupsResponse = await graphClient
      .api('/groups')
      .search(`"displayName:${query}" OR "mail:${query}" OR "mailNickname:${query}"`)
      .select('id,displayName,mail,mailNickname,description,groupTypes,resourceProvisioningOptions')
      .header('ConsistencyLevel', 'eventual')
      .top(limit)
      .get();

    return (groupsResponse.value || []).map(mapGroupToTPrincipalSearchResult);
  } catch (error) {
    logger.error('[searchGroups] Error searching groups:', error);
    return [];
  }
};

/**
 * Test Graph API connectivity and permissions
 * @param {string} accessToken - OpenID Connect access token
 * @param {string} sub - Subject identifier
 * @returns {Promise<Object>} Test results with available permissions
 */
const testGraphApiAccess = async (accessToken, sub) => {
  try {
    const graphClient = await createGraphClient(accessToken, sub);
    const results = {
      userAccess: false,
      peopleAccess: false,
      groupsAccess: false,
      usersEndpointAccess: false,
      groupsEndpointAccess: false,
      errors: [],
    };

    // Test User.Read permission
    try {
      await graphClient.api('/me').select('id,displayName').get();
      results.userAccess = true;
    } catch (error) {
      results.errors.push(`User.Read: ${error.message}`);
    }

    // Test People.Read permission with OrganizationUser filter
    try {
      await graphClient
        .api('/me/people')
        .filter("personType/subclass eq 'OrganizationUser'")
        .top(1)
        .get();
      results.peopleAccess = true;
    } catch (error) {
      results.errors.push(`People.Read (OrganizationUser): ${error.message}`);
    }

    // Test People.Read permission with UnifiedGroup filter
    try {
      await graphClient
        .api('/me/people')
        .filter("personType/subclass eq 'UnifiedGroup'")
        .top(1)
        .get();
      results.groupsAccess = true;
    } catch (error) {
      results.errors.push(`People.Read (UnifiedGroup): ${error.message}`);
    }

    // Test /users endpoint access (requires User.Read.All or similar)
    try {
      await graphClient
        .api('/users')
        .search('"displayName:test"')
        .select('id,displayName,userPrincipalName')
        .top(1)
        .get();
      results.usersEndpointAccess = true;
    } catch (error) {
      results.errors.push(`Users endpoint: ${error.message}`);
    }

    // Test /groups endpoint access (requires Group.Read.All or similar)
    try {
      await graphClient
        .api('/groups')
        .search('"displayName:test"')
        .select('id,displayName,mail')
        .top(1)
        .get();
      results.groupsEndpointAccess = true;
    } catch (error) {
      results.errors.push(`Groups endpoint: ${error.message}`);
    }

    return results;
  } catch (error) {
    logger.error('[testGraphApiAccess] Error testing Graph API access:', error);
    return {
      userAccess: false,
      peopleAccess: false,
      groupsAccess: false,
      usersEndpointAccess: false,
      groupsEndpointAccess: false,
      errors: [error.message],
    };
  }
};

/**
 * Map Graph API user object to TPrincipalSearchResult format
 * @param {TGraphUser} user - Raw user object from Graph API
 * @returns {TPrincipalSearchResult} Mapped user result
 */
const mapUserToTPrincipalSearchResult = (user) => {
  return {
    id: null,
    type: 'user',
    name: user.displayName,
    email: user.mail || user.userPrincipalName,
    username: user.userPrincipalName,
    source: 'entra',
    idOnTheSource: user.id,
  };
};

/**
 * Map Graph API group object to TPrincipalSearchResult format
 * @param {TGraphGroup} group - Raw group object from Graph API
 * @returns {TPrincipalSearchResult} Mapped group result
 */
const mapGroupToTPrincipalSearchResult = (group) => {
  return {
    id: null,
    type: 'group',
    name: group.displayName,
    email: group.mail || group.userPrincipalName,
    description: group.description,
    source: 'entra',
    idOnTheSource: group.id,
  };
};

/**
 * Map Graph API /me/people contact object to TPrincipalSearchResult format
 * Handles both user and group contacts from the people endpoint
 * @param {TGraphPerson} contact - Raw contact object from Graph API /me/people
 * @returns {TPrincipalSearchResult} Mapped contact result
 */
const mapContactToTPrincipalSearchResult = (contact) => {
  const isGroup = contact.personType?.class === 'Group';
  const primaryEmail = contact.scoredEmailAddresses?.[0]?.address;

  return {
    id: null,
    type: isGroup ? 'group' : 'user',
    name: contact.displayName,
    email: primaryEmail,
    username: !isGroup ? contact.userPrincipalName : undefined,
    source: 'entra',
    idOnTheSource: contact.id,
  };
};

module.exports = {
  getGroupMembers,
  getGroupOwners,
  createGraphClient,
  getUserEntraGroups,
  getUserOwnedEntraGroups,
  getEntraGroupDetailsBatch,
  testGraphApiAccess,
  searchEntraIdPrincipals,
  exchangeTokenForGraphAccess,
  entraIdPrincipalFeatureEnabled,
};
