import fs from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { getRuntimeEnvPath } from '../../../setup/env';
import { run, repoRoot, inOneProject } from './lint.helpers';

/**
 * An IdP login or remote agent request that moves a user's role writes it conditionally on the
 * role it read, and audits only the transition its own write performed. Each probe seeds users
 * in the run's disposable database, drives `writeIdpRoleChange` from the built @librechat/api
 * with the real data-schemas user methods, collects the audit entries it emits, removes the
 * users, and prints the result as JSON.
 */

type AuditEntry = {
  action: string;
  severity: string;
  target: { type: string; id: string };
  metadata: { previousRole: string | null; role: string; source: string };
};

const PREAMBLE = `
const mongoose = require('mongoose');
const { createMethods, createModels } = require('@librechat/data-schemas');
const { writeIdpRoleChange } = require('@librechat/api');
const out = (value) => { process.stdout.write('\\nRESULT' + JSON.stringify(value) + '\\n'); };
const created = [];
const entries = [];
let methods;
const seed = async (role) => {
  const doc = await mongoose.models.User.create({
    email: 'idp-role-' + new mongoose.Types.ObjectId().toString() + '@example.com',
    provider: 'openid',
    role,
  });
  created.push(doc._id);
  return doc._id.toString();
};
const write = (userId, role, observedRole, source = 'openid_login') =>
  writeIdpRoleChange({
    userId,
    update: { role },
    observedRole,
    updateUser: methods.updateUser,
    findUser: methods.findUser,
    recordAuditEntry: async (entry) => { entries.push(entry); },
    source,
  });
const storedRole = async (userId) => (await methods.findUser({ _id: userId }, 'role'))?.role ?? null;
`;

function mongoUri(): string {
  const runtime = JSON.parse(fs.readFileSync(getRuntimeEnvPath(), 'utf8')) as {
    MONGO_URI?: string;
  };
  /* The local mock run uses LibreChat-e2e and the verification runner a per-run lc_verify_*
   * database; anything else is a real deployment, and these probes write users directly. */
  if (
    !runtime.MONGO_URI ||
    !/\/(LibreChat-e2e|lc_verify_[A-Za-z0-9_]+)(?:\?|$)/.test(runtime.MONGO_URI)
  ) {
    throw new Error('IdP role audit acceptance requires a disposable E2E Mongo database');
  }
  return runtime.MONGO_URI;
}

function probe(body: string): unknown {
  const script = `${PREAMBLE}
(async () => {
  await mongoose.connect(${JSON.stringify(mongoUri())});
  createModels(mongoose);
  methods = createMethods(mongoose);
  try {
${body}
  } finally {
    await mongoose.models.User.deleteMany({ _id: { $in: created } });
    await mongoose.disconnect();
  }
})().then(
  /* @librechat/api opens a Redis client on import under the harness env, which keeps the
   * process alive after the probe finishes. */
  () => process.exit(0),
  (e) => { console.error(e); process.exit(1); },
);`;
  const result = run('node', ['-e', script], { cwd: resolve(repoRoot, 'api') });
  expect(result.status, result.output).toBe(0);
  /* Loggers share stdout, so the result is the one line that starts with the marker. */
  const line = result.stdout.split('\n').find((entry) => entry.startsWith('RESULT'));
  expect(line, result.output).toBeDefined();
  return JSON.parse((line ?? '').slice('RESULT'.length));
}

test.describe('IdP role change auditing', () => {
  test.beforeEach(() => inOneProject());

  test('overlapping logins that promote a user from the same read leave one audit entry @scenario:overlapping-idp-logins-audit-one-role-change', () => {
    const result = probe(`
      const userId = await seed('USER');
      const users = await Promise.all([
        write(userId, 'ADMIN', 'USER'),
        write(userId, 'ADMIN', 'USER'),
        write(userId, 'ADMIN', 'USER', 'remote_agent_oidc'),
      ]);
      out({ userId, roles: users.map((user) => user && user.role), stored: await storedRole(userId), entries });
    `) as { userId: string; roles: string[]; stored: string; entries: AuditEntry[] };

    expect(result.roles).toEqual(['ADMIN', 'ADMIN', 'ADMIN']);
    expect(result.stored).toBe('ADMIN');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      action: 'user.role_changed',
      severity: 'critical',
      target: { type: 'user', id: result.userId },
      metadata: { previousRole: 'USER', role: 'ADMIN' },
    });
  });

  test('a login whose read went stale audits the role its write replaced @scenario:stale-idp-login-audits-the-replaced-role', () => {
    const result = probe(`
      const userId = await seed('USER');
      await methods.updateUser(userId, { role: 'ADMIN' });
      const user = await write(userId, 'USER', 'USER');
      out({ role: user && user.role, stored: await storedRole(userId), entries });
    `) as { role: string; stored: string; entries: AuditEntry[] };

    expect(result.role).toBe('USER');
    expect(result.stored).toBe('USER');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].metadata).toMatchObject({ previousRole: 'ADMIN', role: 'USER' });
  });

  test('a role write for a user deleted mid-login stores and audits nothing @scenario:deleted-idp-user-role-write-audits-nothing', () => {
    const result = probe(`
      const userId = await seed('USER');
      await mongoose.models.User.deleteOne({ _id: userId });
      const user = await write(userId, 'ADMIN', 'USER');
      out({ user, remaining: await mongoose.models.User.countDocuments({ _id: userId }), entries });
    `) as { user: unknown; remaining: number; entries: AuditEntry[] };

    expect(result.user).toBeNull();
    expect(result.remaining).toBe(0);
    expect(result.entries).toHaveLength(0);
  });
});
