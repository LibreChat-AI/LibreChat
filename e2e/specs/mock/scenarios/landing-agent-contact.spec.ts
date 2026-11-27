import type { Page, Route } from '@playwright/test';
import type { AgentDetail } from '../agents.helpers';
import { MOCK_ENDPOINTS, NEW_CHAT_PATH, getAccessToken, requestJson } from '../helpers';
import { cleanupAgent, uniqueAgentName } from '../agents.helpers';
import { test, expect } from '../fixtures';

type SupportContact = { name?: string; email?: string };
type ListedAgent = { id?: string; support_contact?: SupportContact; owner_contact?: unknown };

const createAgent = async (page: Page, name: string, support_contact?: SupportContact) => {
  const token = await getAccessToken(page);
  return requestJson<AgentDetail>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: {
      name,
      description: `${name} landing description`,
      instructions: 'Keep this fixture deterministic.',
      provider: MOCK_ENDPOINTS[0].label,
      model: MOCK_ENDPOINTS[0].model,
      ...(support_contact ? { support_contact } : {}),
    },
  });
};

/**
 * The server omits `owner_contact` when the owner's name and username are email-shaped, which
 * is the common case for accounts whose display name defaults to their address. The signed-in
 * e2e user has a plain name, so the list and single-agent reads drop the owner contact for this
 * agent to reach that state.
 */
const dropOwnerContact = (page: Page, agentId: string) =>
  page.route(
    (url) => url.pathname === '/api/agents' || url.pathname === `/api/agents/${agentId}`,
    async (route: Route) => {
      if (route.request().method() !== 'GET') {
        return route.fallback();
      }
      const response = await route.fetch();
      const body = (await response.json()) as ListedAgent & { data?: ListedAgent[] };
      for (const agent of [body, ...(body.data ?? [])]) {
        if (agent.id === agentId) {
          delete agent.owner_contact;
        }
      }
      await route.fulfill({ response, json: body });
    },
  );

const openAgentLanding = async (page: Page, agentId: string, name: string) => {
  await page.goto(`${NEW_CHAT_PATH}?agent_id=${encodeURIComponent(agentId)}`, {
    timeout: 10000,
  });
  await expect(page.getByText(`${name} landing description`, { exact: true })).toBeVisible({
    timeout: 30000,
  });
};

test.describe('landing agent contact', () => {
  test('an agent without a contact shows no contact row on the landing page @scenario:landing-hides-contact-row-without-contact', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Landing No Contact');
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgent(page, name);
      agentId = agent.id;
      await dropOwnerContact(page, agentId);

      await openAgentLanding(page, agentId, name);

      await expect(page.getByText('Contact:', { exact: true })).toBeHidden();
      await expect(page.getByText('No contact available', { exact: true })).toBeHidden();
    } finally {
      await cleanupAgent(page, agentId);
    }
  });

  test('an agent with a support contact keeps its contact link on the landing page @scenario:landing-keeps-support-contact-link', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const name = uniqueAgentName('E2E Landing Support Contact');
    const email = 'landing-support@example.com';
    let agentId: string | undefined;

    try {
      await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
      const agent = await createAgent(page, name, { name: 'Landing Support Desk', email });
      agentId = agent.id;

      await openAgentLanding(page, agentId, name);

      await expect(page.getByText('Contact:', { exact: true })).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Landing Support Desk', exact: true }),
      ).toHaveAttribute('href', `mailto:${email}`);
    } finally {
      await cleanupAgent(page, agentId);
    }
  });
});
