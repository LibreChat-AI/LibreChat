import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { deleteConversations, deleteMessagesByConversation, withMongo } from '../db';
import { getAccessToken, NEW_CHAT_PATH } from '../helpers';
import { getE2EUser } from '../../../setup/user';

type ListResponse = { conversations: { conversationId: string; isShared?: boolean }[] };
type SeedRow = {
  conversationId: string;
  createdAt?: Date;
  updatedAt?: Date;
  endpoint?: string;
  files?: string[];
};

const userEmail = getE2EUser().email;
const DAY = 24 * 60 * 60 * 1000;
const createdConversationIds: string[] = [];

/* Every spec in the run shares this user, so each test lists through its own endpoint name:
 * the rows it seeded are then the only rows the facet can return, and the assertions can be
 * exact instead of "contains". */
const uniqueEndpoint = () => `e2e-filter-${randomUUID().slice(0, 8)}`;

async function userId(): Promise<string> {
  const user = await withMongo((db) => db.collection('users').findOne({ email: userEmail }));
  if (!user) throw new Error(`E2E seed: user "${userEmail}" not found`);
  return user._id.toString();
}

async function seedRows(endpoint: string, rows: SeedRow[]): Promise<void> {
  const user = await userId();
  createdConversationIds.push(...rows.map((row) => row.conversationId));
  await withMongo((db) =>
    db.collection('conversations').insertMany(
      rows.map((row) => ({
        conversationId: row.conversationId,
        title: `Filter ${row.conversationId.slice(0, 8)}`,
        user,
        endpoint: row.endpoint ?? endpoint,
        isArchived: false,
        ...(row.files ? { files: row.files } : {}),
        createdAt: row.createdAt ?? new Date(),
        updatedAt: row.updatedAt ?? new Date(),
        __v: 0,
      })),
    ),
  );
}

async function seedUserMessageWithFile(conversationId: string): Promise<void> {
  const user = await userId();
  await withMongo((db) =>
    db.collection('messages').insertOne({
      messageId: randomUUID(),
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      conversationId,
      user,
      text: 'See attached',
      isCreatedByUser: true,
      sender: 'User',
      endpoint: 'openAI',
      error: false,
      unfinished: false,
      files: [{ file_id: randomUUID(), filename: 'notes.txt', type: 'text/plain' }],
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    }),
  );
}

async function seedAssistantMessage(
  conversationId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const user = await userId();
  await withMongo((db) =>
    db.collection('messages').insertOne({
      messageId: randomUUID(),
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      conversationId,
      user,
      isCreatedByUser: false,
      sender: 'Assistant',
      endpoint: 'openAI',
      error: false,
      unfinished: false,
      content: [{ type: 'text', text: 'Working on it' }],
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
      ...fields,
    }),
  );
}

async function seedShare(conversationId: string, expiredAt: Date | null): Promise<void> {
  const user = await userId();
  await withMongo((db) =>
    db.collection('sharedlinks').insertOne({
      conversationId,
      user,
      shareId: randomUUID(),
      title: 'Shared',
      messages: [],
      isPublic: true,
      expiredAt,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0,
    }),
  );
}

