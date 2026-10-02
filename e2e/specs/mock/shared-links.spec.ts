import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MongoClient } from 'mongodb';
import type { Collection, ObjectId } from 'mongodb';
import { applyRuntimeEnv } from '../../setup/runtimeEnv';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  mockReply,
  selectMockEndpoint,
  sendMessage,
} from './helpers';

type SharedLinkDoc = {
  _id?: ObjectId;
  conversationId: string;
  title?: string;
  user?: string;
  messages?: ObjectId[];
  shareId: string;
  isPublic?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type StoredSharedLinkDoc = SharedLinkDoc & {
  _id: ObjectId;
  messages: ObjectId[];
};

type AclEntryDoc = {
  _id: ObjectId;
  principalType: string;
  resourceType: string;
  resourceId: ObjectId;
};

type UploadFixture = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

type PublicSharedFile = {
  file_id?: string;
  filename?: string;
  filepath?: string;
};

type PublicSharedPayload = {
  messages?: Array<{
    files?: PublicSharedFile[];
    attachments?: PublicSharedFile[];
  }>;
};

const randomSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

async function uploadProviderFile(page: Page, fixture: UploadFixture) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  const uploadOption = page.getByRole('button', { name: 'Upload to Provider', exact: true });
  await expect(uploadOption).toBeVisible();

  const fileChooserPromise = page.waitForEvent('filechooser');
  await uploadOption.click();
  const fileChooser = await fileChooserPromise;
  expect(await fileChooser.element().getAttribute('type')).toBe('file');

  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      response.url().includes('/api/files') &&
      response.status() === 200,
    { timeout: 30000 },
  );
  await fileChooser.setFiles(fixture);
  const uploadResponse = await uploadResponsePromise;
  expect(uploadResponse.ok()).toBeTruthy();
}

async function openPublicSharedLink(
  page: Page,
  pathname: string,
  shareId: string,
): Promise<PublicSharedPayload> {
  const payloadResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === `/api/share/${shareId}` &&
      response.status() === 200,
    { timeout: 30000 },
  );
  await page.goto(pathname, { timeout: 10000 });
  const payloadResponse = await payloadResponsePromise;
  expect(payloadResponse.ok()).toBeTruthy();
  return (await payloadResponse.json()) as PublicSharedPayload;
}

async function connectToE2EDb() {
  applyRuntimeEnv();
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI must be available for shared-links mock e2e tests');
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  return { client, db: client.db() };
}

