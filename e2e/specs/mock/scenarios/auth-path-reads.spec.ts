import { ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { withMongo, deleteUserByEmail } from '../db';

const PASSWORD = 'Auth-Path-Reads-1!';

type Account = { email: string; id: string; headers: Record<string, string> };

async function signUp(request: APIRequestContext, label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.com`;
  const register = await request.post('/api/auth/register', {
    data: { email, name: label, password: PASSWORD, confirm_password: PASSWORD },
  });
  expect(register.ok()).toBeTruthy();
  const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token, user } = (await login.json()) as { token: string; user: { _id: string } };
  return { email, id: user._id, headers: { Authorization: `Bearer ${token}` } };
}

/** An agent authored by `author` with `fileId` attached to its file search resources. */
async function seedAgentWithFile(author: string, fileId: string): Promise<ObjectId> {
  const _id = new ObjectId();
  await withMongo((db) =>
    db.collection('agents').insertOne({
      _id,
      id: `agent_${randomUUID().replace(/-/g, '').slice(0, 21)}`,
      name: 'File access agent',
      provider: 'Mock Provider A',
      model: 'mock-model-a',
      author: new ObjectId(author),
      tools: [],
      tool_resources: { file_search: { file_ids: [fileId] } },
      versions: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
  return _id;
}

async function grantAgentView(userId: string, agentId: ObjectId, grantedBy: string) {
  await withMongo((db) =>
    db.collection('aclentries').insertOne({
      principalType: 'user',
      principalId: new ObjectId(userId),
      principalModel: 'User',
      resourceType: 'agent',
      resourceId: agentId,
      permBits: 1,
      grantedBy: new ObjectId(grantedBy),
      grantedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
}

test.describe('auth path reads', () => {
  test('a file attached to an agent is readable through that agent and refused without it @scenario:agent-attached-file-follows-agent-access', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const emails: string[] = [];
    const fileId = randomUUID();
    const agentIds: ObjectId[] = [];
    try {
      const owner = await signUp(request, 'file-owner');
      const viewer = await signUp(request, 'agent-viewer');
      const author = await signUp(request, 'agent-author');
      const stranger = await signUp(request, 'stranger');
      emails.push(owner.email, viewer.email, author.email, stranger.email);

      await withMongo((db) =>
        db.collection('files').insertOne({
          file_id: fileId,
          user: new ObjectId(owner.id),
          filename: 'shared.txt',
          filepath: `/uploads/${fileId}.txt`,
          type: 'text/plain',
          bytes: 13,
          object: 'file',
          source: 'local',
          text: 'shared secret',
          textFormat: 'text',
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      /** Two agents carry the file: one shared with the viewer, one authored by the author. */
      const shared = await seedAgentWithFile(owner.id, fileId);
      agentIds.push(shared, await seedAgentWithFile(author.id, fileId));

      const preview = (account: Account) =>
        request.get(`/api/files/${fileId}/preview`, { headers: account.headers });

      expect((await preview(viewer)).status()).toBe(403);
      await grantAgentView(viewer.id, shared, owner.id);

      const viaShare = await preview(viewer);
      expect(viaShare.status()).toBe(200);
      expect(await viaShare.json()).toMatchObject({ file_id: fileId, status: 'ready' });
      expect((await preview(author)).status()).toBe(200);
      expect((await preview(stranger)).status()).toBe(403);
      expect((await preview(owner)).status()).toBe(200);
    } finally {
      await withMongo(async (db) => {
        await db.collection('files').deleteMany({ file_id: fileId });
        await db.collection('agents').deleteMany({ _id: { $in: agentIds } });
        await db.collection('aclentries').deleteMany({ resourceId: { $in: agentIds } });
      });
      for (const email of emails) {
        await deleteUserByEmail(email);
      }
      await request.dispose();
    }
  });

  test('a bearer token authenticates its user on every request of a burst @scenario:jwt-bearer-burst-serves-current-user', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    let email = '';
    try {
      const account = await signUp(request, 'jwt-burst');
      email = account.email;
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => request.get('/api/user', { headers: account.headers })),
      );
      for (const response of responses) {
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({ id: account.id, email });
      }
    } finally {
      if (email) {
        await deleteUserByEmail(email);
      }
      await request.dispose();
    }
  });

  for (const [path, tag] of [
    ['/api/agents/v1/chat/completions', '@scenario:remote-chat-completion-answers-with-skills-on'],
    ['/api/agents/v1/responses', '@scenario:remote-response-answers-with-skills-on'],
  ] as const) {
    test(`a remote agent call to ${path} answers while skills are enabled ${tag}`, async ({
      playwright,
      baseURL,
    }) => {
      const request = await playwright.request.newContext({ baseURL });
      let headers: Record<string, string> = {};
      let agentId = '';
      let keyId = '';
      try {
        const { email, password } = getE2EUser();
        const login = await request.post('/api/auth/login', { data: { email, password } });
        expect(login.ok()).toBeTruthy();
        headers = { Authorization: `Bearer ${((await login.json()) as { token: string }).token}` };
        const agent = await request.post('/api/agents', {
          headers,
          data: {
            name: `Remote skills ${randomUUID().slice(0, 8)}`,
            provider: 'Mock Provider A',
            model: 'mock-model-a',
            model_parameters: {},
            tools: [],
          },
        });
        expect(agent.status()).toBe(201);
        agentId = ((await agent.json()) as { id: string }).id;
        const created = await request.post('/api/api-keys', {
          headers,
          data: { name: 'remote skills' },
        });
        expect(created.status()).toBe(201);
        const apiKey = (await created.json()) as { id: string; key: string };
        keyId = apiKey.id;

        const isResponses = path.endsWith('/responses');
        const response = await request.post(path, {
          headers: { Authorization: `Bearer ${apiKey.key}` },
          data: isResponses
            ? { model: agentId, input: 'Say hello', stream: false }
            : { model: agentId, messages: [{ role: 'user', content: 'Say hello' }], stream: false },
          timeout: 60_000,
        });
        expect(response.status(), await response.text()).toBe(200);
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          output?: unknown[];
          status?: string;
        };
        if (isResponses) {
          expect(body.status).toBe('completed');
          expect(body.output?.length).toBeGreaterThan(0);
        } else {
          expect(body.choices?.[0]?.message?.content).toBeTruthy();
        }
      } finally {
        if (keyId) {
          await request.delete(`/api/api-keys/${keyId}`, { headers, failOnStatusCode: false });
        }
        if (agentId) {
          await request.delete(`/api/agents/${agentId}`, { headers, failOnStatusCode: false });
        }
        await request.dispose();
      }
    });
  }
});
