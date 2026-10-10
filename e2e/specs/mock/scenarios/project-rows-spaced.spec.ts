import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getAccessToken } from '../helpers';

const ROW_GAP = 4;

type ProjectApi = { _id: string; name: string };

async function apiProject(
  page: Page,
  token: string,
  method: 'POST' | 'DELETE',
  target: { name: string } | { id: string },
): Promise<ProjectApi | null> {
  return page.evaluate(
    async ({ token: bearer, method: verb, target: body }) => {
      const url = 'id' in body ? `/api/projects/${encodeURIComponent(body.id)}` : '/api/projects';
      const response = await fetch(url, {
        method: verb,
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: 'id' in body ? undefined : JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`${verb} ${url} returned ${response.status}`);
      }
      const text = await response.text();
      return text ? (JSON.parse(text) as ProjectApi) : null;
    },
    { token, method, target },
  );
}

test.describe('sidebar projects', () => {
  test('consecutive project rows are separated by a small gap @scenario:project-rows-spaced', async ({
    page,
  }) => {
    test.setTimeout(90000);
    await page.goto('/c/new', { timeout: 15000 });
    const token = await getAccessToken(page);
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
    const names = [`E2E Spaced A ${stamp}`, `E2E Spaced B ${stamp}`];
    const created: ProjectApi[] = [];
    try {
      for (const name of names) {
        const project = await apiProject(page, token, 'POST', { name });
        expect(project?._id).toBeTruthy();
        created.push(project as ProjectApi);
      }
      await page.reload();

      if ((page.viewportSize()?.width ?? 0) <= 768) {
        await page.getByRole('button', { name: 'Open sidebar' }).click();
      }
      const toggle = page.getByRole('button', { name: 'Projects', exact: true });
      await expect(toggle).toBeVisible();
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
        await toggle.click();
      }
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const first = page.locator(`li:has(button:has-text("${names[0]}"))`).last();
      const second = page.locator(`li:has(button:has-text("${names[1]}"))`).last();
      await expect(first).toBeVisible();
      await expect(second).toBeVisible();

      const boxes = await Promise.all([first.boundingBox(), second.boundingBox()]);
      const [a, b] = boxes;
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      /** Newest first, so the second-created project sits above the first. */
      const [upper, lower] = (a?.y ?? 0) < (b?.y ?? 0) ? [a, b] : [b, a];
      const gap = (lower?.y ?? 0) - ((upper?.y ?? 0) + (upper?.height ?? 0));
      expect(Math.abs(gap - ROW_GAP)).toBeLessThanOrEqual(1);
    } finally {
      for (const project of created) {
        await apiProject(page, token, 'DELETE', { id: project._id }).catch(() => undefined);
      }
    }
  });
});
