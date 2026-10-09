import { expect, test } from '@playwright/test';
import type { Locator, Page, Route } from '@playwright/test';
import translations from '../../../../client/src/locales/en/translation.json';

type MockAgent = {
  id: string;
  name: string;
  description: string;
  category: string;
  avatar: null;
  created_at: number;
  provider: string;
  model: string;
  model_parameters: Record<string, null>;
};

const responseFor = (agent: MockAgent) => ({
  object: 'list',
  data: [agent],
  first_id: agent.id,
  last_id: agent.id,
  has_more: false,
});

const pageFor = (agents: MockAgent[], after?: string) => ({
  object: 'list',
  data: agents,
  first_id: agents[0]?.id ?? null,
  last_id: agents.at(-1)?.id ?? null,
  has_more: after != null,
  after: after ?? null,
});

const makeAgent = (suffix: string): MockAgent => ({
  id: `agent-marketplace-recovery-${suffix}`,
  name: `Marketplace Recovery Agent ${suffix}`,
  description: 'A known agent returned by the marketplace recovery scenario.',
  category: 'general',
  avatar: null,
  created_at: Date.now(),
  provider: 'openAI',
  model: 'gpt-4',
  model_parameters: {
    temperature: null,
    maxContextTokens: null,
    maxOutputTokens: null,
    top_p: null,
    presence_penalty: null,
    frequency_penalty: null,
  },
});

/* More than the grid's windowing threshold, so the list virtualizes and its height is
   what the scroll position depends on. */
const makeAgents = (count: number, offset: number): MockAgent[] =>
  Array.from({ length: count }, (_, index) => makeAgent(`row-${offset + index}`));

