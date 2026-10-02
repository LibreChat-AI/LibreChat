import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { uniqueAgentName } from '../agents.helpers';
import { MOCK_ENDPOINTS, fetchJson, getAccessToken, requestJson } from '../helpers';

type Favorite = {
  agentId?: string;
  model?: string;
  endpoint?: string;
  spec?: unknown;
};

type MarketplaceRow = {
  id: string;
  name?: string | null;
  owner_contact?: { name?: string | null; email?: string | null };
  [key: string]: unknown;
};

type MarketplaceResponse = {
  object: string;
  data: MarketplaceRow[];
  first_id: string | null;
  last_id: string | null;
  has_more: boolean;
  after?: string | null;
};

type ResponseWithStatus<T> = {
  status: number;
  body: T;
};

const DESCRIPTION = 'A marketplace sorting scenario agent.';
const INSTRUCTIONS = 'Respond deterministically for marketplace sorting coverage.';

let createdAgentIds: string[] = [];
let originalFavorites: Favorite[] | undefined;

async function createAgent(page: Page, name: string, token: string) {
  const agent = await requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: DESCRIPTION,
      instructions: INSTRUCTIONS,
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      model_parameters: {},
      category: 'general',
    },
  });
  createdAgentIds.push(agent.id);
  return agent;
}

async function getMarketplace(
  page: Page,
  path: string,
  token: string,
): Promise<ResponseWithStatus<MarketplaceResponse>> {
  const response = await page.request.get(path, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status(), body: (await response.json()) as MarketplaceResponse };
}

async function listCreatedAgents(
  page: Page,
  token: string,
  query: string,
): Promise<MarketplaceResponse> {
  const result = await getMarketplace(page, query, token);
  expect(result.status).toBe(200);
  return result.body;
}

