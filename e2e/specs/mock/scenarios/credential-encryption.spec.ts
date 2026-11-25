import { createCipheriv, randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import type { User } from '../../../types';
import cleanupUser from '../../../setup/cleanupUser';
import { loginAdmin } from '../content-filters.helpers';
import { withMongo } from '../db';

/**
 * Stored user credentials (tool and web search keys, MCP custom user variables) are
 * written in the random-IV `v3:` format and read by format, so records written in the
 * legacy fixed-IV format keep working next to new ones. The `e2e-user-vars` MCP fixture
 * starts only when the token it receives equals the expected plaintext, so a successful
 * reinitialize proves the server decrypted the stored value exactly. `credentials.writeFormat:
 * legacy` switches new writes back to the fixed-IV format for rolling upgrades.
 */

const MCP_SERVER = 'e2e-user-vars';
const MCP_PLUGIN_KEY = `mcp_${MCP_SERVER}`;
const MCP_VAR = 'E2E_MCP_USER_TOKEN';
/** Must match `E2E_MCP_EXPECTED_USER_TOKEN` in e2e/config/librechat.e2e.yaml. */
const MCP_TOKEN = 'e2e-user-token-secret';
const WEB_SEARCH = 'web_search';
const WEB_SEARCH_FIELDS = {
  serperApiKey: 'SERPER_API_KEY',
  firecrawlApiKey: 'FIRECRAWL_API_KEY',
  jinaApiKey: 'JINA_API_KEY',
} as const;
const V3_FORMAT = /^v3:[0-9a-f]{32}:[0-9a-f]+$/;
const LEGACY_FORMAT = /^[0-9a-f]+$/;

type StoredAuth = { authField: string; value: string; pluginKey?: string };

async function registerAndLogin(
  request: APIRequestContext,
  user: User,
): Promise<{ token: string; userId: string }> {
  const registerResponse = await request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const loginResponse = await request.post('/api/auth/login', {
    data: { email: user.email, password: user.password },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const body = (await loginResponse.json()) as { token?: string; user?: { _id?: string } };
  if (!body.token || !body.user?._id) {
    throw new Error('Expected login response to include a bearer token and user id');
  }
  return { token: body.token, userId: body.user._id };
}

function newUser(label: string): User {
  return {
    email: `credential-${label}-${randomUUID()}@example.com`,
    name: 'Credential Encryption',
    password: 'securepassword123',
  };
}

async function installPluginAuth(
  request: APIRequestContext,
  token: string,
  pluginKey: string,
  auth: Record<string, string>,
): Promise<void> {
  const response = await request.post('/api/user/plugins', {
    headers: { Authorization: `Bearer ${token}` },
    data: { pluginKey, action: 'install', auth },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function readStoredAuths(userId: string, pluginKey: string): Promise<StoredAuth[]> {
  return withMongo(async (db) => {
    const docs = await db.collection('pluginauths').find({ userId, pluginKey }).toArray();
    return docs.map((doc) => ({
      authField: doc.authField as string,
      value: doc.value as string,
      pluginKey: doc.pluginKey as string | undefined,
    }));
  });
}

/**
 * Produces a value in the legacy fixed-IV format with the server's credential key and IV,
 * which the mock config exports to the test runner. No current write path emits this
 * format by default, so a legacy record has to be built the way an old install stored it.
 */
function legacyCiphertext(plaintext: string): string {
  const key = Buffer.from(process.env.CREDS_KEY ?? '', 'hex');
  const iv = Buffer.from(process.env.CREDS_IV ?? '', 'hex');
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const value = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('hex');
  expect(value).toMatch(LEGACY_FORMAT);
  return value;
}

async function seedStoredAuth(userId: string, auth: StoredAuth): Promise<void> {
  await withMongo(async (db) => {
    const now = new Date();
    await db
      .collection('pluginauths')
      .updateOne(
        { userId, pluginKey: auth.pluginKey, authField: auth.authField },
        { $set: { value: auth.value, updatedAt: now }, $setOnInsert: { createdAt: now } },
        { upsert: true },
      );
  });
}

async function cleanupCredentials(user: User): Promise<void> {
  await withMongo(async (db) => {
    const doc = await db.collection('users').findOne({ email: user.email });
    if (doc) {
      await db.collection('pluginauths').deleteMany({ userId: doc._id.toString() });
    }
  });
  await cleanupUser(user);
}

async function webSearchAuthenticated(request: APIRequestContext, token: string): Promise<boolean> {
  const response = await request.get(`/api/agents/tools/${WEB_SEARCH}/auth`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { authenticated?: boolean };
  return body.authenticated === true;
}

async function mcpVarIsSet(request: APIRequestContext, token: string): Promise<boolean> {
  const response = await request.get(`/api/mcp/${MCP_SERVER}/auth-values`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { authValueFlags?: Record<string, boolean> };
  return body.authValueFlags?.[MCP_VAR] === true;
}

/**
 * The MCP connection circuit breaker is keyed by server name, not user, so parallel projects
 * reinitializing `e2e-user-vars` can trip its cooldown (15s by default). Retry past one cooldown.
 */
async function expectMcpConnects(request: APIRequestContext, token: string): Promise<void> {
  await expect
    .poll(() => reinitializeMcp(request, token), { timeout: 45000, intervals: [1000, 5000] })
    .toBe(true);
}

async function reinitializeMcp(request: APIRequestContext, token: string): Promise<boolean> {
  const response = await request.post(`/api/mcp/${MCP_SERVER}/reinitialize`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok()) {
    return false;
  }
  const body = (await response.json()) as { success?: boolean };
  return body.success === true;
}

test.describe('stored credential encryption', () => {
  test('a saved web search key is stored with a random IV and still authenticates @scenario:plugin-credential-save-stores-v3', async ({
    request,
  }) => {
    const user = newUser('web-save');
    try {
      const { token, userId } = await registerAndLogin(request, user);
      const secret = `e2e-search-${randomUUID()}`;
      const auth = Object.fromEntries(Object.keys(WEB_SEARCH_FIELDS).map((key) => [key, secret]));

      await installPluginAuth(request, token, WEB_SEARCH, auth);
      const first = await readStoredAuths(userId, WEB_SEARCH);
      const credentials = first.filter((doc) =>
        (Object.values(WEB_SEARCH_FIELDS) as string[]).includes(doc.authField),
      );
      expect(credentials.map((doc) => doc.authField).sort()).toEqual(
        Object.values(WEB_SEARCH_FIELDS).sort(),
      );
      for (const doc of credentials) {
        expect(doc.value).toMatch(V3_FORMAT);
        expect(doc.value).not.toContain(secret);
      }
      /** Same plaintext in three fields: a fixed IV would give three identical values. */
      expect(new Set(credentials.map((doc) => doc.value)).size).toBe(credentials.length);

      expect(await webSearchAuthenticated(request, token)).toBe(true);

      /** Saving the same value again yields a new ciphertext. */
      await installPluginAuth(request, token, WEB_SEARCH, auth);
      const second = await readStoredAuths(userId, WEB_SEARCH);
      for (const doc of credentials) {
        const resaved = second.find((entry) => entry.authField === doc.authField);
        expect(resaved?.value).toMatch(V3_FORMAT);
        expect(resaved?.value).not.toBe(doc.value);
      }
      expect(await webSearchAuthenticated(request, token)).toBe(true);
    } finally {
      await cleanupCredentials(user);
    }
  });

  test('a web search key stored in the legacy format still authenticates and is not rewritten @scenario:plugin-credential-legacy-record-authenticates', async ({
    request,
  }) => {
    const user = newUser('web-legacy');
    try {
      const { token, userId } = await registerAndLogin(request, user);
      expect(await webSearchAuthenticated(request, token)).toBe(false);

      const seeded: StoredAuth[] = [];
      for (const authField of Object.values(WEB_SEARCH_FIELDS)) {
        const value = legacyCiphertext(`e2e-legacy-${authField}`);
        const auth = { authField, value, pluginKey: WEB_SEARCH };
        await seedStoredAuth(userId, auth);
        seeded.push(auth);
      }

      expect(await webSearchAuthenticated(request, token)).toBe(true);

      const stored = await readStoredAuths(userId, WEB_SEARCH);
      for (const auth of seeded) {
        expect(stored.find((doc) => doc.authField === auth.authField)?.value).toBe(auth.value);
      }
    } finally {
      await cleanupCredentials(user);
    }
  });

  test('legacy and v3 web search keys for one user authenticate together @scenario:plugin-credential-mixed-records-authenticate', async ({
    request,
  }) => {
    const user = newUser('web-mixed');
    try {
      const { token, userId } = await registerAndLogin(request, user);
      const secret = `e2e-search-${randomUUID()}`;
      await installPluginAuth(request, token, WEB_SEARCH, {
        firecrawlApiKey: secret,
        jinaApiKey: secret,
      });
      const legacy = legacyCiphertext(secret);
      await seedStoredAuth(userId, {
        authField: WEB_SEARCH_FIELDS.serperApiKey,
        value: legacy,
        pluginKey: WEB_SEARCH,
      });

      const stored = await readStoredAuths(userId, WEB_SEARCH);
      const formats = Object.values(WEB_SEARCH_FIELDS).map(
        (field) => stored.find((doc) => doc.authField === field)?.value ?? '',
      );
      expect(formats[0]).toMatch(LEGACY_FORMAT);
      expect(formats[1]).toMatch(V3_FORMAT);
      expect(formats[2]).toMatch(V3_FORMAT);

      expect(await webSearchAuthenticated(request, token)).toBe(true);
    } finally {
      await cleanupCredentials(user);
    }
  });

  test('a saved MCP custom user variable is stored as v3 and reaches the server decrypted @scenario:mcp-user-var-save-stores-v3', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const user = newUser('mcp-save');
    try {
      const { token, userId } = await registerAndLogin(request, user);
      expect(await mcpVarIsSet(request, token)).toBe(false);
      expect(await reinitializeMcp(request, token)).toBe(false);

      await installPluginAuth(request, token, MCP_PLUGIN_KEY, { [MCP_VAR]: MCP_TOKEN });
      const stored = await readStoredAuths(userId, MCP_PLUGIN_KEY);
      expect(stored).toHaveLength(1);
      expect(stored[0].authField).toBe(MCP_VAR);
      expect(stored[0].value).toMatch(V3_FORMAT);
      expect(stored[0].value).not.toContain(MCP_TOKEN);

      expect(await mcpVarIsSet(request, token)).toBe(true);
      await expectMcpConnects(request, token);
    } finally {
      await cleanupCredentials(user);
    }
  });

  test('an MCP custom user variable stored in the legacy format still connects and is not rewritten @scenario:mcp-user-var-legacy-record-connects', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const user = newUser('mcp-legacy');
    try {
      const { token, userId } = await registerAndLogin(request, user);
      const value = legacyCiphertext(MCP_TOKEN);
      await seedStoredAuth(userId, { authField: MCP_VAR, value, pluginKey: MCP_PLUGIN_KEY });

      expect(await mcpVarIsSet(request, token)).toBe(true);
      await expectMcpConnects(request, token);

      const stored = await readStoredAuths(userId, MCP_PLUGIN_KEY);
      expect(stored.map((doc) => doc.value)).toEqual([value]);
    } finally {
      await cleanupCredentials(user);
    }
  });

  test('with the legacy write format configured, a saved credential is stored in the legacy format and still connects @scenario:credential-legacy-write-format-config', async ({
    request,
  }) => {
    test.setTimeout(120000);
    const user = newUser('legacy-format');
    const adminToken = await loginAdmin(request);
    const adminHeaders = { Authorization: `Bearer ${adminToken}` };
    let userId: string | undefined;
    try {
      const login = await registerAndLogin(request, user);
      userId = login.userId;
      const { token } = login;

      /** Per-user override, so only this fresh user's writes change format. */
      const put = await request.put(`/api/admin/config/user/${userId}`, {
        headers: adminHeaders,
        data: { overrides: { credentials: { writeFormat: 'legacy' } } },
      });
      /** A first override for a principal is created (201, `configVersion` 1). */
      expect(put.status(), await put.text()).toBe(201);
      const created = (await put.json()) as {
        config?: { overrides?: { credentials?: { writeFormat?: string } } };
      };
      expect(created.config?.overrides?.credentials?.writeFormat).toBe('legacy');

      /** The override reaches the merged config after an async cache invalidation. */
      await expect
        .poll(
          async () => {
            await installPluginAuth(request, token, MCP_PLUGIN_KEY, { [MCP_VAR]: MCP_TOKEN });
            const [stored] = await readStoredAuths(login.userId, MCP_PLUGIN_KEY);
            return LEGACY_FORMAT.test(stored?.value ?? '') ? 'legacy' : stored?.value;
          },
          { timeout: 30000, intervals: [500, 1000, 2000] },
        )
        .toBe('legacy');

      const stored = await readStoredAuths(userId, MCP_PLUGIN_KEY);
      expect(stored).toHaveLength(1);
      expect(stored[0].value).not.toContain(MCP_TOKEN);
      expect(await mcpVarIsSet(request, token)).toBe(true);
      await expectMcpConnects(request, token);

      /** The user provider key route reads the same override. */
      const keyName = `e2e-legacy-key-${randomUUID()}`;
      const keyPut = await request.put('/api/keys', {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: keyName, value: 'e2e-provider-key' },
      });
      expect(keyPut.status()).toBe(201);
      const keyValue = await withMongo(async (db) => {
        const doc = await db
          .collection('keys')
          .findOne({ userId: new ObjectId(userId), name: keyName });
        return (doc as { value?: string } | null)?.value ?? '';
      });
      expect(keyValue).toMatch(LEGACY_FORMAT);
    } finally {
      if (userId) {
        const del = await request.delete(`/api/admin/config/user/${userId}`, {
          headers: adminHeaders,
        });
        expect([200, 204, 404]).toContain(del.status());
      }
      await cleanupCredentials(user);
    }
  });
});
