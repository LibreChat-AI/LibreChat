import { randomUUID } from 'crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import cleanupUser from '../../../setup/cleanupUser';
import { inOneProject, repoRoot } from './lint.helpers';
import { withMongo } from '../db';

/**
 * The admin panel signs in through `POST /api/admin/login/local`. When LDAP is configured that
 * route checks the credentials against the directory, as the app's own sign-in does, because a
 * directory user has no local password; otherwise it keeps checking local accounts.
 *
 * LDAP is a process-wide switch that also moves the app's own sign-in, and the mock harness
 * runs one backend with no directory server, so the directory cases read their verdicts from one
 * run of the route spec. It drives the real router, middleware, strategies, capability check and a
 * database, with only the LDAP client library answering from an in-memory directory. The local
 * cases run against the live backend.
 */

type JestAssertion = { fullName: string; status: string };
type JestReport = { testResults: { assertionResults: JestAssertion[] }[] };

const SPEC = 'server/routes/admin/auth.ldap.test.js';
const JEST = resolve(repoRoot, 'node_modules/.bin/jest');
const LDAP_SET = 'admin panel sign-in with LDAP configured';
const LDAP_PARTIAL = [
  'admin panel sign-in when only the LDAP server is set',
  'admin panel sign-in when only the LDAP search base is set',
];

let report: JestAssertion[] | undefined;

/**
 * Runs the route spec once per worker and keeps every verdict it reports. The run is bounded on
 * its own, since a synchronous child blocks the test timeout, and a nonzero exit fails the
 * scenario even when every assertion passed, as a suite-level error does.
 */
function routeResults(): JestAssertion[] {
  if (report) {
    return report;
  }
  const result = spawnSync(JEST, [SPEC, '--json', '--maxWorkers=1'], {
    cwd: resolve(repoRoot, 'api'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  const stdout = result.stdout ?? '';
  const output = `${stdout}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0) {
    throw new Error(`jest did not pass (${result.error?.message ?? result.status}):\n${output}`);
  }
  const start = stdout.indexOf('{');
  if (start === -1) {
    throw new Error(`jest printed no JSON report:\n${output}`);
  }
  const parsed = JSON.parse(stdout.slice(start)) as JestReport;
  report = parsed.testResults.flatMap((file) => file.assertionResults);
  return report;
}

const expectPassed = (fullName: string) => {
  const assertion = routeResults().find((entry) => entry.fullName === fullName);
  expect(assertion, `no route spec named "${fullName}"`).toBeDefined();
  expect(assertion?.status).toBe('passed');
};

test.describe('admin panel sign-in with a directory configured', () => {
  test.beforeEach(() => {
    inOneProject();
    test.setTimeout(330_000);
  });

  test('a directory user with admin access signs in to the admin panel @scenario:admin-login-ldap-admin-signs-in', () => {
    expectPassed(`${LDAP_SET} signs in a directory user who holds admin access`);
  });

  test('a directory user without admin access is refused @scenario:admin-login-ldap-non-admin-refused', () => {
    expectPassed(`${LDAP_SET} refuses a directory user who lacks admin access`);
  });

  test('wrong directory credentials are refused and never fall back to a local account @scenario:admin-login-ldap-bad-credentials-refused', () => {
    expectPassed(
      `${LDAP_SET} refuses wrong directory credentials without falling back to a local account`,
    );
  });

  test('malformed credentials are rejected before they reach the directory @scenario:admin-login-ldap-malformed-rejected', () => {
    expectPassed(`${LDAP_SET} rejects malformed credentials before they reach the directory`);
  });

  test('a half-configured directory keeps the admin panel on local sign-in @scenario:admin-login-ldap-half-configured-stays-local', () => {
    for (const label of LDAP_PARTIAL) {
      expectPassed(`${label} signs in a local admin through the local account store`);
      expectPassed(`${label} does not ask the directory about anyone else`);
    }
  });
});

test.describe('admin panel sign-in without a directory', () => {
  test.beforeEach(() => {
    inOneProject();
  });

  test('a local admin signs in to the admin panel and the session works @scenario:admin-login-local-admin-signs-in', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const user = {
      email: `admin-login-${randomUUID().slice(0, 8)}@example.com`,
      name: 'Admin Login',
      password: 'securepassword789',
    };
    try {
      const register = await request.post('/api/auth/register', {
        data: { ...user, confirm_password: user.password },
      });
      expect(register.ok()).toBeTruthy();
      await withMongo((db) =>
        db.collection('users').updateOne({ email: user.email }, { $set: { role: 'ADMIN' } }),
      );

      const login = await request.post('/api/admin/login/local', {
        data: { email: user.email, password: user.password },
      });
      expect(login.status()).toBe(200);
      const { token, user: signedIn } = (await login.json()) as {
        token: string;
        user: { email: string };
      };
      expect(token).toBeTruthy();
      expect(signedIn.email).toBe(user.email);

      const verify = await request.get('/api/admin/verify', {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(verify.status()).toBe(200);
    } finally {
      await request.dispose();
      await cleanupUser(user);
    }
  });

  test('a wrong local password is refused without a session @scenario:admin-login-local-wrong-password-refused', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const user = {
      email: `admin-login-${randomUUID().slice(0, 8)}@example.com`,
      name: 'Admin Login Wrong',
      password: 'securepassword789',
    };
    try {
      const register = await request.post('/api/auth/register', {
        data: { ...user, confirm_password: user.password },
      });
      expect(register.ok()).toBeTruthy();
      await withMongo((db) =>
        db.collection('users').updateOne({ email: user.email }, { $set: { role: 'ADMIN' } }),
      );

      const login = await request.post('/api/admin/login/local', {
        data: { email: user.email, password: 'not-the-password' },
      });
      expect(login.status()).toBe(404);
      expect(await login.json()).not.toHaveProperty('token');
    } finally {
      await request.dispose();
      await cleanupUser(user);
    }
  });
});
