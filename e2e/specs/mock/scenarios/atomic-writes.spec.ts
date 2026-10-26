import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { withMongo } from '../db';

const PASSWORD = 'Atomic-Writes-1!';

type Session = { headers: Record<string, string>; userId: string };

async function signUp(request: APIRequestContext): Promise<Session> {
  const email = `atomic-${randomUUID().slice(0, 8)}@example.com`;
  const register = await request.post('/api/auth/register', {
    data: { email, name: 'Atomic Writes', password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token, user } = (await login.json()) as {
    token: string;
    user: { id?: string; _id?: string };
  };
  const userId = user.id ?? user._id;
  expect(userId).toBeTruthy();
  return { headers: { Authorization: `Bearer ${token}` }, userId: String(userId) };
}

async function getPlugins(request: APIRequestContext, session: Session): Promise<string[]> {
  const response = await request.get('/api/user', { headers: session.headers });
  expect(response.ok()).toBeTruthy();
  const { plugins } = (await response.json()) as { plugins?: string[] };
  return plugins ?? [];
}

test.describe('atomic user-owned writes', () => {
  test('concurrent tool installs all persist and an uninstall removes only its tool @scenario:plugin-installs-concurrent-persist', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);
      const keys = ['calculator', 'web_search', 'dalle', 'wolfram', 'google'];

      const installs = await Promise.all(
        keys.map((pluginKey) =>
          request.post('/api/user/plugins', {
            headers: session.headers,
            data: { pluginKey, action: 'install' },
          }),
        ),
      );
      installs.forEach((response) => expect(response.status()).toBe(200));
      expect((await getPlugins(request, session)).sort()).toEqual([...keys].sort());

      const reinstall = await request.post('/api/user/plugins', {
        headers: session.headers,
        data: { pluginKey: 'calculator', action: 'install' },
      });
      expect(reinstall.status()).toBe(200);
      expect(
        (await getPlugins(request, session)).filter((key) => key === 'calculator'),
      ).toHaveLength(1);

      const uninstall = await request.post('/api/user/plugins', {
        headers: session.headers,
        data: { pluginKey: 'dalle', action: 'uninstall' },
      });
      expect(uninstall.status()).toBe(200);
      expect((await getPlugins(request, session)).sort()).toEqual(
        keys.filter((key) => key !== 'dalle').sort(),
      );
    } finally {
      await request.dispose();
    }
  });

  test('saving a tool credential again replaces it instead of adding a second record @scenario:plugin-credential-resave-single-record', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);
      const pluginKey = 'wolfram';
      const authField = 'WOLFRAM_APP_ID';

      const readRecords = () =>
        withMongo((db) =>
          db
            .collection('pluginauths')
            .find({ userId: session.userId, pluginKey, authField })
            .toArray(),
        );

      const first = await request.post('/api/user/plugins', {
        headers: session.headers,
        data: { pluginKey, action: 'install', auth: { [authField]: 'first-app-id' } },
      });
      expect(first.status()).toBe(200);
      const created = await readRecords();
      expect(created).toHaveLength(1);
      expect(created[0].createdAt).toBeTruthy();

      const second = await request.post('/api/user/plugins', {
        headers: session.headers,
        data: { pluginKey, action: 'install', auth: { [authField]: 'second-app-id' } },
      });
      expect(second.status()).toBe(200);
      const replaced = await readRecords();
      expect(replaced).toHaveLength(1);
      expect(String(replaced[0]._id)).toBe(String(created[0]._id));
      expect(replaced[0].value).not.toBe(created[0].value);
    } finally {
      await request.dispose();
    }
  });

  test('creating a memory with a key that already exists is refused and keeps the original @scenario:memory-duplicate-key-conflict', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);

      const created = await request.post('/api/memories', {
        headers: session.headers,
        data: { key: 'favorite_color', value: 'blue' },
      });
      expect(created.status()).toBe(201);
      const { memory } = (await created.json()) as { memory: { key: string; value: string } };
      expect(memory).toMatchObject({ key: 'favorite_color', value: 'blue' });

      const duplicate = await request.post('/api/memories', {
        headers: session.headers,
        data: { key: 'favorite_color', value: 'red' },
      });
      expect(duplicate.status()).toBe(409);
      expect(await duplicate.json()).toEqual({ error: 'Memory with this key already exists.' });

      const list = await request.get('/api/memories', { headers: session.headers });
      expect(list.ok()).toBeTruthy();
      const { memories } = (await list.json()) as {
        memories: Array<{ key: string; value: string }>;
      };
      const matching = memories.filter((entry) => entry.key === 'favorite_color');
      expect(matching).toHaveLength(1);
      expect(matching[0].value).toBe('blue');
    } finally {
      await request.dispose();
    }
  });

  test('turning memories off and on is reflected in the user profile @scenario:memory-preferences-toggle', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);

      for (const enabled of [false, true]) {
        const response = await request.patch('/api/memories/preferences', {
          headers: session.headers,
          data: { memories: enabled },
        });
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({
          updated: true,
          preferences: { memories: enabled },
        });
        const user = await request.get('/api/user', { headers: session.headers });
        const { personalization } = (await user.json()) as {
          personalization?: { memories?: boolean };
        };
        expect(personalization?.memories).toBe(enabled);
      }
    } finally {
      await request.dispose();
    }
  });

  test('marking a preset as default leaves it the only default @scenario:preset-default-single', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const session = await signUp(request);
      const savePreset = async (presetId: string, title: string) => {
        const response = await request.post('/api/presets', {
          headers: session.headers,
          data: { presetId, title, endpoint: 'openAI', model: 'gpt-4o', defaultPreset: true },
        });
        expect(response.status()).toBe(201);
      };
      const defaults = async () => {
        const response = await request.get('/api/presets', { headers: session.headers });
        expect(response.ok()).toBeTruthy();
        const presets = (await response.json()) as Array<{
          presetId: string;
          defaultPreset?: boolean;
        }>;
        return presets.filter((preset) => preset.defaultPreset).map((preset) => preset.presetId);
      };

      const first = randomUUID();
      const second = randomUUID();
      await savePreset(first, 'First default');
      expect(await defaults()).toEqual([first]);

      await savePreset(second, 'Second default');
      expect(await defaults()).toEqual([second]);

      await savePreset(second, 'Second default renamed');
      expect(await defaults()).toEqual([second]);
    } finally {
      await request.dispose();
    }
  });
});
