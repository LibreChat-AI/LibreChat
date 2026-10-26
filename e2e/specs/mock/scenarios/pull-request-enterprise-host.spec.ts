import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { deleteConversations, seedConversations, withMongo } from '../db';
import { getPrimaryE2EUser } from '../../../setup/users.mock';

/**
 * Pull request lookups against a GitHub Enterprise host. The mock config sets
 * `endpoints.agents.pullRequests.host` to the fake host `e2e/setup/fake-git-host-server.js`
 * serves over TLS, so a code conversation whose lane names a branch with an open pull request
 * shows it in the chat header, read from that host and linking to that host's page. The host
 * decides where the deployment's token goes, so a principal config override cannot move it.
 */

const GIT_HOST = `localhost:${process.env.E2E_GIT_HOST_PORT || '8793'}`;
const REPO = 'e2e-org/e2e-app';

type Lane = { branch: string; head: string; title: string; number: number };

/** Branches and heads `fake-git-host-server.js` serves an open pull request for. */
const HEADER_LANE: Lane = {
  branch: 'feat/enterprise-header',
  head: 'a'.repeat(40),
  title: 'Enterprise header pull request',
  number: 7,
};
const OVERRIDE_LANE: Lane = {
  branch: 'feat/override-ignored',
  head: 'b'.repeat(40),
  title: 'Override ignored pull request',
  number: 8,
};

test.use({ viewport: { width: 1280, height: 800 } });

/** A conversation that ran in an attached workspace, with the lane the worker last reported. */
async function seedCodeConversation(lane: Lane): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getPrimaryE2EUser();
  await seedConversations(email, [
    { conversationId, title: `Lane ${lane.branch}`, updatedAt: new Date() },
  ]);
  await withMongo(async (db) => {
    await db.collection('conversations').updateOne(
      { conversationId },
      {
        $set: {
          codeEnvironmentMode: 'attached',
          laneGit: { branch: lane.branch, head: lane.head, repo: REPO, seq: 1 },
        },
      },
    );
  });
  return conversationId;
}

type SeenRequest = { method: string; path: string; authorized: boolean };

async function gitHostRequests(request: APIRequestContext): Promise<SeenRequest[]> {
  const res = await request.get(`https://${GIT_HOST}/__requests`, { ignoreHTTPSErrors: true });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as SeenRequest[];
}

/** Opens the conversation and the pull request card under its header chip. */
async function openHeaderCard(page: Page, conversationId: string, lane: Lane) {
  await page.goto(`/c/${conversationId}`);
  const chip = page.getByTestId('header-pull-request-button');
  await expect(chip).toBeVisible({ timeout: 30000 });
  await expect(chip).toContainText(lane.title);
  await chip.focus();
  const card = page.getByRole('dialog', { name: 'Pull request' });
  await expect(card).toBeVisible();
  await expect(card.getByText(`PR #${lane.number}`)).toBeVisible();
  return card;
}

test.describe('Pull requests on a GitHub Enterprise host', () => {
  test.describe.configure({ mode: 'serial' });

  /** Waits for the config cache and a lookup, so a failure reports its assertion, not a timeout. */
  test.setTimeout(120_000);

  const seeded: string[] = [];
  let overriddenUser: string | undefined;

  test.afterAll(async () => {
    await deleteConversations(seeded);
    if (overriddenUser != null) {
      const principalId = overriddenUser;
      await withMongo((db) => db.collection('configs').deleteMany({ principalId }));
    }
  });

  test('a code conversation shows its pull request from the configured host @scenario:enterprise-host-pull-request-appears-in-header', async ({
    page,
    request,
  }) => {
    const conversationId = await seedCodeConversation(HEADER_LANE);
    seeded.push(conversationId);

    const card = await openHeaderCard(page, conversationId, HEADER_LANE);
    await expect(card.getByRole('link', { name: 'Open in GitHub' })).toHaveAttribute(
      'href',
      `https://${GIT_HOST}/${REPO}/pull/${HEADER_LANE.number}`,
    );

    const seen = await gitHostRequests(request);
    const lookups = seen.filter((entry) =>
      entry.path.includes(encodeURIComponent(HEADER_LANE.branch)),
    );
    expect(lookups.length).toBeGreaterThan(0);
    expect(lookups.every((entry) => entry.path.startsWith(`/api/v3/repos/${REPO}/`))).toBe(true);
    expect(seen.every((entry) => entry.authorized)).toBe(true);
  });

  test('a principal override naming another host does not move the lookup @scenario:role-override-cannot-move-pull-request-host', async ({
    page,
    request,
  }) => {
    const user = getPrimaryE2EUser();
    const login = await request.post('/api/auth/login', {
      data: { email: user.email, password: user.password },
    });
    expect(login.ok()).toBeTruthy();
    const { token, user: body } = (await login.json()) as {
      token: string;
      user: { id?: string; _id?: string };
    };
    const userId = (body.id ?? body._id) as string;
    overriddenUser = userId;
    const headers = { Authorization: `Bearer ${token}` };
    const overridePath = `/api/admin/config/user/${userId}`;
    const marker = `pull-request-override-${Date.now()}`;

    const stored = await request.put(overridePath, {
      headers,
      data: {
        overrides: {
          interface: { customWelcome: marker },
          endpoints: { agents: { pullRequests: { host: 'pull-requests.e2e.invalid' } } },
        },
      },
    });
    expect(stored.ok()).toBeTruthy();
    try {
      /** The override as a whole applies, so only the host is held back. */
      await expect
        .poll(
          async () => {
            const res = await request.get('/api/config', { headers });
            const config = (await res.json()) as { interface?: { customWelcome?: string } };
            return config.interface?.customWelcome;
          },
          { timeout: 30000, intervals: [500, 1000, 2000] },
        )
        .toBe(marker);

      const conversationId = await seedCodeConversation(OVERRIDE_LANE);
      seeded.push(conversationId);
      const card = await openHeaderCard(page, conversationId, OVERRIDE_LANE);
      await expect(card.getByRole('link', { name: 'Open in GitHub' })).toHaveAttribute(
        'href',
        `https://${GIT_HOST}/${REPO}/pull/${OVERRIDE_LANE.number}`,
      );

      const seen = await gitHostRequests(request);
      expect(
        seen.some((entry) => entry.path.includes(encodeURIComponent(OVERRIDE_LANE.branch))),
      ).toBe(true);
    } finally {
      const cleared = await request.delete(overridePath, { headers });
      expect([200, 204, 404]).toContain(cleared.status());
    }
  });
});
