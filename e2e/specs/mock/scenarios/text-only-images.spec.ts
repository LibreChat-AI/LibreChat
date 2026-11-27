import { expect, test } from '@playwright/test';
import type { GraphEdge } from 'librechat-data-provider';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  requestJson,
  messagesView,
  getAccessToken,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';

/**
 * A person sends an image to an agent that reads images, and the run then reaches an agent whose
 * model is declared text-only (the builder's switch), through an agent chain or a handoff. The
 * fake model answers each agent with what that agent's own request carried: the images, and the
 * text markers the agents SDK put in their place.
 */

/** A 16 by 16 PNG, the fixture `user-image-alignment.spec.ts` uploads. */
const IMAGE = {
  name: 'chart.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVQ4jWNwaDjwnxLMMGrA/9EwODAaBg3DIgwACY9/HwbtciYAAAAASUVORK5CYII=',
    'base64',
  ),
};

type AgentFields = { text_only?: boolean; agent_ids?: string[]; edges?: GraphEdge[] };

const createAgent = async (page: Page, prefix: string, fields: AgentFields) => {
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name: uniqueAgentName(prefix),
      description: 'Text-only recipient acceptance fixture.',
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      ...fields,
    },
  });
};

/** Adds the image to the next message through the composer palette. */
const attachImage = async (page: Page) => {
  const upload = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/api\/files(\/images)?$/.test(new URL(response.url()).pathname),
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
  const source = palette.getByRole('button', {
    name: /^(From Local Computer|Upload to Provider)$/,
  });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), source.click()]);
  await chooser.setFiles(IMAGE);
  expect((await upload).ok()).toBeTruthy();
};

/**
 * Sends the image to `readerId` and returns the two reports: the reader's (nothing declared) and
 * the writer's (declared text-only), each as the fake model wrote it.
 */
const sendImage = async (page: Page, readerId: string, writerId: string) => {
  const label = `images-${Date.now()}`;
  await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(readerId)}`, {
    timeout: 10_000,
  });
  await attachImage(page);
  const response = await sendMessageAndWaitForCompletion(page, `E2E_REPORT_IMAGES:${label}`, {
    timeout: 60_000,
  });
  expect(response.ok()).toBeTruthy();
  return {
    reader: messagesView(page).getByText(`E2E images ${label}: agent=${readerId};`),
    writer: messagesView(page).getByText(`E2E images ${label}: agent=${writerId};`),
  };
};

test.describe('images sent toward a text-only agent', () => {
  test.describe.configure({ timeout: 120_000 });

  test('an agent chain gives its text-only agent a text marker in place of the image @scenario:text-only-chain-agent-gets-image-marker', async ({
    page,
  }) => {
    let writerId: string | undefined;
    let readerId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
      const writer = await createAgent(page, 'E2E Text-Only Writer', { text_only: true });
      writerId = writer.id;
      const reader = await createAgent(page, 'E2E Image Reader', { agent_ids: [writer.id] });
      readerId = reader.id;

      const reports = await sendImage(page, reader.id, writer.id);

      await expect(reports.reader).toHaveText(/; images=1; omitted=0$/);
      await expect(reports.writer).toHaveText(/; images=0; omitted=1$/);
    } finally {
      await cleanupAgent(page, readerId);
      await cleanupAgent(page, writerId);
    }
  });

  test('a handoff gives its text-only target a text marker in place of the image @scenario:text-only-handoff-target-gets-image-marker', async ({
    page,
  }) => {
    let writerId: string | undefined;
    let readerId: string | undefined;
    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
      const writer = await createAgent(page, 'E2E Text-Only Writer', { text_only: true });
      writerId = writer.id;
      const reader = await createAgent(page, 'E2E Image Reader', {
        edges: [{ from: '', to: writer.id, edgeType: 'handoff' }],
      });
      readerId = reader.id;

      const reports = await sendImage(page, reader.id, writer.id);

      await expect(reports.reader).toHaveText(/; images=1; omitted=0$/);
      await expect(reports.writer).toHaveText(/; images=0; omitted=1$/);
      await expect(
        messagesView(page).getByRole('button', { name: `Transferred to ${writer.name}` }),
      ).toBeVisible();
    } finally {
      await cleanupAgent(page, readerId);
      await cleanupAgent(page, writerId);
    }
  });
});
