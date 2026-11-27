import { expect, test } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  enableSkills,
  fetchJson,
  getAccessToken,
  messagesView,
  requestJson,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * The code window header used to repaint its panel with a per-mode fill that matched the panel
 * in every bundled theme. It now paints nothing, so the header always shows the panel's own
 * `surface-secondary`, including in a theme where the two roles differ. A skill file created by
 * the model opens a file-authoring card, whose preview carries the header.
 */
type SkillSummary = { _id: string; name: string };

test('the code window header shows its panel surface @scenario:code-window-header-shows-its-panel', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const skillName = `e2e-code-header-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  await page.goto(NEW_CHAT_PATH, { timeout: 10_000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
  await enableSkills(page);

  const response = await sendMessage(
    page,
    [`E2E_CREATE_SKILL:${skillName}`, 'Create the skill file using host file authoring only.'].join(
      '\n',
    ),
  );
  expect(response.ok()).toBeTruthy();

  try {
    const card = messagesView(page).getByRole('button', { name: /^Created / });
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();

    const copy = messagesView(page).getByRole('button', { name: 'Copy code', exact: true }).first();
    await expect(copy).toBeVisible({ timeout: 15_000 });

    const paint = await copy.evaluate((button) => {
      const header = button.closest('div.justify-between') as HTMLElement;
      const panel = header.parentElement as HTMLElement;
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'rgb(var(--surface-secondary))';
      document.body.appendChild(probe);
      const surfaceSecondary = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return {
        header: getComputedStyle(header).backgroundColor,
        panel: getComputedStyle(panel).backgroundColor,
        surfaceSecondary,
      };
    });
    expect(paint.header).toBe('rgba(0, 0, 0, 0)');
    expect(paint.panel).toBe(paint.surfaceSecondary);
  } finally {
    const token = await getAccessToken(page);
    const listed = await fetchJson<{ skills?: SkillSummary[] }>(
      page,
      `/api/skills?search=${encodeURIComponent(skillName)}&limit=10`,
      token,
    );
    const skill = listed.skills?.find((item) => item.name === skillName);
    if (skill) {
      await requestJson(page, { path: `/api/skills/${skill._id}`, token, method: 'DELETE' });
    }
  }
});
