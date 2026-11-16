import { decryptV2 } from '@librechat/data-schemas';
import type { TokenMethods, TokenRecord } from '@librechat/data-schemas';
import { MCPTokenStorage } from '~/mcp/oauth/tokens';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  decryptV2: jest.fn(),
}));

const mockDecryptV2 = decryptV2 as jest.MockedFunction<typeof decryptV2>;

describe('MCPTokenStorage', () => {
  afterAll(() => {
    jest.clearAllMocks();
  });

  describe('deleteUserTokens', () => {
    const userId = '000000001111111122222222';
    const serverName = 'test-server';
    let mockDeleteToken: jest.MockedFunction<
      (filter: { userId: string; type: string; identifier: string }) => Promise<void>
    >;

    beforeEach(() => {
      jest.clearAllMocks();
      mockDeleteToken = jest.fn().mockResolvedValue(undefined);
    });

    it('should delete all OAuth-related tokens for a user and server', async () => {
      await MCPTokenStorage.deleteUserTokens({
        userId,
        serverName,
        deleteToken: mockDeleteToken,
      });

      // Verify all three token types were deleted with correct identifiers
      expect(mockDeleteToken).toHaveBeenCalledTimes(3);
      expect(mockDeleteToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth_client',
        identifier: `mcp:${serverName}:client`,
      });
      expect(mockDeleteToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth',
        identifier: `mcp:${serverName}`,
      });
      expect(mockDeleteToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth_refresh',
        identifier: `mcp:${serverName}:refresh`,
      });
    });

    it('should handle deletion errors gracefully', async () => {
      mockDeleteToken.mockRejectedValueOnce(new Error('Deletion failed'));

      await expect(
        MCPTokenStorage.deleteUserTokens({
          userId,
          serverName,
          deleteToken: mockDeleteToken,
        }),
      ).rejects.toThrow('Deletion failed');

      expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('getClientInfoAndMetadata', () => {
    const userId = '000000001111111122222222';
    const serverName = 'test-server';
    const identifier = `mcp:${serverName}`;
    let mockFindToken: jest.MockedFunction<TokenMethods['findToken']>;

    beforeEach(() => {
      jest.clearAllMocks();
      mockFindToken = jest.fn();
    });

    it('should return null when no client info token exists', async () => {
      mockFindToken.mockResolvedValue(null);

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).toBeNull();
      expect(mockFindToken).toHaveBeenCalledWith({
        userId,
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
      });
    });

    it('should return client info and metadata when token exists', async () => {
      const clientInfo = {
        client_id: 'test-client-id',
        client_secret: 'test-secret',
      };

      const metadata = {
        serverUrl: 'https://test.example.com',
        state: 'test-state',
      };

      const mockToken: TokenRecord = {
        _id: '000000001111111133333333',
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
        token: 'encrypted-token',
        metadata,
      };

      mockFindToken.mockResolvedValue(mockToken);
      mockDecryptV2.mockResolvedValue(JSON.stringify(clientInfo));

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).not.toBeNull();
      expect(result?.clientInfo).toEqual(clientInfo);
      expect(result?.clientMetadata).toEqual({
        serverUrl: 'https://test.example.com',
        state: 'test-state',
      });
      expect(mockDecryptV2).toHaveBeenCalledWith('encrypted-token');
    });

    it('should handle empty metadata', async () => {
      const clientInfo = {
        client_id: 'test-client-id',
      };

      const mockToken: TokenRecord = {
        _id: '000000001111111133333333',
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
        token: 'encrypted-token',
      };

      mockFindToken.mockResolvedValue(mockToken);
      mockDecryptV2.mockResolvedValue(JSON.stringify(clientInfo));

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).not.toBeNull();
      expect(result?.clientInfo).toEqual(clientInfo);
      expect(result?.clientMetadata).toEqual({});
    });

    it('should handle metadata as plain object', async () => {
      const clientInfo = {
        client_id: 'test-client-id',
      };

      const metadata = {
        serverUrl: 'https://test.example.com',
        state: 'test-state',
      };

      const mockToken: TokenRecord = {
        _id: '000000001111111133333333',
        userId,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 3600000),
        type: 'mcp_oauth_client',
        identifier: `${identifier}:client`,
        token: 'encrypted-token',
        metadata,
      };

      mockFindToken.mockResolvedValue(mockToken);
      mockDecryptV2.mockResolvedValue(JSON.stringify(clientInfo));

      const result = await MCPTokenStorage.getClientInfoAndMetadata({
        userId,
        serverName,
        findToken: mockFindToken,
      });

      expect(result).not.toBeNull();
      expect(result?.clientInfo).toEqual(clientInfo);
      expect(result?.clientMetadata).toEqual(metadata);
    });
  });
});
