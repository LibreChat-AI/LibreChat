import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  requestJson,
  sendMessage,
  getAccessToken,
  selectMockEndpoint,
} from '../helpers';

/**
 * The `$` skills popover, drawn by the chat package's command popover: a combobox over the
 * user's skills whose pick stages the skill for the next turn instead of writing it into the
 * draft, and which says so when a search matches nothing.
 */
test.describe.configure({ timeout: 120_000 });

type SkillSummary = { _id: string; name: string };

const uniqueName = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

async function createSkill(page: Page, name: string): Promise<string> {
  const token = await getAccessToken(page);
  const skill = await requestJson<SkillSummary>(page, {
    path: '/api/skills',
    token,
    method: 'POST',
    body: { name, description: `Composer popover skill ${name}`, body: `# ${name}\n\nE2E.` },
  });
  expect(skill._id).toBeTruthy();
  return skill._id;
}

async function deleteSkill(page: Page, id: string) {
  const token = await getAccessToken(page);
  await requestJson<unknown>(page, {
    path: `/api/skills/${encodeURIComponent(id)}`,
    token,
    method: 'DELETE',
  });
}

async function withSkills(page: Page, names: string[], run: () => Promise<void>) {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  const ids: string[] = [];
  try {
    for (const name of names) {
      ids.push(await createSkill(page, name));
    }
    await page.reload();
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    await run();
  } finally {
    for (const id of ids) {
      await deleteSkill(page, id);
    }
  }
}

async function openSkills(page: Page) {
  const textarea = page.getByRole('textbox', { name: 'Message input' });
  await textarea.click();
  await textarea.fill('');
  await textarea.pressSequentially('$');
  const combobox = page.getByRole('combobox', { name: /Select a Skill/ });
  await expect(combobox).toBeFocused();
  return { textarea, combobox };
}

test.describe('skills popover', () => {
  test('keyboard moves and announces the active skill @scenario:skills-popover-keyboard-combobox', async ({
    page,
  }) => {
    const prefix = uniqueName('e2e-kbd');
    await withSkills(page, [`${prefix}-a`, `${prefix}-b`], async () => {
      const { textarea, combobox } = await openSkills(page);
      await combobox.fill(prefix);
      await expect(page.getByRole('option')).toHaveCount(2);
      await expect(combobox).toHaveAttribute('aria-activedescendant', 'skill-item-0');

      await combobox.press('ArrowDown');
      await expect(combobox).toHaveAttribute('aria-activedescendant', 'skill-item-1');
      await expect(page.locator('[id="skill-item-1"]')).toHaveAttribute('aria-selected', 'true');

      await combobox.press('Escape');
      await expect(page.getByRole('combobox', { name: /Select a Skill/ })).toHaveCount(0);
      await expect(textarea).toBeFocused();
    });
  });

  test('a pick stages the skill for the next turn @scenario:skills-popover-stages-skill', async ({
    page,
  }) => {
    const name = uniqueName('e2e-stage');
    await withSkills(page, [name], async () => {
      const { textarea, combobox } = await openSkills(page);
      await combobox.fill(name);
      await expect(page.getByRole('option', { name: new RegExp(name) })).toBeVisible();
      await combobox.press('Enter');

      await expect(page.getByRole('combobox', { name: /Select a Skill/ })).toHaveCount(0);
      await expect(textarea).toBeFocused();
      await expect(textarea).toHaveValue('');
      await expect(
        page
          .getByTestId('composer-tray')
          .getByTestId('composer-chip-skill')
          .filter({ hasText: name }),
      ).toBeVisible();

      const response = await sendMessage(page, 'Use the staged skill');
      expect(response.ok()).toBeTruthy();
      expect(
        (response.request().postDataJSON() as { manualSkills?: string[] }).manualSkills,
      ).toEqual([name]);
    });
  });

  test('a search that matches nothing says so and Enter closes @scenario:skills-popover-no-match-notice', async ({
    page,
  }) => {
    await withSkills(page, [uniqueName('e2e-none')], async () => {
      const { textarea, combobox } = await openSkills(page);
      await combobox.fill('zzzz-no-such-skill');

      await expect(page.getByRole('status').filter({ hasText: 'No skills found' })).toBeVisible();
      await expect(combobox).toHaveAttribute('aria-expanded', 'false');
      await combobox.press('Enter');

      await expect(page.getByRole('combobox', { name: /Select a Skill/ })).toHaveCount(0);
      await expect(textarea).toBeFocused();
    });
  });
});
