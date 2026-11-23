import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  messagesView,
  selectMockEndpoint,
  sendMessage,
} from '../helpers';

/**
 * A floating label breaks its field's top border, so it paints over the border
 * with the colour behind it. When a page moves to another surface, a label still
 * painting the old one shows as a patch across the border.
 */
async function paintsItsBackdrop(notch: Locator): Promise<{ notch: string; backdrop: string }> {
  return notch.evaluate((element) => {
    const opaque = (node: Element) => {
      const color = getComputedStyle(node).backgroundColor;
      return color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color);
    };
    let node = element.parentElement;
    while (node && !opaque(node)) {
      node = node.parentElement;
    }
    return {
      notch: getComputedStyle(element).backgroundColor,
      backdrop: node ? getComputedStyle(node).backgroundColor : 'none',
    };
  });
}

test.describe('page surfaces', () => {
  test('floating field labels paint the surface of the page they sit on @scenario:field-labels-match-page-surface', async ({
    page,
  }) => {
    await page.goto('/agents');
    const search = page.locator('#agent-search');
    await expect(search).toBeVisible({ timeout: 20_000 });
    const marketplace = await paintsItsBackdrop(search.locator('..'));
    expect(marketplace.notch).toBe(marketplace.backdrop);

    await page.goto('/skills/new');
    const nameLabel = page.locator('label[for="skill-name"]');
    await expect(nameLabel).toBeVisible({ timeout: 20_000 });
    const skill = await paintsItsBackdrop(nameLabel);
    expect(skill.notch).toBe(skill.backdrop);
  });

  test('a reply with a wide table stays inside the chat column @scenario:chat-column-fits-beside-sidebar', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, MOCK_ENDPOINTS[0]);
    const response = await sendMessage(page, 'E2E_PARAGRAPHS_REPLY');
    expect(response.ok()).toBeTruthy();
    const view = messagesView(page);
    await expect(view.getByText('E2E closing paragraph')).toBeVisible({ timeout: 20_000 });
    await expect(view.locator('.markdown-table-wrapper')).toBeVisible();

    const bounds = await view.evaluate((element) => {
      const wrapper = element.querySelector('.markdown-table-wrapper')!;
      return {
        viewRight: element.getBoundingClientRect().right,
        viewport: window.innerWidth,
        tableScrolls: wrapper.scrollWidth > wrapper.clientWidth,
      };
    });
    expect(bounds.viewRight).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.tableScrolls).toBe(true);
  });
});
