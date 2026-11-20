import { ObjectId } from 'mongodb';
import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { withMongo } from '../db';

const PASSWORD = 'Deletion-Scenario-1!';

async function signUp(request: APIRequestContext) {
  const email = `deletion-${randomUUID().slice(0, 8)}@example.com`;
  const register = await request.post('/api/auth/register', {
    data: {
      email,
      name: 'Deletion Scenario',
      password: PASSWORD,
      confirm_password: PASSWORD,
    },
  });
  expect(register.ok()).toBeTruthy();
  const login = await request.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(login.ok()).toBeTruthy();
  const { token } = (await login.json()) as { token: string };
  return { email, headers: { Authorization: `Bearer ${token}` } };
}

test.describe('account deletion', () => {
  test('a user who deletes their account is signed out and cannot sign back in @scenario:account-deletion-succeeds', async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    try {
      const { email, headers } = await signUp(request);

      const deletion = await request.delete('/api/user/delete', { headers });
      expect(deletion.status()).toBe(200);
      expect(await deletion.json()).toEqual({ message: 'User deleted' });

      expect((await request.get('/api/user', { headers })).status()).toBe(401);
      const relogin = await request.post('/api/auth/login', {
        data: { email, password: PASSWORD },
      });
      expect(relogin.ok()).toBeFalsy();
    } finally {
      await request.dispose();
    }
  });

  test("deleting an account keeps the agent references of another owner's file with the same id @scenario:account-deletion-keeps-shared-file-agent-references", async ({
    playwright,
    baseURL,
  }) => {
    const request = await playwright.request.newContext({ baseURL });
    const fileId = randomUUID();
    const agentId = `agent_${randomUUID()}`;
    const otherOwner = new ObjectId();
    try {
      const { email, headers } = await signUp(request);
      await withMongo(async (db) => {
        const user = await db.collection('users').findOne({ email });
        if (!user) {
          throw new Error(`seed: user ${email} not found`);
        }
        const record = (owner: ObjectId) => ({
          user: owner,
          file_id: fileId,
          filename: 'shared.txt',
          filepath: `/uploads/${owner.toString()}/shared.txt`,
          source: 'text',
          type: 'text/plain',
          bytes: 1,
          object: 'file',
          usage: 0,
        });
        await db.collection('files').insertMany([record(user._id), record(otherOwner)]);
        await db.collection('agents').insertOne({
          id: agentId,
          name: 'Shared file agent',
          provider: 'openAI',
          model: 'gpt-4o',
          author: otherOwner,
          tool_resources: { file_search: { file_ids: [fileId] } },
        });
      });

      const deletion = await request.delete('/api/user/delete', { headers });
      expect(deletion.status()).toBe(200);

      await withMongo(async (db) => {
        expect(await db.collection('files').countDocuments({ file_id: fileId })).toBe(1);
        expect(await db.collection('files').countDocuments({ user: otherOwner })).toBe(1);
        const agent = await db.collection('agents').findOne({ id: agentId });
        expect(agent?.tool_resources?.file_search?.file_ids).toEqual([fileId]);
      });
    } finally {
      await withMongo(async (db) => {
        await db.collection('files').deleteMany({ file_id: fileId });
        await db.collection('agents').deleteMany({ id: agentId });
      });
      await request.dispose();
    }
  });
});
