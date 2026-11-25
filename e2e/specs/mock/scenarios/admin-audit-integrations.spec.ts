import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * Admin integration changes (MCP servers, Langfuse, audit log reads and
 * exports, group deletion) leave an audit trail that never carries secrets or
 * searched-for text, and a group is only removed once its permissions are.
 * Each probe drives the real handlers from the built @librechat/api with an
 * in-memory recorder and prints the result as JSON.
 */

const PREAMBLE = `
const api = require('@librechat/api');
const { Types } = require('mongoose');
const out = (value) => { process.stdout.write('RESULT' + JSON.stringify(value)); process.exit(0); };
const makeRes = () => {
  const res = { statusCode: 200, body: undefined, headers: {}, chunks: [] };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.setHeader = (key, value) => { res.headers[key] = value; };
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = () => res;
  res.once = () => res;
  res.on = () => res;
  return res;
};
const user = { _id: new Types.ObjectId(), name: 'Admin', email: 'admin@example.com' };
`;

function probe(body: string): unknown {
  const result = run(
    'node',
    [
      '-e',
      `${PREAMBLE}\n(async () => {\n${body}\n})().catch((e) => { console.error(e); process.exit(1); });`,
    ],
    {
      cwd: resolve(repoRoot, 'api'),
    },
  );
  expect(result.status, result.output).toBe(0);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('RESULT') + 'RESULT'.length));
}

test.describe('admin integration auditing', () => {
  test.beforeEach(() => inOneProject());

  test('an MCP server update is audited by field name without the values @scenario:mcp-server-update-audit-lists-field-names-only', () => {
    const entries = probe(`
      const entries = [];
      const audit = api.createMCPServerAuditor({ recordAuditEntry: async (input) => { entries.push(input); } });
      await audit({ user }, {
        action: 'mcp_server.updated',
        serverName: 'srv',
        previous: { title: 'Docs', url: 'https://old.example.com', headers: { Authorization: 'Bearer old-secret' } },
        next: { title: 'Docs', url: 'https://old.example.com', headers: { Authorization: 'Bearer new-secret' } },
      });
      out(entries);
    `) as Array<{ action: string; target: { id: string }; metadata: { fields?: string } }>;
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('mcp_server.updated');
    expect(entries[0].target.id).toBe('srv');
    expect(entries[0].metadata.fields).toBe('headers');
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  test('an MCP server deletion is audited as a warning @scenario:mcp-server-delete-audit-is-a-warning', () => {
    const entries = probe(`
      const entries = [];
      const audit = api.createMCPServerAuditor({ recordAuditEntry: async (input) => { entries.push(input); } });
      await audit({ user }, { action: 'mcp_server.deleted', serverName: 'gone', previous: { title: 'Gone' } });
      out(entries);
    `) as Array<{ action: string; severity: string }>;
    expect(entries[0].action).toBe('mcp_server.deleted');
    expect(entries[0].severity).toBe('warning');
  });

  test('an audit write failure does not turn a deleted MCP server into an error @scenario:audit-write-failure-keeps-the-completed-change', () => {
    const result = probe(`
      const audit = api.createMCPServerAuditor({ recordAuditEntry: async () => { throw new Error('db down'); } });
      let threw = false;
      try {
        await audit({ user }, { action: 'mcp_server.created', serverName: 'srv', next: { title: 'Docs' } });
      } catch { threw = true; }
      out({ threw });
    `) as { threw: boolean };
    expect(result.threw).toBe(false);
  });

  test('a group whose cleanup fails is kept with its config restored and reports GROUP_CLEANUP_FAILED @scenario:group-delete-keeps-the-group-when-cleanup-fails', () => {
    const result = probe(`
      const id = new Types.ObjectId().toString();
      let deleted = false;
      const restored = [];
      const noop = async () => undefined;
      const handlers = api.createAdminGroupsHandlers({
        listGroups: noop, countGroups: noop, createGroup: noop, updateGroupById: noop,
        findGroupById: async () => ({ _id: new Types.ObjectId(id), name: 'G', memberIds: [] }),
        deleteGroup: async () => { deleted = true; return { _id: id }; },
        restoreConfig: async () => { restored.push('config'); return true; },
        deleteConfig: async () => ({ principalType: 'group', principalId: id, overrides: {} }),
        deleteAclEntries: async () => { throw new Error('acl store down'); },
      });
      const res = makeRes();
      await handlers.deleteGroup({ params: { id }, query: {}, body: {}, user }, res);
      out({ status: res.statusCode, code: res.body && res.body.code, deleted, restored });
    `) as { status: number; code?: string; deleted: boolean; restored: string[] };
    expect(result.status).toBe(500);
    expect(result.code).toBe('GROUP_CLEANUP_FAILED');
    expect(result.deleted).toBe(false);
    expect(result.restored).toEqual(['config']);
  });
});
