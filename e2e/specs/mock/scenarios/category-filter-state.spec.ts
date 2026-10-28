import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openAgentBuilder } from '../agents.helpers';
import { getAccessToken, requestJson } from '../helpers';

/**
 * Picking a category in the Skills dialog marks the filter as active on its icon, drawn in the
 * theme's accent role; the resting filter keeps the tertiary icon. The state used to be a raw
 * emerald border no theme could set.
 */
type SkillSummary = { _id: string; name: string };

async function resolveRole(page: Page, role: string): Promise<string> {
  return page.evaluate((name) => {
    const probe = document.createElement('div');
    probe.style.color = `rgb(var(--${name}))`;
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, role);
}

async function openSkillsPicker(page: Page): Promise<Locator> {
  const form = await openAgentBuilder(page);
  await form.getByRole('radio', { name: 'Selected', exact: true }).click();
  const addSkill = form.getByRole('button', { name: /Add skill/ }).first();
  await expect(addSkill).toBeVisible();
  await addSkill.click();
  const dialog = page.getByRole('dialog', { name: 'Skills', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

const filterIconColor = (trigger: Locator) =>
  trigger
    .locator('svg')
    .first()
    .evaluate((icon) => getComputedStyle(icon).color);

test('an active skills category shows on the filter icon in the accent role @scenario:skills-category-filter-shows-active-state', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/c/new', { timeout: 15_000 });
  const token = await getAccessToken(page);
  const suffix = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const category = `theme-${suffix}`;
  const skill = await requestJson<SkillSummary>(page, {
    path: '/api/skills',
    token,
    method: 'POST',
    body: {
      name: `filter-state-${suffix}`,
      description: 'Carries a category so the Skills dialog offers a category filter.',
      body: '# Category filter\n\nUsed by the category filter end-to-end test.',
      category,
    },
  });

  try {
    const dialog = await openSkillsPicker(page);
    const trigger = dialog.getByRole('button', { name: 'Category', exact: true });
    await expect(trigger).toBeVisible();
    expect(await filterIconColor(trigger)).toBe(await resolveRole(page, 'text-tertiary'));

    await trigger.click();
    await page.getByRole('menuitem', { name: category }).click();
    await expect(trigger).toContainText(category);
    expect(await filterIconColor(trigger)).toBe(await resolveRole(page, 'accent-primary'));
  } finally {
    await requestJson(page, { path: `/api/skills/${skill._id}`, token, method: 'DELETE' });
  }
});