test.describe('marketplace sorting', () => {
  test.describe.configure({ timeout: 90_000 });
  /* `getAccessToken` refreshes through a relative URL from the page, so the tab has to be
     on the app before any of these tests ask for a token. */
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents/all', { timeout: 30_000 });
  });

  test.afterEach(async ({ page }) => {
    const token = await getAccessToken(page).catch(() => undefined);
    if (token) {
      for (const agentId of createdAgentIds.splice(0).reverse()) {
        await requestJson(page, {
          path: `/api/agents/${encodeURIComponent(agentId)}`,
          token,
          method: 'DELETE',
        }).catch(() => undefined);
      }
      if (originalFavorites) {
        await requestJson<Favorite[]>(page, {
          path: '/api/user/settings/favorites',
          token,
          method: 'POST',
          body: { favorites: originalFavorites },
        }).catch(() => undefined);
      }
    } else {
      createdAgentIds = [];
    }
    originalFavorites = undefined;
  });

  test('@scenario:popular-sort-lists-favourites-first popular sort lists favourited agents first and paginates without gaps', async ({
    page,
  }) => {
    const token = await getAccessToken(page);
    const prefix = uniqueAgentName('E2E marketplace popular');
    const agents = [];
    for (let index = 0; index < 5; index++) {
      agents.push(await createAgent(page, `${prefix}-${index}`, token));
    }

    originalFavorites = await fetchJson<Favorite[]>(page, '/api/user/settings/favorites', token);
    const favouriteIds = new Set(agents.slice(0, 2).map((agent) => agent.id));
    const favorites = originalFavorites.slice(0, Math.max(0, 50 - favouriteIds.size));
    for (const agentId of favouriteIds) {
      if (!favorites.some((favorite) => favorite.agentId === agentId)) {
        favorites.push({ agentId });
      }
    }
    await requestJson<Favorite[]>(page, {
      path: '/api/user/settings/favorites',
      token,
      method: 'POST',
      body: { favorites },
    });

    const search = encodeURIComponent(prefix);
    const pagedRows: MarketplaceRow[] = [];
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({ search: prefix, sort: 'popular', limit: '2' });
      if (cursor) {
        params.set('cursor', cursor);
      }
      const result = await getMarketplace(page, `/api/agents?${params.toString()}`, token);
      expect(result.status).toBe(200);
      pagedRows.push(...result.body.data);
      if (result.body.has_more) {
        expect(result.body.after).toBeTruthy();
        cursor = result.body.after ?? undefined;
      } else {
        cursor = undefined;
      }
    } while (cursor);

    const createdIds = new Set(agents.map((agent) => agent.id));
    const pagedIds = pagedRows.filter((agent) => createdIds.has(agent.id)).map((agent) => agent.id);
    expect(pagedIds).toHaveLength(agents.length);
    expect(new Set(pagedIds).size).toBe(agents.length);
    expect(pagedIds.slice(0, 2).every((id) => favouriteIds.has(id))).toBe(true);
    expect(pagedIds.slice(2).every((id) => !favouriteIds.has(id))).toBe(true);

    await page.goto(`/agents/all?sort=popular&q=${search}`, { timeout: 10000 });
    const expectedNames = pagedIds.map((id) => agents.find((agent) => agent.id === id)!.name!);
    const listItems = page.getByRole('listitem');
    await expect
      .poll(
        async () => {
          const names = await listItems.evaluateAll((items) =>
            items
              .map((item) => item.querySelector('h2')?.textContent?.trim())
              .filter((name): name is string => Boolean(name)),
          );
          return expectedNames.filter((name) => names.includes(name)).length;
        },
        { timeout: 30000 },
      )
      .toBe(expectedNames.length);
    const renderedNames = await listItems.evaluateAll((items) =>
      items
        .map((item) => item.querySelector('h2')?.textContent?.trim())
        .filter((name): name is string => Boolean(name)),
    );
    expect(renderedNames.filter((name) => expectedNames.includes(name))).toEqual(expectedNames);
  });

  test('@scenario:author-sort-shows-the-cards-author author sort shows the same author on the card as newest sort', async ({
    page,
  }) => {
    const token = await getAccessToken(page);
    const agentName = uniqueAgentName('E2E marketplace author');
    const agent = await createAgent(page, agentName, token);
    const search = encodeURIComponent(agentName);

    const newest = await listCreatedAgents(
      page,
      token,
      `/api/agents?search=${search}&sort=newest&limit=10`,
    );
    const authorSorted = await listCreatedAgents(
      page,
      token,
      `/api/agents?search=${search}&sort=author&limit=10`,
    );
    const newestRow = newest.data.find((row) => row.id === agent.id);
    const authorRow = authorSorted.data.find((row) => row.id === agent.id);
    expect(newestRow).toBeDefined();
    expect(authorRow).toBeDefined();
    const authorName = newestRow?.owner_contact?.name?.trim();
    expect(authorName).toBeTruthy();
    expect(authorRow?.owner_contact?.name?.trim()).toBe(authorName);
    for (const row of [newestRow!, authorRow!]) {
      expect(row).not.toHaveProperty('_ownerContactResolved');
      expect(row).not.toHaveProperty('favoriteCount');
      expect(row).not.toHaveProperty('authorDisplayName');
    }

    for (const sort of ['newest', 'author']) {
      await page.goto(`/agents/all?sort=${sort}&q=${search}`, { timeout: 10000 });
      const card = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: agentName, exact: true }) })
        .first();
      await expect(card).toBeVisible();
      await expect(card).toContainText(authorName!);
    }
  });

  test('@scenario:unknown-sort-falls-back-to-default-order unknown and repeated sort values fall back to the order the endpoint serves unasked', async ({
    page,
  }) => {
    const token = await getAccessToken(page);
    const prefix = uniqueAgentName('E2E marketplace fallback');
    const first = await createAgent(page, `${prefix}-first`, token);
    const second = await createAgent(page, `${prefix}-second`, token);
    const search = encodeURIComponent(prefix);
    /* The first path names no mode: that is the order the agent selector and the mention
       menu get, and the order an unusable `?sort=` has to keep serving. */
    const paths = [
      `/api/agents?search=${search}&limit=10`,
      `/api/agents?search=${search}&sort=trending&limit=10`,
      `/api/agents?search=${search}&sort=&limit=10`,
      `/api/agents?search=${search}&sort=popular&sort=author&limit=10`,
    ];
    const results = await Promise.all(paths.map((path) => getMarketplace(page, path, token)));
    for (const result of results) {
      expect(result.status).toBe(200);
    }
    const expectedIds = results[0].body.data.map((row) => row.id);
    expect(expectedIds).toHaveLength(2);
    expect(expectedIds).toEqual(expect.arrayContaining([first.id, second.id]));
    for (const result of results.slice(1)) {
      expect(result.body.data.map((row) => row.id)).toEqual(expectedIds);
    }

    await page.goto(`/agents/all?sort=trending&q=${search}`, { timeout: 10000 });
    await expect(page.getByRole('heading', { name: first.name!, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: second.name!, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
