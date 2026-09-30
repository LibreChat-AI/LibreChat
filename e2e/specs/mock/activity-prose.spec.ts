import { expect, test } from '@playwright/test';
import { NEW_CHAT_PATH, messagesView, selectMockEndpoint, sendMessage } from './helpers';

const INTRO = "Let me establish today's date and gather independent signals in parallel.";
const LABELS = [
  'Established current date, found active incidents and recent chart updates',
  'Checked chart version and loaded the logs schema',
  'Confirmed deployed image and checked runtime configuration',
];
const LABEL_SERVER = `http://127.0.0.1:${process.env.E2E_LABEL_PORT || '8889'}`;

type ProseProbe = {
  fadeStarts: number;
  lowestOpacity: number;
  disconnected: boolean;
  spans: Element[];
};
type ObservedParagraph = HTMLElement & { proseProbe?: ProseProbe };

/** Do not let an OS motion preference silently bypass the regression. */
test.use({ contextOptions: { reducedMotion: 'no-preference' } });

for (const autoExpandTools of [false, true]) {
  test(`keeps introductory Markdown mounted without replaying its fade as activity labels arrive (tools expanded: ${autoExpandTools})`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.addInitScript((expanded) => {
      localStorage.setItem('smoothStreaming', 'true');
      localStorage.setItem('autoExpandTools', String(expanded));
      localStorage.setItem('color-theme', 'dark');
    }, autoExpandTools);
    const label = `prose-${Date.now()}`;
    expect((await request.post(`${LABEL_SERVER}/__e2e/reset`)).ok()).toBeTruthy();
    expect(
      (
        await request.post(`${LABEL_SERVER}/__e2e/behavior`, {
          data: {
            delayMs: 700,
            phaseLabel: 'Verified runtime configuration and deployment',
            labelsByPrompt: Object.fromEntries(
              LABELS.map((text, batch) => [`activity prose ${label} ${batch}`, text]),
            ),
          },
        })
      ).ok(),
    ).toBeTruthy();

    await page.goto(NEW_CHAT_PATH);
    await selectMockEndpoint(page, { label: 'Mock Provider F', model: 'mock-model-f' });
    await page.getByRole('button', { name: 'MCP Servers', exact: true }).click();
    const server = page.getByRole('menuitemcheckbox', { name: /E2E Memory/ });
    await server.click();
    await expect(server).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    expect((await sendMessage(page, `E2E_ACTIVITY_PROSE_REPLY:${label}`)).ok()).toBeTruthy();

    const intro = messagesView(page).locator('.message-content p').filter({ hasText: INTRO });
    await expect(intro).toHaveText(INTRO);
    /** Prove this is the real animated Markdown path, not a text stub or a
     * reduced-motion run that could pass without ever exercising the fade. */
    await expect(intro.locator('[data-lc-fade]').first()).toHaveCSS('animation-name', 'lc-fade-in');
    await expect
      .poll(() =>
        intro.evaluate((element) =>
          element
            .getAnimations({ subtree: true })
            .every((animation) => animation.playState === 'finished'),
        ),
      )
      .toBe(true);
    const original = await intro.elementHandle();
    if (!original) {
      throw new Error('Introductory Markdown paragraph was not mounted');
    }
    await original.evaluate((element: ObservedParagraph) => {
      const probe: ProseProbe = {
        fadeStarts: 0,
        lowestOpacity: 1,
        disconnected: false,
        spans: Array.from(element.querySelectorAll('[data-lc-fade]')),
      };
      element.proseProbe = probe;
      document.addEventListener(
        'animationstart',
        (event) => {
          const target = event.target;
          if (
            event.animationName === 'lc-fade-in' &&
            target instanceof Element &&
            target.closest('p')?.textContent === element.textContent
          ) {
            probe.fadeStarts += 1;
            probe.lowestOpacity = Math.min(
              probe.lowestOpacity,
              Number(getComputedStyle(target).opacity),
            );
          }
        },
        true,
      );
      const observer = new MutationObserver(() => {
        if (!element.isConnected) {
          probe.disconnected = true;
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });

    const snapshots = [];
    for (const text of LABELS.slice(0, 2)) {
      await expect(
        messagesView(page)
          .getByRole('button', { name: new RegExp(text) })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      /** Sample on a painted frame so queued animationstart events are included. */
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const snapshot = await original.evaluate((element: ObservedParagraph) => {
        const probe = element.proseProbe;
        if (!probe) {
          throw new Error('Markdown observer was lost');
        }
        return {
          connected: element.isConnected,
          disconnected: probe.disconnected,
          originalFadeSpansConnected: probe.spans.every((span) => span.isConnected),
          fadeStarts: probe.fadeStarts,
          lowestOpacity: probe.lowestOpacity,
        };
      });
      snapshots.push({ label: text, ...snapshot });
      expect
        .soft(snapshot.connected, 'An activity update must retain the original paragraph')
        .toBe(true);
      expect
        .soft(snapshot.originalFadeSpansConnected, 'Existing word spans must not be replaced')
        .toBe(true);
      expect
        .soft(snapshot.fadeStarts, 'Already-visible prose must not restart its word fade')
        .toBe(0);
    }
    await testInfo.attach('markdown-identity-and-fade', {
      body: JSON.stringify(snapshots, null, 2),
      contentType: 'application/json',
    });
    await expect(messagesView(page).getByText(`E2E activity prose complete ${label}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeHidden();
    await expect(intro).toHaveText(INTRO);
  });
}
