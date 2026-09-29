import { randomUUID } from 'crypto';
import { ObjectId } from 'mongodb';
import type { APIRequestContext, Locator, Page, Response, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FileContext } from 'librechat-data-provider';
import { getE2EUser } from '../../../setup/user';
import { withMongo } from '../db';
import { escapeRegExp, getAccessToken, uniqueName } from '../helpers';
import { loginAdmin } from '../content-filters.helpers';

type UserDocument = {
  _id: ObjectId;
  email: string;
  tenantId?: string | null;
};

type UploadedFile = {
  file_id?: string;
};

const CONFIGURED_PROJECT_FILE_LIMIT = 2;

async function getPrimaryUserId(): Promise<string> {
  const owner = await withMongo(async (db) =>
    db
      .collection<UserDocument>('users')
      .findOne({ email: getE2EUser().email }, { projection: { _id: 1 } }),
  );
  if (!owner) {
    throw new Error('The authenticated e2e user was not found while resolving config override');
  }
  return owner._id.toString();
}

/** Creates a project from the all-projects page and returns its id. */
async function createProject(page: Page, name: string): Promise<string> {
  await page.goto('/projects', { timeout: 10000 });
  await page.getByRole('button', { name: 'New project' }).first().click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project name' }).fill(name);
  await dialog.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('heading', { name: new RegExp(escapeRegExp(name)) })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split('/projects/')[1];
  expect(projectId).toBeTruthy();
  return projectId;
}

function isFileUpload(response: Response): boolean {
  return (
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/files'
  );
}

async function seedProjectFiles(
  projectId: string,
  count: number,
  prefix: string,
  firstFilename?: string,
  associateWithProject = true,
): Promise<{ fileIds: string[]; filenames: string[] }> {
  const fileIds = Array.from({ length: count }, () => randomUUID());
  const filenames = fileIds.map((_, index) =>
    index === 0 && firstFilename ? firstFilename : `${prefix}-${index + 1}.txt`,
  );

  await withMongo(async (db) => {
    const owner = await db.collection<UserDocument>('users').findOne({ email: getE2EUser().email });
    if (!owner) {
      throw new Error('The authenticated e2e user was not found while seeding files');
    }

    const now = new Date();
    await db.collection('files').insertMany(
      fileIds.map((fileId, index) => ({
        _id: new ObjectId(),
        user: owner._id,
        ...(owner.tenantId ? { tenantId: owner.tenantId } : {}),
        file_id: fileId,
        bytes: 2048,
        filename: filenames[index],
        filepath: `/tmp/${fileId}.txt`,
        object: 'file',
        embedded: true,
        type: 'text/plain',
        text: `seeded project file ${index + 1}`,
        textFormat: 'text',
        status: 'ready',
        usage: 0,
        source: 'local',
        context: FileContext.message_attachment,
        createdAt: now,
        updatedAt: now,
      })),
    );
    if (associateWithProject) {
      const result = await db
        .collection('chatprojects')
        .updateOne({ _id: new ObjectId(projectId) }, { $set: { file_ids: fileIds } });
      if (result.matchedCount !== 1) {
        throw new Error(`Project ${projectId} was not found while seeding files`);
      }
    }
  });

  return { fileIds, filenames };
}