async function waitForSharedLink(
  sharedLinks: Collection<SharedLinkDoc>,
  shareId: string,
): Promise<StoredSharedLinkDoc> {
  const deadline = Date.now() + 15000;

  while (Date.now() < deadline) {
    const share = await sharedLinks.findOne({ shareId });
    if (share?._id && Array.isArray(share.messages) && share.messages.length > 0) {
      return share as StoredSharedLinkDoc;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for persisted shared link ${shareId}`);
}

test.describe('shared links', () => {
  test('manages a shared-link snapshot and preserves legacy public links through runtime migration', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120000);

    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for shared-link mock e2e tests');
    }

    const suffix = randomSuffix();
    const userMessage = `Shared link e2e ${suffix}`;
    const updatedMessage = `Updated shared link e2e ${suffix}`;
    const fileFixture: UploadFixture = {
      name: `shared-link-${suffix}.txt`,
      mimeType: 'text/plain',
      buffer: Buffer.from(`Shared link file fixture ${suffix}\n`),
    };

    await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await uploadProviderFile(page, fileFixture);
    await expect(page.getByRole('button', { name: fileFixture.name, exact: true })).toBeVisible();

    const response = await sendMessage(page, userMessage);
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText(userMessage, { exact: true })).toBeVisible();
    await expect(mockReply(page)).toBeVisible();
    await expect(
      page.getByTestId('messages-view').getByRole('button', {
        name: fileFixture.name,
        exact: true,
      }),
    ).toBeVisible();

    await expect(page).toHaveURL(/\/c\/(?!new)[0-9a-fA-F-]{36}$/);
    const conversationUrl = new URL(page.url());
    const conversationId = conversationUrl.pathname.split('/').pop();
    if (!conversationId) {
      throw new Error(`Could not parse conversation id from ${conversationUrl.href}`);
    }

    await page.getByRole('button', { name: 'Export/Share' }).click();
    await page.getByTestId('share-conversation-menu-item').click();
    const shareDialog = page.getByRole('dialog', { name: 'Share link to chat' });
    await expect(shareDialog).toBeVisible();
    const shareFilesSwitch = shareDialog.getByRole('switch', {
      name: 'Share files in this conversation',
    });
    await expect(shareFilesSwitch).toBeChecked();
    await shareFilesSwitch.click();
    await expect(shareFilesSwitch).not.toBeChecked();

    const [shareResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          res.url().includes(`/api/share/${conversationId}`) &&
          res.status() === 200,
        { timeout: 30000 },
      ),
      page.getByRole('button', { name: 'Create a shared link' }).click(),
    ]);
    expect(shareResponse.ok()).toBeTruthy();
    const createBody = shareResponse.request().postDataJSON() as { snapshotFiles?: boolean };
    expect(createBody.snapshotFiles).toBe(false);
    const sharePayload = (await shareResponse.json()) as { shareId?: string };
    if (!sharePayload.shareId) {
      throw new Error('Expected create-share response to include a shareId');
    }

    /** The share URL is rendered into a read-only <input>, so assert on its value. */
    const sharedLinkInput = page.getByTestId('shared-link-url');
    await expect(sharedLinkInput).toHaveValue(/\/share\//);
    await expect(page.getByRole('button', { name: 'Manage Access' })).toBeVisible();
    const sharedLinkUrl = (await sharedLinkInput.inputValue()).trim();
    if (!sharedLinkUrl) {
      throw new Error('Expected shared-link URL to be rendered after creating a link');
    }

    /** The header trigger flips to the "link active" label once a share exists. */
    await expect(page.getByTestId('header-shared-link-indicator')).toBeVisible();

    const publicSharePath = new URL(sharedLinkUrl, baseURL).pathname;
    const optedOutPayload = await openPublicSharedLink(page, publicSharePath, sharePayload.shareId);
    await expect(page).toHaveURL(/\/share\/.+/);
    await expect(
      page.getByTestId('messages-view').getByText(userMessage, { exact: true }),
    ).toBeVisible();
    await expect(mockReply(page)).toHaveCount(1);
    const optedOutFiles = (optedOutPayload.messages ?? []).flatMap((message) => [
      ...(message.files ?? []),
      ...(message.attachments ?? []),
    ]);
    expect(optedOutFiles).toHaveLength(0);
    await expect(
      page.getByTestId('messages-view').getByRole('button', {
        name: fileFixture.name,
        exact: true,
      }),
    ).toHaveCount(0);

    await page.goto(conversationUrl.pathname, { timeout: 10000 });
    const updateResponse = await sendMessage(page, updatedMessage);
    expect(updateResponse.ok()).toBeTruthy();
    await expect(page.getByText(updatedMessage)).toBeVisible();

    /** A shared link remains a snapshot until its owner explicitly updates it. */
    await page.goto(publicSharePath, { timeout: 10000 });
    await expect(page.getByTestId('messages-view').getByText(updatedMessage)).toHaveCount(0);
    await expect(mockReply(page)).toHaveCount(1);

    await page.goto(conversationUrl.pathname, { timeout: 10000 });
    await page.getByRole('button', { name: 'Export/Share' }).click();
    await page.getByTestId('share-conversation-menu-item').click();
    await expect(shareDialog).toBeVisible();
    await expect(shareFilesSwitch).not.toBeChecked();
    await shareFilesSwitch.click();
    await expect(shareFilesSwitch).toBeChecked();
    await shareDialog.getByRole('button', { name: 'Update link', exact: true }).click();

    const updateDialog = page.getByRole('dialog', { name: 'Update shared link?' });
    await expect(updateDialog).toBeVisible();
    await expect(
      updateDialog.getByText(/This publishes the latest messages.+The URL stays the same/),
    ).toBeVisible();

    const [refreshResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'PATCH' &&
          res.url().includes(`/api/share/${sharePayload.shareId}`) &&
          res.status() === 200,
        { timeout: 30000 },
      ),
      updateDialog.getByRole('button', { name: 'Update link', exact: true }).click(),
    ]);
    expect(refreshResponse.ok()).toBeTruthy();
    const updateBody = refreshResponse.request().postDataJSON() as { snapshotFiles?: boolean };
    expect(updateBody.snapshotFiles).toBe(true);
    await expect(updateDialog).toBeHidden();
    await expect(sharedLinkInput).toHaveValue(sharedLinkUrl);

    const optedInPayload = await openPublicSharedLink(page, publicSharePath, sharePayload.shareId);
    await expect(page.getByTestId('messages-view').getByText(updatedMessage)).toBeVisible();
    await expect(mockReply(page)).toHaveCount(2);
    const sharedFiles = (optedInPayload.messages ?? []).flatMap((message) => [
      ...(message.files ?? []),
      ...(message.attachments ?? []),
    ]);
    const sharedFile = sharedFiles.find((file) => file.filename === fileFixture.name);
    expect(sharedFile).toBeDefined();
    if (!sharedFile?.file_id) {
      throw new Error(`Expected shared file ${fileFixture.name} to include a file_id`);
    }
    expect(sharedFile.filepath).toBe(
      `/api/share/${sharePayload.shareId}/files/${sharedFile.file_id}`,
    );
    await expect(
      page.getByTestId('messages-view').getByRole('button', {
        name: fileFixture.name,
        exact: true,
      }),
    ).toBeVisible();

    const { client, db } = await connectToE2EDb();
    const aclEntries = db.collection<AclEntryDoc>('aclentries');
    const sharedLinks = db.collection<SharedLinkDoc>('sharedlinks');
    const legacyShareId = `legacy-${suffix}`;
    let legacyResourceId: ObjectId | undefined;

    try {
      const createdShare = await waitForSharedLink(sharedLinks, sharePayload.shareId);
      const legacyShare = {
        shareId: legacyShareId,
        conversationId: createdShare.conversationId,
        title: createdShare.title ?? `Legacy shared link ${suffix}`,
        ...(createdShare.user ? { user: createdShare.user } : {}),
        messages: createdShare.messages,
        isPublic: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const insertResult = await sharedLinks.insertOne(legacyShare);
      const resourceId = insertResult.insertedId;
      legacyResourceId = resourceId;

      await page.goto(`/share/${legacyShareId}`, { timeout: 10000 });
      await expect(
        page.getByTestId('messages-view').getByText(userMessage, { exact: true }),
      ).toBeVisible();
      await expect(mockReply(page).first()).toBeVisible();

      await expect
        .poll(
          async () =>
            aclEntries.countDocuments({
              resourceType: 'sharedLink',
              resourceId,
              principalType: 'public',
            }),
          { timeout: 15000 },
        )
        .toBe(1);

      await expect
        .poll(
          async () => {
            const migrated = await sharedLinks.findOne({ _id: resourceId });
            return migrated != null && !Object.prototype.hasOwnProperty.call(migrated, 'isPublic');
          },
          { timeout: 15000 },
        )
        .toBe(true);
    } finally {
      if (legacyResourceId) {
        await Promise.all([
          aclEntries.deleteMany({ resourceId: legacyResourceId }),
          sharedLinks.deleteOne({ _id: legacyResourceId }),
        ]);
      }
      await client.close();
    }

    await page.goto(conversationUrl.pathname, { timeout: 10000 });
    await page.getByRole('button', { name: 'Export/Share' }).click();
    await page.getByTestId('share-conversation-menu-item').click();
    await expect(shareDialog).toBeVisible();
    await shareDialog.getByRole('button', { name: 'Delete Link' }).click();

    const deleteDialog = page.getByRole('alertdialog', { name: 'Delete Shared Link' });
    await expect(deleteDialog).toBeVisible();
    const [deleteResponse] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.request().method() === 'DELETE' &&
          res.url().includes(`/api/share/${sharePayload.shareId}`) &&
          res.status() === 200,
        { timeout: 30000 },
      ),
      deleteDialog.getByRole('button', { name: 'Delete Link' }).click(),
    ]);
    expect(deleteResponse.ok()).toBeTruthy();
    await expect(deleteDialog).toBeHidden();
    await expect(shareDialog).toBeVisible();
    await expect(shareDialog.getByRole('button', { name: 'Create a shared link' })).toBeVisible();
    await expect(sharedLinkInput).toHaveCount(0);
    await expect(page.getByTestId('header-shared-link-indicator')).toHaveCount(0);
  });
});
