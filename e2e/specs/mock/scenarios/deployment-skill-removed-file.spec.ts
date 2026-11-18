import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  enableCodeInterpreter,
  enableSkills,
  getAccessToken,
  getCodeProvisionedUploads,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * The deployment skill registry is built once at boot, so a bundled file removed from a running
 * instance stays registered. Its stream used to fail only after the batch upload had started,
 * which aborted the whole request and kept every later file out of the sandbox.
 */
const SKILL_NAME = 'e2e-removed-file-skill';
const REMOVED_FILE = 'b-removed.txt';
const REMOVED_CONTENT = 'removed while the server runs\n';
const REMOVED_PATH = path.resolve(
  __dirname,
  '../../../fixtures/deployment-skills',
  SKILL_NAME,
  REMOVED_FILE,
);

async function withRemovedFile(run: () => Promise<void>): Promise<void> {
  await fs.promises.rm(REMOVED_PATH, { force: true });
  try {
    await run();
  } finally {
    await fs.promises.writeFile(REMOVED_PATH, REMOVED_CONTENT);
  }
}

/** The fake code server records the base name of each uploaded file. */
async function uploadedSkillFiles(page: Page, from: number): Promise<string[]> {
  const uploads = await getCodeProvisionedUploads(page);
  return uploads
    .slice(from)
    .filter((upload) => upload.kind === 'skill')
    .map((upload) => upload.filename);
}

test('a deployment skill still primes its remaining files after one is removed from disk @scenario:deployment-skill-primes-without-removed-file', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await withRemovedFile(async () => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await enableSkills(page);
    await enableCodeInterpreter(page);
    const before = (await getCodeProvisionedUploads(page)).length;

    const response = await sendMessage(page, `E2E_INVOKE_SKILL:${SKILL_NAME}`);
    expect(response.ok()).toBeTruthy();
    await expect(
      messagesView(page).getByText(`E2E skill tool assertion passed: ${SKILL_NAME}`),
    ).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(() => uploadedSkillFiles(page, before), { timeout: 15_000 })
      .toEqual(expect.arrayContaining(['SKILL.md', 'a-first.txt', 'z-last.txt']));
    expect(await uploadedSkillFiles(page, before)).not.toContain(REMOVED_FILE);
  });
});

test('downloading a removed deployment skill file answers with an error that names no path @scenario:deployment-skill-removed-file-download-fails-cleanly', async ({
  page,
}) => {
  await withRemovedFile(async () => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15_000 });
    const token = await getAccessToken(page);
    const list = await requestJson<{ skills: Array<{ _id: string; name: string }> }>(page, {
      path: `/api/skills?search=${SKILL_NAME}&limit=10`,
      token,
    });
    const skill = list.skills.find((item) => item.name === SKILL_NAME);
    expect(skill).toBeDefined();

    const response = await page.request.get(
      `/api/skills/${skill?._id}/files/${REMOVED_FILE}?raw=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status()).toBe(500);
    expect(await response.json()).toEqual({ error: 'Error downloading skill file' });
  });
});
