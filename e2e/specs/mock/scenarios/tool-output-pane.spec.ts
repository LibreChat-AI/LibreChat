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
 * The output panes of code execution, file authoring and file reads paint the `surface-code-body`
 * role instead of a per-mode pair of surfaces. A skill file created by the model opens a
 * file-authoring card, whose preview pane is one of the three.
 */
type SkillSummary = { _id: string; name: string };

test('the tool output pane paints the code body role @scenario:tool-output-pane-follows-code-body', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const skillName = `e2e-output-pane-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
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

    const pane = messagesView(page).locator('pre:has(code.hljs)').first();
    await expect(pane).toBeVisible({ timeout: 15_000 });

    const role = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'rgb(var(--surface-code-body))';
      document.body.appendChild(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { color, dark: document.documentElement.classList.contains('dark') };
    });

    expect(role.color).toBe(role.dark ? 'rgb(23, 23, 23)' : 'rgb(255, 255, 255)');
    await expect(pane).toHaveCSS('background-color', role.color);
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
