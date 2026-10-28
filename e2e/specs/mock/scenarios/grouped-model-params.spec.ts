import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, selectMockEndpoint } from '../helpers';
import type { MockEndpoint } from '../helpers';
import { openPanel } from './panels';
import { withMongo } from '../db';

/** Mock Provider A takes Anthropic's parameter set, which carries the thinking and
 *  prompt cache controls this panel groups. */
async function openParameters(
  page: Page,
  endpoint: MockEndpoint = MOCK_ENDPOINTS[0],
): Promise<void> {
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, endpoint);
  await openPanel(page, 'parameters', 'Parameters');
  await expect(page.getByRole('region', { name: 'Sampling' })).toBeVisible();
}

test.describe('grouped model parameters', () => {
  test('the parameters are filed under headings that count what this chat changed @scenario:params-grouped-with-change-count', async ({
    page,
  }) => {
    await openParameters(page);

    const reasoning = page.getByRole('region', { name: 'Reasoning' });
    await expect(reasoning).toBeVisible();
    await expect(page.getByRole('region', { name: 'Context' })).toBeVisible();
    await expect(reasoning.getByRole('switch', { name: /Thinking/ }).first()).toBeVisible();
    await expect(reasoning.getByText(/^\d+$/)).toHaveCount(0);

    await reasoning
      .getByRole('switch', { name: /^Thinking/ })
      .first()
      .click();
    await expect(reasoning.getByText(/^1$/)).toBeVisible();
    /* The numeral is decoration; the heading says what it counts. */
    await expect(page.getByRole('region', { name: 'Reasoning 1 changed setting' })).toBeVisible();
  });

  test('a parameter stays on screen when the toggle it works with is off @scenario:params-stay-visible-when-companion-off', async ({
    page,
  }) => {
    await openParameters(page);

    const reasoning = page.getByRole('region', { name: 'Reasoning' });
    const thinking = reasoning.getByRole('switch', { name: /^Thinking/ }).first();
    await expect(thinking).toHaveAttribute('aria-checked', 'true');
    await thinking.click();
    await expect(thinking).toHaveAttribute('aria-checked', 'false');

    await expect(reasoning.getByText('Thinking Budget')).toBeVisible();
  });

  test('the preset editor keeps each label beside its control @scenario:preset-dialog-controls-keep-labels-close', async ({
    page,
  }) => {
    /* The harness defines model specs, which turn the presets menu off; the editor that
     * reuses these controls sits behind it. */
    await page.route(
      (url) => url.pathname === '/api/config',
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          json: { ...body, interface: { ...body.interface, presets: true, modelSelect: true } },
        });
      },
    );
    const title = `Params preset ${randomUUID().slice(0, 8)}`;
    try {
      /* Mock Provider B is a plain custom endpoint, so its preset editor is the OpenAI
       * one, whose left column holds far fewer controls than its right. */
      await openParameters(page, MOCK_ENDPOINTS[1]);
      await page.getByRole('button', { name: 'Save As Preset' }).click();
      const saveDialog = page.getByRole('dialog');
      await saveDialog.getByRole('textbox').first().fill(title);
      await saveDialog.getByRole('button', { name: 'Save' }).click();
      await expect(saveDialog).toBeHidden();

      /* On a phone the drawer holding the panel covers the header's presets button. */
      if ((page.viewportSize()?.width ?? 1280) < 768) {
        await page.getByTestId('close-sidebar-button').click();
      }
      await page.getByTestId('presets-button').first().click();
      const presets = page.getByRole('dialog', { name: 'Presets' });
      const item = presets.getByRole('button', { name: new RegExp(`^${title}`) });
      /* Each run has its own database, so this preset is the only one listed. */
      await item.hover();
      await presets.getByRole('button', { name: 'Edit' }).first().click();
      const editor = page.getByRole('dialog').filter({ has: page.getByRole('slider') });
      await expect(editor.getByRole('slider').first()).toBeVisible();

      /* A control stretched to its column's height would push its field far below its
       * label. */
      /* Each control's label and field share one hover card trigger; the field is its
       * last child, whatever kind of control it is. */
      const gaps = await editor.evaluate((element) =>
        Array.from(element.querySelectorAll('label'))
          .map((label) => {
            const trigger = label.closest('[data-state]');
            const field = trigger?.lastElementChild;
            if (trigger == null || field == null || field.contains(label)) {
              return null;
            }
            return {
              label: label.textContent,
              gap: field.getBoundingClientRect().top - label.getBoundingClientRect().bottom,
            };
          })
          .filter((entry) => entry != null),
      );
      expect(gaps.length, JSON.stringify(gaps)).toBeGreaterThan(3);
      for (const entry of gaps) {
        expect(entry?.gap, JSON.stringify(entry)).toBeLessThan(48);
      }
    } finally {
      await withMongo((db) => db.collection('presets').deleteMany({ title }));
    }
  });

  test('Reset and Save As Preset stay inside the panel in a language with long labels @scenario:params-actions-fit-long-labels', async ({
    page,
  }) => {
    /* The endpoint is chosen in English, where the model selector's label is known,
     * and the chat keeps it across the reload into Spanish. */
    await openParameters(page);
    await page.evaluate(() => window.localStorage.setItem('lang', 'es-ES'));
    await page.reload();
    /* The shared sidebar helpers read English labels, so the Spanish shell is driven
     * by its own. */
    if ((page.viewportSize()?.width ?? 1280) < 768) {
      await page.getByRole('button', { name: 'Abrir barra lateral' }).first().click();
      await page.getByTestId('panel-switcher-button').click();
      await page.getByRole('menuitemcheckbox', { name: 'Parámetros', exact: true }).click();
    } else {
      const trigger = page.getByTestId('nav-panel-parameters');
      if ((await trigger.getAttribute('aria-pressed')) !== 'true') {
        await trigger.click();
      }
    }
    const save = page.getByRole('button', { name: 'Guardar como configuración preestablecida' });
    await expect(save).toBeVisible();

    /* The finding is the action row running past the panel, so the row and the
     * button's own label are what is measured. */
    const row = save.locator('xpath=..');
    const measured = await row.evaluate((element) => {
      const button = element.lastElementChild as HTMLElement;
      const panel = element.parentElement as HTMLElement;
      const rowBox = element.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      return {
        rowScroll: element.scrollWidth,
        rowClient: element.clientWidth,
        buttonScroll: button.scrollWidth,
        buttonClient: button.clientWidth,
        rowRight: rowBox.right,
        panelRight: panelBox.right,
      };
    });
    expect(measured.rowScroll, JSON.stringify(measured)).toBeLessThanOrEqual(measured.rowClient);
    expect(measured.rowRight, JSON.stringify(measured)).toBeLessThanOrEqual(measured.panelRight);
  });
});