async function list(page: Page, query: string): Promise<{ status: number; body: unknown }> {
  const token = await getAccessToken(page);
  const response = await page.request.get(`/api/convos?${query}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

async function listIds(page: Page, query: string): Promise<string[]> {
  const { status, body } = await list(page, query);
  expect(status).toBe(200);
  return (body as ListResponse).conversations.map((convo) => convo.conversationId).sort();
}

test.beforeEach(async ({ page }) => {
  await page.goto(NEW_CHAT_PATH);
});

test.afterEach(async () => {
  const ids = createdConversationIds.splice(0, createdConversationIds.length);
  if (ids.length === 0) {
    return;
  }
  await withMongo((db) =>
    db.collection('sharedlinks').deleteMany({ conversationId: { $in: ids } }),
  );
  await deleteMessagesByConversation(ids);
  await deleteConversations(ids);
});

test('a date cutoff lists only conversations active since it @scenario:list-date-cutoff-excludes-older', async ({
  page,
}) => {
  const endpoint = uniqueEndpoint();
  const recent = randomUUID();
  const stale = randomUUID();
  const oldButCreatedRecently = randomUUID();
  const now = Date.now();
  await seedRows(endpoint, [
    { conversationId: recent, createdAt: new Date(now - DAY), updatedAt: new Date(now - DAY) },
    {
      conversationId: stale,
      createdAt: new Date(now - 30 * DAY),
      updatedAt: new Date(now - 30 * DAY),
    },
    {
      conversationId: oldButCreatedRecently,
      createdAt: new Date(now - 30 * DAY),
      updatedAt: new Date(now - DAY),
    },
  ]);
  const cutoff = encodeURIComponent(new Date(now - 7 * DAY).toISOString());

  expect(await listIds(page, `endpoints=${endpoint}&updatedAfter=${cutoff}`)).toEqual(
    [recent, oldButCreatedRecently].sort(),
  );
  expect(await listIds(page, `endpoints=${endpoint}&createdAfter=${cutoff}`)).toEqual([recent]);
});

test('an endpoint facet lists only conversations that ran on the named endpoints @scenario:list-endpoint-facet-matches-any', async ({
  page,
}) => {
  const first = uniqueEndpoint();
  const second = uniqueEndpoint();
  const other = uniqueEndpoint();
  const onFirst = randomUUID();
  const onSecond = randomUUID();
  const onOther = randomUUID();
  await seedRows(first, [
    { conversationId: onFirst },
    { conversationId: onSecond, endpoint: second },
    { conversationId: onOther, endpoint: other },
  ]);

  expect(await listIds(page, `endpoints=${first}`)).toEqual([onFirst]);
  expect(await listIds(page, `endpoints=${first}&endpoints=${second}`)).toEqual(
    [onFirst, onSecond].sort(),
  );
});

test('the attachment facet finds a chat whose only file rides on a message @scenario:list-files-facet-reads-message-attachments', async ({
  page,
}) => {
  const endpoint = uniqueEndpoint();
  const uploadedInChat = randomUUID();
  const steeredWithFile = randomUUID();
  const nativeImage = randomUUID();
  const toolOutput = randomUUID();
  const downloadOnly = randomUUID();
  const importedWithFiles = randomUUID();
  const emptiedFiles = randomUUID();
  const plain = randomUUID();
  await seedRows(endpoint, [
    { conversationId: uploadedInChat },
    { conversationId: steeredWithFile },
    { conversationId: nativeImage },
    { conversationId: toolOutput },
    { conversationId: downloadOnly },
    { conversationId: importedWithFiles, files: [randomUUID()] },
    { conversationId: emptiedFiles, files: [] },
    { conversationId: plain },
  ]);
  await seedUserMessageWithFile(uploadedInChat);
  await seedAssistantMessage(steeredWithFile, {
    content: [
      {
        type: 'steer',
        steer: 'Use this file too',
        steerId: randomUUID(),
        files: [{ file_id: randomUUID(), filename: 'extra.txt', type: 'text/plain' }],
      },
    ],
  });
  await seedAssistantMessage(nativeImage, {
    content: [{ type: 'image_file', image_file: { file_id: randomUUID() } }],
  });
  await seedAssistantMessage(toolOutput, {
    attachments: [{ file_id: randomUUID(), filename: 'plot.png', toolCallId: randomUUID() }],
  });
  await seedAssistantMessage(downloadOnly, {
    attachments: [{ filename: 'report.csv', filepath: '/api/files/code/download/s/report.csv' }],
  });

  expect(await listIds(page, `endpoints=${endpoint}&hasFiles=true`)).toEqual(
    [
      uploadedInChat,
      steeredWithFile,
      nativeImage,
      toolOutput,
      downloadOnly,
      importedWithFiles,
    ].sort(),
  );
  expect(await listIds(page, `endpoints=${endpoint}&hasFiles=false`)).toHaveLength(8);
});

test('the shared facet follows live links and drops expired ones @scenario:list-shared-facet-follows-live-links', async ({
  page,
}) => {
  const endpoint = uniqueEndpoint();
  const live = randomUUID();
  const expiring = randomUUID();
  const lapsed = randomUUID();
  const unshared = randomUUID();
  await seedRows(endpoint, [
    { conversationId: live },
    { conversationId: expiring },
    { conversationId: lapsed },
    { conversationId: unshared },
  ]);
  await seedShare(live, null);
  await seedShare(expiring, new Date(Date.now() + DAY));
  await seedShare(lapsed, new Date(Date.now() - DAY));

  const { status, body } = await list(page, `endpoints=${endpoint}&sharedOnly=true`);
  expect(status).toBe(200);
  const rows = (body as ListResponse).conversations;
  expect(rows.map((row) => row.conversationId).sort()).toEqual([live, expiring].sort());
  expect(rows.every((row) => row.isShared === true)).toBe(true);
});

test('a malformed facet is refused instead of listing unfiltered @scenario:list-malformed-facet-refused', async ({
  page,
}) => {
  for (const query of [
    'updatedAfter=2026-02-30',
    'createdAfter=last%20tuesday',
    'hasFiles=tru',
    'sharedOnly=yes',
    `endpoints=${'x'.repeat(129)}`,
  ]) {
    const { status, body } = await list(page, query);
    expect(status, query).toBe(400);
    expect((body as { error?: string }).error, query).toEqual(expect.any(String));
    expect((body as { conversations?: unknown }).conversations, query).toBeUndefined();
  }
});

test('a list request without facets still returns every visible conversation @scenario:list-without-facets-unchanged', async ({
  page,
}) => {
  const endpoint = uniqueEndpoint();
  const plain = randomUUID();
  const withFiles = randomUUID();
  await seedRows(endpoint, [
    { conversationId: plain },
    { conversationId: withFiles, files: [randomUUID()] },
  ]);

  const { status, body } = await list(page, 'limit=100');
  expect(status).toBe(200);
  const ids = (body as ListResponse).conversations.map((convo) => convo.conversationId);
  expect(ids).toEqual(expect.arrayContaining([plain, withFiles]));
});