async function cleanupProjectAndFiles(
  page: Page,
  request: APIRequestContext,
  projectId: string | undefined,
  fileIds: string[],
  filenames: string[],
): Promise<void> {
  let token: string | undefined;
  try {
    token = await getAccessToken(page);
  } catch {
    token = undefined;
  }

  if (projectId && token) {
    try {
      await request.delete(`/api/projects/${encodeURIComponent(projectId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Mongo cleanup below is the final isolation boundary.
    }
  }
  if (fileIds.length > 0 && token) {
    try {
      await request.delete('/api/files', {
        headers: { Authorization: `Bearer ${token}` },
        data: { files: fileIds },
      });
    } catch {
      // Mongo cleanup below is the final isolation boundary.
    }
  }

  await withMongo(async (db) => {
    if (projectId) {
      await db.collection('chatprojects').deleteOne({ _id: new ObjectId(projectId) });
    }
    await db.collection('files').deleteMany({
      $or: [{ file_id: { $in: fileIds } }, { filename: { $in: filenames } }],
    });
  });
}

async function openExistingFilePicker(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Add files', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Choose from your files', exact: true }).click();
  const picker = page.getByRole('dialog');
  await expect(picker).toBeVisible();
  return picker;
}

async function enableProjectFiles(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: { ...(await response.json()), ragEnabled: true },
      });
    },
  );
}

async function uploadFromDevice(page: Page, files: Array<{ name: string; content: string }>) {
  await page.getByRole('button', { name: 'Add files', exact: true }).click();
  const uploadOption = page.getByRole('menuitem', { name: 'Upload from device', exact: true });
  const uploadResponse = page.waitForResponse(isFileUpload, { timeout: 30000 });
  const [fileChooser] = await Promise.all([page.waitForEvent('filechooser'), uploadOption.click()]);
  await fileChooser.setFiles(
    files.map((file) => ({
      name: file.name,
      mimeType: 'text/plain',
      buffer: Buffer.from(file.content, 'utf8'),
    })),
  );
  return uploadResponse;
}

test.describe('project file workspace UI', () => {
  test('selecting several files at once queues every file up to the project limit and reports the excess @scenario:multi-file-upload-queues-to-capacity-and-reports-excess', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    const token = await loginAdmin(request);
    const userId = await getPrimaryUserId();
    const headers = { Authorization: `Bearer ${token}` };
    let projectId: string | undefined;
    const fileIds: string[] = [];
    const filenames: string[] = [];
    try {
      const override = await request.put(`/api/admin/config/user/${encodeURIComponent(userId)}`, {
        headers,
        data: { overrides: { projects: { maxFiles: CONFIGURED_PROJECT_FILE_LIMIT } } },
      });
      const overrideText = await override.text();
      expect(override.ok(), overrideText).toBe(true);
      await expect
        .poll(
          async () => {
            const configResponse = await request.get('/api/config', {
              headers,
              failOnStatusCode: false,
            });
            const config = (await configResponse.json()) as {
              projects?: { maxFiles?: number };
            };
            return config.projects?.maxFiles;
          },
          { timeout: 30000, intervals: [250, 500, 1000] },
        )
        .toBe(CONFIGURED_PROJECT_FILE_LIMIT);

      await enableProjectFiles(page);
      projectId = await createProject(page, uniqueName('Multi-file project'));
      const seeded = await seedProjectFiles(
        projectId,
        CONFIGURED_PROJECT_FILE_LIMIT - 1,
        uniqueName('capacity-seed'),
      );
      fileIds.push(...seeded.fileIds);
      filenames.push(...seeded.filenames);
      await page.reload({ waitUntil: 'domcontentloaded' });

      const acceptedName = `${uniqueName('accepted')}.txt`;
      const excessName = `${uniqueName('excess')}.txt`;
      const uploadResponse = await uploadFromDevice(page, [
        { name: acceptedName, content: 'accepted project file' },
        { name: excessName, content: 'excess project file' },
      ]);
      expect(uploadResponse.ok()).toBeTruthy();
      const uploaded = (await uploadResponse.json()) as UploadedFile;
      if (uploaded.file_id) {
        fileIds.push(uploaded.file_id);
      }
      filenames.push(acceptedName, excessName);

      await expect(
        page.getByRole('status').filter({
          hasText: 'Could not add 1 selected file(s) because the project is at its file limit.',
        }),
      ).toBeVisible();
      const filesRegion = page.getByRole('region', { name: 'Files', exact: true });
      await expect(
        filesRegion.getByRole('listitem').filter({ hasText: acceptedName }),
      ).toContainText('Ready', { timeout: 30000 });
      await expect(filesRegion.getByRole('listitem').filter({ hasText: excessName })).toHaveCount(
        0,
      );
      await expect(filesRegion.getByRole('note')).toContainText(
        `up to ${CONFIGURED_PROJECT_FILE_LIMIT} reference files`,
      );

      const serverCheck = await seedProjectFiles(
        projectId,
        1,
        uniqueName('server-capacity-check'),
        undefined,
        false,
      );
      fileIds.push(...serverCheck.fileIds);
      filenames.push(...serverCheck.filenames);
      const rejectedAssociation = await request.post(
        `/api/projects/${encodeURIComponent(projectId)}/files`,
        {
          headers,
          data: { file_id: serverCheck.fileIds[0] },
          failOnStatusCode: false,
        },
      );
      expect(rejectedAssociation.status()).toBe(409);
      expect(await rejectedAssociation.json()).toEqual({ error: 'Project file limit reached' });
    } finally {
      try {
        await cleanupProjectAndFiles(page, request, projectId, fileIds, filenames);
      } finally {
        const removed = await request.delete(
          `/api/admin/config/user/${encodeURIComponent(userId)}`,
          { headers, failOnStatusCode: false },
        );
        const removedText = await removed.text();
        expect([200, 404], removedText).toContain(removed.status());
      }
    }
  });

  test('the existing-file picker searches by filename and pages through a large history @scenario:file-picker-searches-and-pages-large-history', async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    let projectId: string | undefined;
    const fileIds: string[] = [];
    const filenames: string[] = [];
    try {
      await enableProjectFiles(page);
      projectId = await createProject(page, uniqueName('File picker project'));
      const targetName = `${uniqueName('search-target')}.txt`;
      const seeded = await seedProjectFiles(
        projectId,
        21,
        uniqueName('picker-history'),
        targetName,
        false,
      );
      fileIds.push(...seeded.fileIds);
      filenames.push(...seeded.filenames);
      await page.reload({ waitUntil: 'domcontentloaded' });

      const picker = await openExistingFilePicker(page);
      const results = picker.getByRole('region', { name: 'Choose from your files', exact: true });
      const recentName = seeded.filenames[20];
      if (!recentName) {
        throw new Error('Expected a recent seeded file for the picker page');
      }
      const recentRow = results.getByRole('listitem').filter({ hasText: recentName });
      await expect(recentRow).toBeVisible();
      await expect(recentRow.getByRole('button')).toHaveAccessibleName(
        new RegExp(`${escapeRegExp(recentName)}\\s+2\\.0 KB`),
      );

      const search = picker.getByRole('textbox', { name: 'Search files', exact: true });
      await search.fill(targetName.slice(0, -4));
      const targetRow = results.getByRole('listitem').filter({ hasText: targetName });
      await expect(targetRow).toHaveCount(1);
      await expect(targetRow.getByRole('button')).toHaveAccessibleName(
        new RegExp(escapeRegExp(targetName)),
      );
      await expect(results.getByRole('listitem').filter({ hasText: recentName })).toHaveCount(0);

      await search.fill('');
      const loadMore = picker.getByRole('button', { name: 'Load more', exact: true });
      await expect(loadMore).toBeVisible();
      await loadMore.click();
      await expect(results.getByRole('listitem').filter({ hasText: targetName })).toHaveCount(1);
    } finally {
      await cleanupProjectAndFiles(page, request, projectId, fileIds, filenames);
    }
  });

  test("a rejected file association shows the server's reason and a retry succeeds @scenario:rejected-file-association-shows-reason-and-retry-succeeds", async ({
    page,
    request,
  }) => {
    test.setTimeout(120000);
    let projectId: string | undefined;
    const fileIds: string[] = [];
    const filenames: string[] = [];
    try {
      await enableProjectFiles(page);
      projectId = await createProject(page, uniqueName('Retry project'));
      await page.reload({ waitUntil: 'domcontentloaded' });

      const fileName = `${uniqueName('retry-file')}.txt`;
      const uploadPath = `/api/projects/${encodeURIComponent(projectId)}/files`;
      const failureBody = { error: 'Error adding project file' };
      const associationMatcher = (url: URL) => url.pathname === uploadPath;
      const failAssociation = async (route: Route) => {
        if (route.request().method() !== 'POST') {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify(failureBody),
        });
      };
      await page.route(associationMatcher, failAssociation);

      const uploadResponse = await uploadFromDevice(page, [
        { name: fileName, content: 'retryable project file' },
      ]);
      expect(uploadResponse.ok()).toBeTruthy();
      const uploaded = (await uploadResponse.json()) as UploadedFile;
      if (uploaded.file_id) {
        fileIds.push(uploaded.file_id);
      }
      filenames.push(fileName);

      const row = page.getByRole('listitem').filter({ hasText: fileName });
      await expect(row.getByRole('alert')).toHaveText(failureBody.error, { timeout: 30000 });
      await expect(row.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
      await page.unroute(associationMatcher, failAssociation);

      await row.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(row.getByRole('alert')).toHaveCount(0);
      await expect(row).toContainText('Ready', { timeout: 30000 });
    } finally {
      await cleanupProjectAndFiles(page, request, projectId, fileIds, filenames);
    }
  });
});