const routeMarketplace = async (page: Page, handler: (route: Route) => Promise<void>) => {
  await page.route('**/api/agents*', async (route) => {
    const requestUrl = new URL(route.request().url());
    // The agent selector also calls this endpoint and now refreshes on window focus.
    // Marketplace always sends its sort; only those requests belong to this fixture.
    if (
      route.request().method() !== 'GET' ||
      requestUrl.pathname !== '/api/agents' ||
      !requestUrl.searchParams.has('sort')
    ) {
      await route.continue();
      return;
    }
    await handler(route);
  });
};
test.describe('marketplace recovery', () => {
  test('@scenario:failed-marketplace-load-retries-itself retries a failed marketplace load without user interaction', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const agent = makeAgent('automatic');
    let listRequests = 0;

    /* The query itself absorbs the first failure and two immediate retries
       (`client/src/data-provider/Agents/queries.ts`), so the error card only appears after
       three, and each of the card's own attempts costs another three. The failures walk
       through every status the marketplace treats as transient: a run that classified 429
       or 408 as final would stop attempting there and never reach the served page. */
    const failureStatuses = [500, 500, 500, 429, 429, 429, 408, 408, 408];
    await routeMarketplace(page, async (route) => {
      listRequests += 1;
      const status = failureStatuses[listRequests - 1];
      if (status != null) {
        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'marketplace unavailable' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(responseFor(agent)),
      });
    });

    await page.goto('/agents/all');
    /* The card retitles itself as the failures change status, so match any of the three
       rather than racing whichever one is on screen when the assertion runs. */
    await expect(page.getByRole('alert')).toContainText(
      new RegExp(
        [
          translations.com_agents_error_server_title,
          translations.com_agents_error_rate_limit_title,
          translations.com_agents_error_timeout_title,
        ].join('|'),
      ),
    );
    await expect(page.getByRole('button', { name: agent.name })).toBeVisible({ timeout: 45_000 });
    expect(listRequests).toBeGreaterThan(failureStatuses.length);
  });

  test('@scenario:missing-marketplace-page-stays-neutral keeps a missing marketplace page neutral without automatic retries', async ({
    page,
  }) => {
    let listRequests = 0;

    await routeMarketplace(page, async (route) => {
      listRequests += 1;
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'marketplace page not found' }),
      });
    });

    await page.goto('/agents/all');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(translations.com_agents_error_not_found_title);
    await expect(alert).toContainText(translations.com_agents_error_not_found_message);
    /* The neutral kind is the one the card does not keep re-attempting: no countdown is
       offered, and the request count stays where the first load left it. */
    await expect(page.getByText(/Retrying automatically in \d+s/)).toHaveCount(0);

    const settledRequests = listRequests;
    await expect.poll(() => listRequests, { timeout: 3500 }).toBe(settledRequests);
  });

  test('@scenario:returning-to-the-window-retries-once retries exactly once when the window returns', async ({
    page,
  }) => {
    const agent = makeAgent('window-return');
    let listRequests = 0;
    let recovered = false;

    await routeMarketplace(page, async (route) => {
      listRequests += 1;
      if (!recovered) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'marketplace unavailable' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(responseFor(agent)),
      });
    });

    await page.goto('/agents/all');
    await expect(page.getByRole('alert')).toContainText(translations.com_agents_error_server_title);
    /* Wait for a long backoff step, so the attempt observed below is the one the window
       return caused and not the step that happened to be due. */
    await expect(page.getByText(/Retrying automatically in ([4-9]|\d\d)s/)).toBeVisible({
      timeout: 30_000,
    });

    recovered = true;
    const beforeReturn = listRequests;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    await expect(page.getByRole('button', { name: agent.name })).toBeVisible({ timeout: 30_000 });
    /* Exactly one: the return replaces the attempt the backoff had pending instead of
       firing alongside it. The served page also succeeds, so it costs no query retry. */
    expect(listRequests).toBe(beforeReturn + 1);
    await expect.poll(() => listRequests, { timeout: 3000 }).toBe(beforeReturn + 1);
  });

  test('@scenario:pagination-failure-keeps-the-loaded-rows a failed next page keeps the loaded rows and the scroll position', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const loaded = makeAgents(36, 0);
    const nextPage = makeAgents(8, 36);
    let cursorRequests = 0;
    let cursorServed = false;

    await routeMarketplace(page, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (cursor == null) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(pageFor(loaded, 'cursor-page-two')),
        });
        return;
      }
      cursorRequests += 1;
      if (!cursorServed) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'cursor page unavailable' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(pageFor(nextPage)),
      });
    });

    await page.goto('/agents/all');
    await expect(page.getByRole('button', { name: loaded[0].name })).toBeVisible();

    /* The marketplace scrolls its own frame, which is the element the grid is rendered
       into rather than the document. */
    const frame = page.getByRole('tabpanel').locator('xpath=..');
    await frame.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const deepScroll = await frame.evaluate((element) => element.scrollTop);
    expect(deepScroll).toBeGreaterThan(0);
    /* The row the reader has reached. It is what has to still be on screen afterwards:
       the position in pixels moves by whatever the card below the list occupies, the
       row the reader was looking at does not. */
    const anchor = page.getByRole('button', { name: loaded[loaded.length - 1].name });
    await expect(anchor).toBeVisible();

    /* Reaching the end asks for the next cursor page; it fails, and the query's two
       immediate retries fail with it, so the error card takes over recovery. */
    await expect(page.getByRole('alert')).toContainText(
      translations.com_agents_error_server_title,
      {
        timeout: 30_000,
      },
    );
    expect(cursorRequests).toBeGreaterThan(0);

    /* The rows stay mounted behind the card, so the frame keeps its height and the
       reader keeps their place: replacing the list collapses that height and the browser
       clamps the scroll position back to the first row. */
    await expect(page.getByRole('tabpanel').getByRole('listitem').first()).toBeVisible();
    await expect(anchor).toBeVisible();
    expect(await frame.evaluate((element) => element.scrollTop)).toBeGreaterThan(deepScroll / 2);

    /* Returning to the window is the card's immediate attempt, so the recovery does not
       have to wait out a backoff step whose button is disabled while it runs. */
    cursorServed = true;
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 30_000 });
    /* Recovery appends to the list the reader was reading rather than remounting it, so
       the page they had reached is still the page they are on. The appended rows sit
       below the viewport and the virtualizer has not mounted them, which is exactly why
       the anchor row is what this asserts. */
    await expect(anchor).toBeVisible();
    expect(await frame.evaluate((element) => element.scrollTop)).toBeGreaterThan(deepScroll / 2);
  });

  test('@scenario:retry-keeps-the-error-card-on-screen the retry runs behind the error card instead of a skeleton', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await routeMarketplace(page, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'marketplace unavailable' }),
      });
    });

    await page.goto('/agents/all');
    const alert = page.getByRole('alert');
    await expect(alert).toContainText(translations.com_agents_error_server_title);

    /* The card's own attempt, reported on its button. The failure has no data of its
       own, so this is exactly when a skeleton would fill the viewport, push the card's
       status, countdown and action below the fold, and leave the reader looking at
       placeholder cards instead of the recovery. */
    await expect(
      page.getByRole('button', { name: translations.com_agents_error_retrying }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(translations.com_agents_error_server_suggestion);
    await expect(page.getByRole('status', { name: translations.com_agents_loading })).toHaveCount(
      0,
    );
  });

  test('@scenario:focused-card-stays-visible-under-the-retry a focused card is never left under the retry card', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const loaded = makeAgents(36, 0);
    let cursorRequests = 0;

    await routeMarketplace(page, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get('cursor');
      if (cursor == null) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(pageFor(loaded, 'cursor-page-two')),
        });
        return;
      }
      cursorRequests += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'cursor page unavailable' }),
      });
    });

    await page.goto('/agents/all');
    await expect(page.getByRole('button', { name: loaded[0].name })).toBeVisible();

    const frame = page.getByRole('tabpanel').locator('xpath=..');
    /* Reaching the end asks for the next page, which fails, so the recovery card takes
       over while every loaded row is still mounted. */
    await frame.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(page.getByRole('alert')).toContainText(
      translations.com_agents_error_server_title,
      { timeout: 30_000 },
    );
    expect(cursorRequests).toBeGreaterThan(0);

    /* A focused control with no visible focus indication is the failure this guards: the
       card is painted over the rows, so whichever row the reader is on has to end up
       clear of it - at the top of the list, where there is nothing to scroll away, and
       deep in it, where there is. */
    const focusState = async (card: Locator) => {
      await card.focus();
      return card.evaluate((element) => {
        const alert = document.querySelector('[role="alert"]');
        const alertRect = alert?.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return {
          focused: element === document.activeElement,
          covered:
            alertRect != null &&
            rect.top < alertRect.bottom &&
            rect.bottom > alertRect.top &&
            rect.left < alertRect.right &&
            rect.right > alertRect.left,
        };
      });
    };

    await frame.evaluate((element) => {
      element.scrollTop = 0;
    });
    const atTop = await focusState(page.getByRole('button', { name: loaded[0].name }));
    expect(atTop.focused).toBe(true);
    expect(atTop.covered).toBe(false);

    await frame.evaluate((element) => {
      element.scrollTop = Math.round(element.scrollHeight / 2);
    });
    /* The windowed set is mounted around the scroll position, so the first mounted row is
       the one the card would cover where the reader now is. */
    const deepRow = page
      .getByRole('tabpanel')
      .getByRole('listitem')
      .first()
      .getByRole('button')
      .first();
    await expect(deepRow).toBeVisible();
    const deep = await focusState(deepRow);
    expect(deep.focused).toBe(true);
    expect(deep.covered).toBe(false);
  });

  test('@scenario:recovery-hands-focus-back-to-the-results a keyboard retry does not leave focus on the document', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const agent = makeAgent('keyboard-recovery');
    let failing = true;

    await routeMarketplace(page, async (route) => {
      if (failing) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'marketplace unavailable' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(responseFor(agent)),
      });
    });

    await page.goto('/agents/all');
    const retry = page.getByRole('button', { name: translations.com_agents_error_retry });
    await expect(retry).toBeVisible({ timeout: 30_000 });

    /* A retry the reader pressed has two outcomes, and the browser treats them
       differently. The attempt that fails leaves the card mounted, so focus has to stay
       on the control they are using - a `disabled` button would be dropped from focus
       navigation and leave them beside a card they cannot Tab back into. The attempt
       that lands removes the card with the focused control inside it, and the browser
       drops focus on the body, so the results must take it or the next Tab starts at the
       top of the page. jsdom blurs neither, which is why this is stated here. */
    await retry.focus();
    await retry.press('Enter');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(retry).toBeFocused({ timeout: 30_000 });

    /* Whichever attempt lands next is the reader's or the card's own backoff; either way
       it removes the card the focused control is in. */
    failing = false;
    await expect(page.getByRole('button', { name: agent.name })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    const afterRecovery = await page.evaluate(() => {
      const active = document.activeElement;
      const panel = document.querySelector('[role="tabpanel"]');
      return {
        onDocument: active === null || active === document.body,
        inResults: panel != null && active != null && panel.contains(active),
      };
    });
    expect(afterRecovery.onDocument).toBe(false);
    expect(afterRecovery.inResults).toBe(true);
  });
});
