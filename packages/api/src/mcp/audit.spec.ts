import type { ServerRequest } from '~/types/http';
import { createMCPServerAuditor, settleMCPCommit, diffMCPServerFields } from './audit';
import { MCPCommittedWriteError } from '~/mcp/errors';

const req = { user: { id: 'user-1', name: 'Alice' }, headers: {} } as unknown as ServerRequest;

describe('diffMCPServerFields', () => {
  it('returns sorted names of changed user-input fields only', () => {
    expect(
      diffMCPServerFields(
        { url: 'https://a', title: 'T', headers: { A: '1' }, dbId: 'x' },
        { url: 'https://b', title: 'T', headers: { A: '2' }, dbId: 'y' },
      ),
    ).toEqual(['headers', 'url']);
  });

  it('ignores key order inside record fields', () => {
    expect(
      diffMCPServerFields({ headers: { A: '1', B: '2' } }, { headers: { B: '2', A: '1' } }),
    ).toEqual([]);
  });

  it('treats a missing side as all-new', () => {
    expect(diffMCPServerFields(undefined, { type: 'sse', url: 'https://a' })).toEqual([
      'type',
      'url',
    ]);
  });
});

describe('createMCPServerAuditor', () => {
  it('lists no fields for a delete', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const audit = createMCPServerAuditor({ recordAuditEntry });

    await audit(req, {
      action: 'mcp_server.deleted',
      serverName: 'srv',
      previous: { url: 'https://a', title: 'Srv' },
    });

    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp_server.deleted',
        severity: 'warning',
        target: { type: 'mcp_server', id: 'srv', name: 'Srv' },
        metadata: { source: 'DB' },
      }),
    );
  });

  it('does not record a preserved OAuth secret as a change', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const audit = createMCPServerAuditor({ recordAuditEntry });

    await audit(req, {
      action: 'mcp_server.updated',
      serverName: 'srv',
      previous: { title: 'Old', oauth: { client_id: 'id', client_secret: 'stored' } },
      next: { title: 'New', oauth: { client_id: 'id' } },
    });

    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: 'DB', fields: 'title' } }),
    );
  });

  it('does not record omitted optional OAuth binding fields as a change', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const audit = createMCPServerAuditor({ recordAuditEntry });

    await audit(req, {
      action: 'mcp_server.updated',
      serverName: 'srv',
      previous: {
        title: 'Old',
        oauth: {
          client_id: 'id',
          client_secret: 'stored',
          revocation_endpoint: 'https://idp.example/revoke',
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        },
      },
      next: { title: 'New', oauth: { client_id: 'id' } },
    });

    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: 'DB', fields: 'title' } }),
    );
  });

  it('diffs against the persisted config, not the submission', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const audit = createMCPServerAuditor({ recordAuditEntry });
    const headers = { Authorization: 'Bearer {{MCP_API_KEY_srv}}' };

    await audit(req, {
      action: 'mcp_server.updated',
      serverName: 'srv',
      previous: { title: 'Old', headers },
      next: { title: 'New', headers },
    });

    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: 'DB', fields: 'title' } }),
    );
  });

  it('marks the entry when the cache refresh failed after the commit', async () => {
    const recordAuditEntry = jest.fn().mockResolvedValue(undefined);
    const audit = createMCPServerAuditor({ recordAuditEntry });

    await audit(req, {
      action: 'mcp_server.deleted',
      serverName: 'srv',
      previous: { title: 'Old' },
      postWriteFailed: true,
    });

    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'mcp_server.deleted',
        metadata: { source: 'DB', postWrite: 'failed' },
      }),
    );
  });

  describe('MCPCommittedWriteError', () => {
    it('keeps the persisted config out of serialized and logged errors', () => {
      const error = new MCPCommittedWriteError(
        { oauth: { client_secret: 'super-secret' } },
        new Error('redis down'),
      );

      expect(error.committed).toEqual({ oauth: { client_secret: 'super-secret' } });
      expect(JSON.stringify(error)).not.toContain('super-secret');
      expect(Object.keys(error)).not.toContain('committed');
      expect(Object.keys(error)).not.toContain('cause');
      expect(error.cause).toBeInstanceOf(Error);
    });
  });

  describe('settleMCPCommit', () => {
    it('returns the committed result when the write succeeds', async () => {
      await expect(settleMCPCommit(async () => ({ title: 'x' }))).resolves.toEqual({
        committed: { title: 'x' },
      });
    });

    it('returns the committed result together with an invalidation failure', async () => {
      const failure = new MCPCommittedWriteError({ title: 'x' }, new Error('redis down'));

      const settled = await settleMCPCommit(async () => {
        throw failure;
      });

      expect(settled.committed).toEqual({ title: 'x' });
      expect(settled.postWriteError).toBe(failure);
    });

    it('rethrows any other failure as an uncommitted write', async () => {
      await expect(
        settleMCPCommit(async () => {
          throw new Error('write failed');
        }),
      ).rejects.toThrow('write failed');
    });
  });

  it('runs the post-commit steps before the audit write and still audits when they throw', async () => {
    const order: string[] = [];
    const recordAuditEntry = jest.fn().mockImplementation(async () => void order.push('audit'));
    const audit = createMCPServerAuditor({ recordAuditEntry });

    await expect(
      audit(req, { action: 'mcp_server.deleted', serverName: 'srv' }, async () => {
        order.push('fence');
        throw new Error('fence failed');
      }),
    ).rejects.toThrow('fence failed');

    expect(order).toEqual(['fence', 'audit']);
    expect(recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: 'DB', postWrite: 'failed' } }),
    );
  });

  it('is a no-op without a recorder', async () => {
    await expect(
      createMCPServerAuditor({})(req, { action: 'mcp_server.created', serverName: 'srv' }),
    ).resolves.toBeUndefined();
  });
});
