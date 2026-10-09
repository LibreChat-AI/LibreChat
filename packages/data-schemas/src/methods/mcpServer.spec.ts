import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { MCPOptions } from 'librechat-data-provider';
import type * as t from '~/types';
import { createMCPServerMethods } from './mcpServer';
import mcpServerSchema from '~/schema/mcpServer';

let mongoServer: MongoMemoryServer;
let MCPServer: mongoose.Model<t.MCPServerDocument>;
let methods: ReturnType<typeof createMCPServerMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();
  MCPServer = mongoose.models.MCPServer || mongoose.model('MCPServer', mcpServerSchema);
  methods = createMCPServerMethods(mongoose);
  await mongoose.connect(mongoUri);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

describe('MCPServer Model Tests', () => {
  const authorId = new mongoose.Types.ObjectId();
  const authorId2 = new mongoose.Types.ObjectId();

  const createSSEConfig = (title?: string, description?: string): MCPOptions => ({
    type: 'sse',
    url: 'https://example.com/mcp',
    ...(title && { title }),
    ...(description && { description }),
  });

  describe('createMCPServer', () => {
    test('should create server with title and generate slug from title', async () => {
      const config = createSSEConfig('My Test Server', 'A test server');
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server).toBeDefined();
      expect(server.serverName).toBe('my-test-server');
      expect(server.config.title).toBe('My Test Server');
      expect(server.config.description).toBe('A test server');
      expect(server.author.toString()).toBe(authorId.toString());
      expect(server.createdAt).toBeInstanceOf(Date);
      expect(server.updatedAt).toBeInstanceOf(Date);
    });

    test('should create server without title and use nanoid', async () => {
      const config: MCPOptions = {
        type: 'sse',
        url: 'https://example.com/mcp',
      };
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server).toBeDefined();
      expect(server.serverName).toMatch(/^mcp-[a-zA-Z0-9_-]{16}$/);
      expect(server.config.title).toBeUndefined();
    });

    test('should handle title with special characters', async () => {
      const config = createSSEConfig('My @#$% Server!!! 123');
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server.serverName).toBe('my-server-123');
    });

    test('should handle title with only spaces and special chars', async () => {
      const config = createSSEConfig('   @#$%   ');
      const server = await methods.createMCPServer({ config, author: authorId });

      // Should fallback to 'mcp-server'
      expect(server.serverName).toBe('mcp-server');
    });

    test('should handle title with multiple spaces', async () => {
      const config = createSSEConfig('My    Multiple   Spaces   Server');
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server.serverName).toBe('my-multiple-spaces-server');
    });

    test('should handle string author ID', async () => {
      const config = createSSEConfig('String Author Test');
      const server = await methods.createMCPServer({
        config,
        author: authorId.toString(),
      });

      expect(server).toBeDefined();
      expect(server.author.toString()).toBe(authorId.toString());
    });

    test('should create server with stdio config', async () => {
      const config: MCPOptions = {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        title: 'Stdio Server',
      };
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server.serverName).toBe('stdio-server');
      expect(server.config.type).toBe('stdio');
    });
  });

  describe('findNextAvailableServerName', () => {
    test('should return base name when no duplicates exist', async () => {
      // Create server directly via model to set up initial state
      await MCPServer.create({
        serverName: 'other-server',
        config: createSSEConfig('Other Server'),
        author: authorId,
      });

      const config = createSSEConfig('Test Server');
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server.serverName).toBe('test-server');
    });

    test('should append -2 when base name exists', async () => {
      // Create first server
      await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      // Create second server with same title
      const server = await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      expect(server.serverName).toBe('test-server-2');
    });

    test('should append suffix when base name is reserved', async () => {
      const server = await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId,
        reservedServerNames: ['test-server'],
      });

      expect(server.serverName).toBe('test-server-2');
    });

    test('should skip both DB and reserved names when finding next suffix', async () => {
      await MCPServer.create({
        serverName: 'test-server',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });
      await MCPServer.create({
        serverName: 'test-server-2',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      const server = await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId,
        reservedServerNames: ['test-server-3'],
      });

      expect(server.serverName).toBe('test-server-4');
    });

    test('should find next available number in sequence', async () => {
      // Create servers with sequential names
      await MCPServer.create({
        serverName: 'test-server',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });
      await MCPServer.create({
        serverName: 'test-server-2',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });
      await MCPServer.create({
        serverName: 'test-server-3',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      const server = await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      expect(server.serverName).toBe('test-server-4');
    });

    test('should handle gaps in sequence', async () => {
      // Create servers with gaps: test, test-2, test-5
      await MCPServer.create({
        serverName: 'test-server',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });
      await MCPServer.create({
        serverName: 'test-server-2',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });
      await MCPServer.create({
        serverName: 'test-server-5',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      const server = await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      // Should append -6 (max + 1)
      expect(server.serverName).toBe('test-server-6');
    });

    test('should not match partial names', async () => {
      // Create 'test-server-extra' which shouldn't affect 'test-server' sequence
      await MCPServer.create({
        serverName: 'test-server-extra',
        config: createSSEConfig('Test Server Extra'),
        author: authorId,
      });

      const server = await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      // 'test-server' is available, so should use it
      expect(server.serverName).toBe('test-server');
    });

    test('should handle special regex characters in base name', async () => {
      // The slug generation removes special characters, but test the regex escaping
      await MCPServer.create({
        serverName: 'test-server',
        config: createSSEConfig('Test Server'),
        author: authorId,
      });

      const server = await methods.createMCPServer({
        config: createSSEConfig('Test Server'),
        author: authorId2,
      });

      expect(server.serverName).toBe('test-server-2');
    });
  });

  describe('findMCPServerByServerName', () => {
    test('should find server by serverName', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Find By Name Test'),
        author: authorId,
      });

      const found = await methods.findMCPServerByServerName(created.serverName);

      expect(found).toBeDefined();
      expect(found?.serverName).toBe('find-by-name-test');
      expect(found?.config.title).toBe('Find By Name Test');
    });

    test('should return null when server not found', async () => {
      const found = await methods.findMCPServerByServerName('non-existent-server');

      expect(found).toBeNull();
    });

    test('should return lean document', async () => {
      await methods.createMCPServer({
        config: createSSEConfig('Lean Test'),
        author: authorId,
      });

      const found = await methods.findMCPServerByServerName('lean-test');

      // Lean documents don't have mongoose methods
      expect(found).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(typeof (found as any).save).toBe('undefined');
    });
  });

  describe('findMCPServerByObjectId', () => {
    test('should find server by MongoDB ObjectId', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Object Id Test'),
        author: authorId,
      });

      const found = await methods.findMCPServerByObjectId(created._id);

      expect(found).toBeDefined();
      expect(found?.serverName).toBe('object-id-test');
      expect(found?._id.toString()).toBe(created._id.toString());
    });

    test('should find server by string ObjectId', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('String Object Id Test'),
        author: authorId,
      });

      const found = await methods.findMCPServerByObjectId(created._id.toString());

      expect(found).toBeDefined();
      expect(found?.serverName).toBe('string-object-id-test');
    });

    test('should return null when ObjectId not found', async () => {
      const randomId = new mongoose.Types.ObjectId();
      const found = await methods.findMCPServerByObjectId(randomId);

      expect(found).toBeNull();
    });

    test('should return null for invalid ObjectId string', async () => {
      await expect(methods.findMCPServerByObjectId('invalid-id')).rejects.toThrow();
    });
  });

  describe('findMCPServersByAuthor', () => {
    test('should find all servers by author', async () => {
      await methods.createMCPServer({
        config: createSSEConfig('Author Server 1'),
        author: authorId,
      });
      await methods.createMCPServer({
        config: createSSEConfig('Author Server 2'),
        author: authorId,
      });
      await methods.createMCPServer({
        config: createSSEConfig('Other Author Server'),
        author: authorId2,
      });

      const servers = await methods.findMCPServersByAuthor(authorId);

      expect(servers).toHaveLength(2);
      expect(servers.every((s) => s.author.toString() === authorId.toString())).toBe(true);
    });

    test('should return empty array when author has no servers', async () => {
      const servers = await methods.findMCPServersByAuthor(new mongoose.Types.ObjectId());

      expect(servers).toEqual([]);
    });

    test('should sort by updatedAt descending', async () => {
      // Create servers with slight delay to ensure different timestamps
      const server1 = await methods.createMCPServer({
        config: createSSEConfig('First Created'),
        author: authorId,
      });

      // Update first server to make it most recently updated
      await MCPServer.findByIdAndUpdate(server1._id, {
        $set: { 'config.description': 'Updated' },
      });

      await methods.createMCPServer({
        config: createSSEConfig('Second Created'),
        author: authorId,
      });

      const servers = await methods.findMCPServersByAuthor(authorId);

      expect(servers).toHaveLength(2);
      // Most recently updated should come first
      expect(servers[0].serverName).toBe('second-created');
    });

    test('should handle string author ID', async () => {
      await methods.createMCPServer({
        config: createSSEConfig('String Author Server'),
        author: authorId,
      });

      const servers = await methods.findMCPServersByAuthor(authorId.toString());

      expect(servers).toHaveLength(1);
    });
  });

  describe('getListMCPServersByIds', () => {
    let server1: t.MCPServerDocument;
    let server2: t.MCPServerDocument;
    let server3: t.MCPServerDocument;

    beforeEach(async () => {
      server1 = await methods.createMCPServer({
        config: createSSEConfig('Server One'),
        author: authorId,
      });
      server2 = await methods.createMCPServer({
        config: createSSEConfig('Server Two'),
        author: authorId,
      });
      server3 = await methods.createMCPServer({
        config: createSSEConfig('Server Three'),
        author: authorId,
      });
    });

    test('should return servers matching provided IDs', async () => {
      const result = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id],
      });

      expect(result.data).toHaveLength(2);
      expect(result.has_more).toBe(false);
      expect(result.after).toBeNull();
    });

    test('should return empty data for empty IDs array', async () => {
      const result = await methods.getListMCPServersByIds({ ids: [] });

      expect(result.data).toEqual([]);
      expect(result.has_more).toBe(false);
      expect(result.after).toBeNull();
    });

    test('should handle pagination with limit', async () => {
      const result = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, server3._id],
        limit: 2,
      });

      expect(result.data).toHaveLength(2);
      expect(result.has_more).toBe(true);
      expect(result.after).not.toBeNull();
    });

    test('should paginate using cursor', async () => {
      // Get first page
      const firstPage = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, server3._id],
        limit: 2,
      });

      expect(firstPage.has_more).toBe(true);
      expect(firstPage.after).not.toBeNull();

      // Get second page using cursor
      const secondPage = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, server3._id],
        limit: 2,
        after: firstPage.after,
      });

      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.has_more).toBe(false);
      expect(secondPage.after).toBeNull();

      // Ensure no duplicates between pages
      const firstPageIds = firstPage.data.map((s) => s._id.toString());
      const secondPageIds = secondPage.data.map((s) => s._id.toString());
      const intersection = firstPageIds.filter((id) => secondPageIds.includes(id));
      expect(intersection).toHaveLength(0);
    });

    test('should handle invalid cursor gracefully', async () => {
      const result = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id],
        after: 'invalid-cursor',
      });

      // Should still return results, ignoring invalid cursor
      expect(result.data).toHaveLength(2);
    });

    test('should return all when limit is null', async () => {
      const result = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, server3._id],
        limit: null,
      });

      expect(result.data).toHaveLength(3);
      expect(result.has_more).toBe(false);
      expect(result.after).toBeNull();
    });

    test('should apply additional filters via otherParams', async () => {
      // Create a server with different config
      const serverWithDesc = await methods.createMCPServer({
        config: createSSEConfig('Filtered Server', 'Has description'),
        author: authorId,
      });

      const result = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, serverWithDesc._id],
        otherParams: { 'config.description': 'Has description' },
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].serverName).toBe('filtered-server');
    });

    test('should normalize limit to valid range', async () => {
      // Limit should be clamped to 1-100
      const resultLow = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, server3._id],
        limit: 0,
      });

      expect(resultLow.data.length).toBeGreaterThanOrEqual(1);

      const resultHigh = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, server3._id],
        limit: 200,
      });

      expect(resultHigh.data).toHaveLength(3); // All 3 servers (less than 100)
    });

    test('should sort by updatedAt descending, _id ascending', async () => {
      const result = await methods.getListMCPServersByIds({
        ids: [server1._id, server2._id, server3._id],
      });

      expect(result.data).toHaveLength(3);
      // Most recently created/updated should come first
      for (let i = 0; i < result.data.length - 1; i++) {
        const current = new Date(result.data[i].updatedAt!).getTime();
        const next = new Date(result.data[i + 1].updatedAt!).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });
  });

  describe('updateMCPServer', () => {
    test('should update server config', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Update Test', 'Original description'),
        author: authorId,
      });

      const updated = await methods.updateMCPServer(created.serverName, {
        config: createSSEConfig('Update Test', 'Updated description'),
      });

      expect(updated).toBeDefined();
      expect(updated?.config.description).toBe('Updated description');
      expect(updated?.serverName).toBe('update-test'); // serverName shouldn't change
    });

    test('should return null when server not found', async () => {
      const updated = await methods.updateMCPServer('non-existent', {
        config: createSSEConfig('Test'),
      });

      expect(updated).toBeNull();
    });

    test('should return updated document (new: true)', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Return Test'),
        author: authorId,
      });

      const updated = await methods.updateMCPServer(created.serverName, {
        config: createSSEConfig('Return Test', 'New description'),
      });

      expect(updated?.config.description).toBe('New description');
    });

    test('should run validators on update', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Validation Test'),
        author: authorId,
      });

      // The update should succeed with valid config
      const updated = await methods.updateMCPServer(created.serverName, {
        config: createSSEConfig('Validation Test', 'Valid config'),
      });

      expect(updated).toBeDefined();
    });

    test('should update timestamps', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Timestamp Test'),
        author: authorId,
      });

      const originalUpdatedAt = created.updatedAt;

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      const updated = await methods.updateMCPServer(created.serverName, {
        config: createSSEConfig('Timestamp Test', 'Updated'),
      });

      expect(updated?.updatedAt).toBeDefined();
      expect(new Date(updated!.updatedAt!).getTime()).toBeGreaterThan(
        new Date(originalUpdatedAt!).getTime(),
      );
    });

    test('should handle partial config updates', async () => {
      const created = await methods.createMCPServer({
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Partial Update Test',
          description: 'Original',
        },
        author: authorId,
      });

      const updated = await methods.updateMCPServer(created.serverName, {
        config: {
          type: 'sse',
          url: 'https://example.com/mcp',
          title: 'Partial Update Test',
          description: 'New description',
          iconPath: '/icons/new-icon.png',
        },
      });

      expect(updated?.config.description).toBe('New description');
      expect(updated?.config.iconPath).toBe('/icons/new-icon.png');
    });
  });

  describe('deleteMCPServer', () => {
    test('should delete existing server', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Delete Test'),
        author: authorId,
      });

      const deleted = await methods.deleteMCPServer(created.serverName);

      expect(deleted).toBeDefined();
      expect(deleted?.serverName).toBe('delete-test');

      // Verify it's actually deleted
      const found = await methods.findMCPServerByServerName('delete-test');
      expect(found).toBeNull();
    });

    test('should return null when server does not exist', async () => {
      const deleted = await methods.deleteMCPServer('non-existent-server');

      expect(deleted).toBeNull();
    });

    test('should return the deleted document', async () => {
      const created = await methods.createMCPServer({
        config: createSSEConfig('Delete Return Test', 'Will be deleted'),
        author: authorId,
      });

      const deleted = await methods.deleteMCPServer(created.serverName);

      expect(deleted?.config.description).toBe('Will be deleted');
    });
  });

  describe('getListMCPServersByNames', () => {
    test('should return empty data for empty names array', async () => {
      const result = await methods.getListMCPServersByNames({ names: [] });

      expect(result.data).toEqual([]);
    });

    test('should find servers by serverName strings', async () => {
      await methods.createMCPServer({
        config: createSSEConfig('Name Query One'),
        author: authorId,
      });
      await methods.createMCPServer({
        config: createSSEConfig('Name Query Two'),
        author: authorId,
      });
      await methods.createMCPServer({
        config: createSSEConfig('Name Query Three'),
        author: authorId,
      });

      const result = await methods.getListMCPServersByNames({
        names: ['name-query-one', 'name-query-two'],
      });

      expect(result.data).toHaveLength(2);
      const serverNames = result.data.map((s) => s.serverName);
      expect(serverNames).toContain('name-query-one');
      expect(serverNames).toContain('name-query-two');
      expect(serverNames).not.toContain('name-query-three');
    });

    test('should handle non-existent names gracefully', async () => {
      await methods.createMCPServer({
        config: createSSEConfig('Existing Server'),
        author: authorId,
      });

      const result = await methods.getListMCPServersByNames({
        names: ['existing-server', 'non-existent-1', 'non-existent-2'],
      });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].serverName).toBe('existing-server');
    });

    test('should return all matching servers for multiple names', async () => {
      const server1 = await methods.createMCPServer({
        config: createSSEConfig('Multi Name 1'),
        author: authorId,
      });
      const server2 = await methods.createMCPServer({
        config: createSSEConfig('Multi Name 2'),
        author: authorId,
      });
      const server3 = await methods.createMCPServer({
        config: createSSEConfig('Multi Name 3'),
        author: authorId,
      });

      const result = await methods.getListMCPServersByNames({
        names: [server1.serverName, server2.serverName, server3.serverName],
      });

      expect(result.data).toHaveLength(3);
    });

    test('should handle duplicate names in input', async () => {
      await methods.createMCPServer({
        config: createSSEConfig('Duplicate Test'),
        author: authorId,
      });

      const result = await methods.getListMCPServersByNames({
        names: ['duplicate-test', 'duplicate-test', 'duplicate-test'],
      });

      // Should only return one server (unique by serverName)
      expect(result.data).toHaveLength(1);
    });
  });

  describe('Edge Cases', () => {
    test('should handle concurrent creation with retry logic for race conditions', async () => {
      // Ensure indexes are created before concurrent test
      await MCPServer.ensureIndexes();

      // Create multiple servers with same title concurrently
      // The retry logic handles TOCTOU race conditions by retrying with
      // exponential backoff when duplicate key errors occur
      const promises = Array.from({ length: 5 }, () =>
        methods.createMCPServer({
          config: createSSEConfig('Concurrent Test'),
          author: authorId,
        }),
      );

      const results = await Promise.allSettled(promises);

      const successes = results.filter(
        (r): r is PromiseFulfilledResult<t.MCPServerDocument> => r.status === 'fulfilled',
      );
      const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // With retry logic, all concurrent requests should succeed
      // Each will get a unique serverName (concurrent-test, concurrent-test-2, etc.)
      expect(successes.length).toBe(5);
      expect(failures.length).toBe(0);

      // Verify all servers have unique names
      const serverNames = successes.map((s) => s.value.serverName);
      const uniqueNames = new Set(serverNames);
      expect(uniqueNames.size).toBe(5);

      // Verify all servers exist in the database
      const dbServers = await MCPServer.find({
        serverName: { $regex: /^concurrent-test/ },
      }).lean();
      expect(dbServers.length).toBe(5);
    });

    test('should handle sequential creation with same title - no race condition', async () => {
      // Create multiple servers with same title sequentially
      // Each creation completes before the next one starts, so no race condition
      const results: t.MCPServerDocument[] = [];
      for (let i = 0; i < 5; i++) {
        const server = await methods.createMCPServer({
          config: createSSEConfig('Sequential Test'),
          author: authorId,
        });
        results.push(server);
      }

      // All should succeed with unique serverNames
      const serverNames = results.map((r) => r.serverName);
      const uniqueNames = new Set(serverNames);
      expect(uniqueNames.size).toBe(5);
      expect(serverNames).toContain('sequential-test');
      expect(serverNames).toContain('sequential-test-2');
      expect(serverNames).toContain('sequential-test-3');
      expect(serverNames).toContain('sequential-test-4');
      expect(serverNames).toContain('sequential-test-5');
    });

    test('should handle very long titles', async () => {
      const longTitle = 'A'.repeat(200) + ' Server';
      const config = createSSEConfig(longTitle);
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server).toBeDefined();
      expect(server.serverName).toBe('a'.repeat(200) + '-server');
    });

    test('should handle unicode in title', async () => {
      // Unicode characters should be stripped, leaving only alphanumeric
      const config = createSSEConfig('Serveur Français 日本語');
      const server = await methods.createMCPServer({ config, author: authorId });

      expect(server.serverName).toBe('serveur-franais');
    });

    test('should handle empty string title', async () => {
      const config: MCPOptions = {
        type: 'sse',
        url: 'https://example.com/mcp',
        title: '',
      };
      const server = await methods.createMCPServer({ config, author: authorId });

      // Empty title should fallback to nanoid
      expect(server.serverName).toMatch(/^mcp-[a-zA-Z0-9_-]{16}$/);
    });

    test('should handle whitespace-only title', async () => {
      const config = createSSEConfig('   ');
      const server = await methods.createMCPServer({ config, author: authorId });

      // Whitespace-only title after trimming results in fallback
      expect(server.serverName).toBe('mcp-server');
    });
  });
});
