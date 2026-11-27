import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { ObjectId } from 'mongodb';
import type { Db, WithId, Document } from 'mongodb';
import cleanupUser from '../../setup/cleanupUser';
import { getPrimaryE2EUser, getSecondaryE2EUser } from '../../setup/users.mock';
import type { User } from '../../types';
import { openAgentBuilder } from './agents.helpers';
import { withMongo } from './db';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  getAccessToken,
  messagesView,
  sendMessage,
} from './helpers';

const OWNER_PERM_BITS = 1 | 2 | 4 | 8;

type UserDoc = WithId<Document> & {
  email: string;
  name?: string;
  tenantId?: string;
};

type AgentFile = {
  file_id: string;
  filename: string;
  text?: string;
};

type PreviewResponse = {
  file_id: string;
  status: string;
  text?: string;
  textFormat?: string | null;
};

async function registerUser(request: APIRequestContext, user: User) {
  await cleanupUser(user);

  const registerResponse = await request.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registerResponse.ok()).toBeTruthy();
}

async function getUserDoc(db: Db, email: string): Promise<UserDoc> {
  const user = await db.collection<UserDoc>('users').findOne({ email });
  if (!user) {
    throw new Error(`Expected e2e user ${email} to exist`);
  }
  return user;
}

function makeReadyTextFile({
  fileId,
  filename,
  ownerId,
  text,
  tenantId,
  embedded = false,
}: {
  fileId: string;
  filename: string;
  ownerId: ObjectId;
  text: string;
  tenantId?: string;
  embedded?: boolean;
}) {
  const now = new Date();
  return {
    user: ownerId,
    file_id: fileId,
    bytes: Buffer.byteLength(text),
    filename,
    filepath: `/tmp/${fileId}.txt`,
    object: 'file',
    embedded,
    type: 'text/plain',
    text,
    textFormat: 'text',
    status: 'ready',
    usage: 0,
    source: 'local',
    ...(tenantId ? { tenantId } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

async function seedAgentWithCrossOwnerFiles({
  agentId,
  agentObjectId,
  agentName,
  primaryUser,
  secondaryUser,
  contextFileId,
  contextFilename,
  contextText,
  searchFileId,
  searchFilename,
  searchText,
}: {
  agentId: string;
  agentObjectId: ObjectId;
  agentName: string;
  primaryUser: UserDoc;
  secondaryUser: UserDoc;
  contextFileId: string;
  contextFilename: string;
  contextText: string;
  searchFileId: string;
  searchFilename: string;
  searchText: string;
}) {
  const now = new Date();
  const tenantId = primaryUser.tenantId;
  const toolResources = {
    context: { file_ids: [contextFileId] },
    file_search: { file_ids: [searchFileId] },
  };

  await withMongo(async (db) => {
    await db.collection('files').insertMany([
      makeReadyTextFile({
        fileId: contextFileId,
        filename: contextFilename,
        ownerId: secondaryUser._id,
        text: contextText,
        tenantId,
      }),
      makeReadyTextFile({
        fileId: searchFileId,
        filename: searchFilename,
        ownerId: secondaryUser._id,
        text: searchText,
        tenantId,
        embedded: true,
      }),
    ]);

    await db.collection('agents').insertOne({
      _id: agentObjectId,
      id: agentId,
      name: agentName,
      description: 'E2E agent with files owned by a different editor.',
      instructions: 'Use the attached context file for provider-file e2e assertions.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      author: primaryUser._id,
      authorName: primaryUser.name,
      tools: ['file_search', 'context'],
      category: 'general',
      tool_resources: toolResources,
      versions: [
        {
          id: agentId,
          name: agentName,
          description: 'E2E agent with files owned by a different editor.',
          instructions: 'Use the attached context file for provider-file e2e assertions.',
          provider: MOCK_ENDPOINTS[0].label,
          model: MOCK_ENDPOINTS[0].model,
          tools: ['file_search', 'context'],
          category: 'general',
          tool_resources: toolResources,
          createdAt: now,
          updatedAt: now,
        },
      ],
      ...(tenantId ? { tenantId } : {}),
      createdAt: now,
      updatedAt: now,
    });

    await db.collection('aclentries').insertMany([
      {
        principalType: 'user',
        principalId: primaryUser._id,
        principalModel: 'User',
        resourceType: 'agent',
        resourceId: agentObjectId,
        permBits: OWNER_PERM_BITS,
        grantedBy: primaryUser._id,
        grantedAt: now,
        ...(tenantId ? { tenantId } : {}),
        createdAt: now,
        updatedAt: now,
      },
      {
        principalType: 'user',
        principalId: primaryUser._id,
        principalModel: 'User',
        resourceType: 'remoteAgent',
        resourceId: agentObjectId,
        permBits: OWNER_PERM_BITS,
        grantedBy: primaryUser._id,
        grantedAt: now,
        ...(tenantId ? { tenantId } : {}),
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });
}

async function cleanupSeededRecords({
  agentObjectId,
  agentId,
  fileIds,
  conversationId,
}: {
  agentObjectId: ObjectId;
  agentId: string;
  fileIds: string[];
  conversationId?: string;
}) {
  await withMongo(async (db) => {
    await db.collection('agents').deleteMany({ $or: [{ _id: agentObjectId }, { id: agentId }] });
    await db.collection('files').deleteMany({ file_id: { $in: fileIds } });
    await db.collection('aclentries').deleteMany({ resourceId: agentObjectId });

    if (conversationId) {
      await db.collection('conversations').deleteMany({ conversationId });
      await db.collection('messages').deleteMany({ conversationId });
    }
  });
}

test.describe('agent file ownership', () => {
  test('allows an agent author to list, preview, and use attached files owned by another user', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);

    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const primary = getPrimaryE2EUser();
    const secondary = getSecondaryE2EUser();
    const agentObjectId = new ObjectId();
    const agentId = `agent_e2e_cross_owner_${suffix}`;
    const agentName = `E2E Cross Owner Files ${suffix}`;
    const contextFileId = `file_e2e_context_${suffix}`;
    const contextFilename = `agent-context-${suffix}.txt`;
    const contextMarker = `cross_owner_context_${suffix.replace(/-/g, '_')}`;
    const contextText = `Context file owned by the secondary user for ${suffix}. ${contextMarker}`;
    const searchFileId = `file_e2e_search_${suffix}`;
    const searchFilename = `agent-search-${suffix}.txt`;
    const searchText = `Search file owned by the secondary user for ${suffix}.`;
    let conversationId: string | undefined;

    try {
      await registerUser(request, secondary);

      const { primaryUser, secondaryUser } = await withMongo(async (db) => ({
        primaryUser: await getUserDoc(db, primary.email),
        secondaryUser: await getUserDoc(db, secondary.email),
      }));

      await seedAgentWithCrossOwnerFiles({
        agentId,
        agentObjectId,
        agentName,
        primaryUser,
        secondaryUser,
        contextFileId,
        contextFilename,
        contextText,
        searchFileId,
        searchFilename,
        searchText,
      });

      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const token = await getAccessToken(page);

      const agentFiles = await fetchJson<AgentFile[]>(
        page,
        `/api/files/agent/${encodeURIComponent(agentId)}`,
        token,
      );
      expect(agentFiles.map((file) => file.file_id).sort()).toEqual(
        [contextFileId, searchFileId].sort(),
      );
      expect(agentFiles.find((file) => file.file_id === contextFileId)?.text).toBeUndefined();

      await expect
        .poll(
          async () =>
            fetchJson<PreviewResponse>(
              page,
              `/api/files/${encodeURIComponent(contextFileId)}/preview`,
              token,
            ),
          { timeout: 10000 },
        )
        .toMatchObject({
          file_id: contextFileId,
          status: 'ready',
          text: contextText,
          textFormat: 'text',
        });

      await expect
        .poll(
          async () =>
            fetchJson<PreviewResponse>(
              page,
              `/api/files/${encodeURIComponent(searchFileId)}/preview`,
              token,
            ),
          { timeout: 10000 },
        )
        .toMatchObject({
          file_id: searchFileId,
          status: 'ready',
          text: searchText,
          textFormat: 'text',
        });

      const form = await openAgentBuilder(page);
      await form.getByRole('combobox', { name: 'Agent', exact: true }).click();
      await page.getByRole('option', { name: agentName }).click();
      await form.getByRole('button', { name: 'Select Agent' }).click();

      const response = await sendMessage(page, `E2E_ASSERT_AGENT_CONTEXT:${contextMarker}`);
      expect(response.ok()).toBeTruthy();
      await expect(
        messagesView(page).getByText(`E2E agent context assertion passed: ${contextMarker}`),
      ).toBeVisible({ timeout: 30000 });

      const match = page.url().match(/\/c\/([0-9a-fA-F-]{36})$/);
      conversationId = match?.[1];
    } finally {
      await cleanupSeededRecords({
        agentObjectId,
        agentId,
        fileIds: [contextFileId, searchFileId],
        conversationId,
      });
      await cleanupUser(secondary);
    }
  });
});
