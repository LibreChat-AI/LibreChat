import { ObjectId } from 'mongodb';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { getSecondaryE2EUser, getPrimaryE2EUser } from '../../../setup/users.mock';
import { withMongo } from '../db';
import { uniqueAgentName } from '../agents.helpers';
import { fetchJson, getAccessToken, requestJson } from '../helpers';

type AgentListResponse = {
  data?: Array<{ id: string; name?: string }>;
};

type AgentResponse = {
  id: string;
  name?: string;
};

type CategoryResponse = {
  value: string;
};

const AGENT_DESCRIPTION = 'Agent used by the marketplace mine-filter scenarios.';
const AGENT_INSTRUCTIONS = 'Respond deterministically for the marketplace mine-filter scenarios.';
const AGENT_BODY = {
  description: AGENT_DESCRIPTION,
  instructions: AGENT_INSTRUCTIONS,
  provider: 'Mock Provider A',
  model: 'mock-model-a',
  model_parameters: {},
};

async function createAgent(page: Page, name: string): Promise<AgentResponse> {
  const token = await getAccessToken(page);
  return requestJson<AgentResponse>(page, {
    path: '/api/agents',
    token,
    method: 'POST',
    body: { name, ...AGENT_BODY },
  });
}

/** Seed the shared row directly because a second browser session is not needed for this contract. */
async function seedSharedAgent(primaryAgentId: string, sharedName: string): Promise<string> {
  return withMongo(async (db) => {
    const agents = db.collection('agents');
    const users = db.collection('users');
    const aclEntries = db.collection('aclentries');
    const primaryAgent = await agents.findOne({ id: primaryAgentId });
    const primaryUser = await users.findOne({ email: getPrimaryE2EUser().email });
    if (!primaryAgent || !primaryUser) {
      throw new Error('Expected the primary marketplace agent and user to exist');
    }

    let secondaryUser = await users.findOne({ email: getSecondaryE2EUser().email });
    if (!secondaryUser) {
      const now = new Date();
      secondaryUser = {
        _id: new ObjectId(),
        email: getSecondaryE2EUser().email,
        name: getSecondaryE2EUser().name,
        tenantId: primaryAgent.tenantId,
        role: primaryUser.role,
        createdAt: now,
        updatedAt: now,
      };
      await users.insertOne(secondaryUser);
    }

    const ownerAcl = await aclEntries.findOne({
      resourceType: 'agent',
      resourceId: primaryAgent._id,
      principalType: 'user',
      principalId: primaryUser._id,
      permBits: 15,
    });
    if (!ownerAcl) {
      throw new Error('Expected the primary-created agent to have an owner ACL entry');
    }

    const { _id: ignoredOwnerAclId, ...aclFields } = ownerAcl;
    void ignoredOwnerAclId;
    const sharedObjectId = new ObjectId();
    const sharedAgentId = `agent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const { _id: ignoredPrimaryAgentId, ...agentFields } = primaryAgent;
    void ignoredPrimaryAgentId;
    const now = new Date();

    await agents.insertOne({
      ...agentFields,
      _id: sharedObjectId,
      id: sharedAgentId,
      name: sharedName,
      author: secondaryUser._id,
      tenantId: primaryAgent.tenantId,
      is_promoted: false,
      createdAt: now,
      updatedAt: now,
    });

    await aclEntries.insertOne({
      ...aclFields,
      _id: new ObjectId(),
      resourceId: sharedObjectId,
      principalId: secondaryUser._id,
      grantedBy: secondaryUser._id,
      permBits: 15,
      createdAt: now,
      updatedAt: now,
    });

    const viewerRole = await db.collection('accessroles').findOne({
      accessRoleId: 'agent_viewer',
      tenantId: ownerAcl.tenantId,
    });
    const { roleId: ignoredOwnerRoleId, ...viewerAclFields } = aclFields;
    void ignoredOwnerRoleId;
    await aclEntries.insertOne({
      ...viewerAclFields,
      _id: new ObjectId(),
      resourceId: sharedObjectId,
      principalId: primaryUser._id,
      permBits: viewerRole?.permBits ?? 1,
      ...(viewerRole?._id ? { roleId: viewerRole._id } : {}),
      grantedBy: secondaryUser._id,
      createdAt: now,
      updatedAt: now,
    });

    return sharedAgentId;
  });
}

/** Remove the exact agent and ACL records this spec created, even after a failed API cleanup. */
async function cleanupAgents(agentIds: string[]): Promise<void> {
  const ids = agentIds.filter(Boolean);
  if (ids.length === 0) {
    return;
  }
  await withMongo(async (db) => {
    const agents = await db
      .collection('agents')
      .find({ id: { $in: ids } }, { projection: { _id: 1 } })
      .toArray();
    const resourceIds = agents.map((agent) => agent._id);
    if (resourceIds.length > 0) {
      await db.collection('aclentries').deleteMany({ resourceId: { $in: resourceIds } });
    }
    await db.collection('agents').deleteMany({ id: { $in: ids } });
  });
}

async function fetchAgentNames(page: Page, query: string): Promise<Set<string>> {
  const token = await getAccessToken(page);
  const response = await fetchJson<AgentListResponse>(page, `/api/agents?${query}`, token);
  return new Set(
    (response.data ?? []).map((agent) => agent.name).filter((name): name is string => !!name),
  );
}

async function expectMarketplaceAgent(page: Page, name: string, visible: boolean): Promise<void> {
  const heading = page.getByRole('heading', { name, exact: true });
  if (visible) {
    await expect(heading).toBeVisible({ timeout: 30000 });
  } else {
    await expect(heading).toHaveCount(0);
  }
}

test.describe('marketplace mine filter', () => {
  /* `getAccessToken` refreshes through a relative URL from the page, so the tab has to be
     on the app before either test asks for a token. */
  test.beforeEach(async ({ page }) => {
    await page.goto('/agents/all', { timeout: 30_000 });
  });

  test("@scenario:mine-filter-narrows-to-the-callers-agents mine=1 narrows the API and marketplace to the caller's agents", async ({
    page,
  }) => {
    test.setTimeout(120000);

    const mineName = uniqueAgentName('E2E Mine Filter Mine');
    const sharedName = uniqueAgentName('E2E Mine Filter Shared');
    const createdAgentIds: string[] = [];

    try {
      const mineAgent = await createAgent(page, mineName);
      createdAgentIds.push(mineAgent.id);
      const sharedAgentId = await seedSharedAgent(mineAgent.id, sharedName);
      createdAgentIds.push(sharedAgentId);

      /* The "all" tab sends no category at all (`AgentGrid.tsx`'s query params); passing
         `category=all` would filter for a category literally named "all" and match nothing. */
      const commonQuery = `search=${encodeURIComponent('E2E Mine Filter')}&limit=100`;
      const allNames = await fetchAgentNames(page, commonQuery);
      const mineNames = await fetchAgentNames(page, `${commonQuery}&mine=1`);
      const mineZeroNames = await fetchAgentNames(page, `${commonQuery}&mine=0`);
      const mineTrueNames = await fetchAgentNames(page, `${commonQuery}&mine=true`);
      const mineMissingNames = await fetchAgentNames(page, commonQuery);

      expect([...allNames]).toEqual(expect.arrayContaining([mineName, sharedName]));
      expect(mineNames.has(mineName)).toBe(true);
      expect(mineNames.has(sharedName)).toBe(false);
      for (const names of [mineZeroNames, mineTrueNames, mineMissingNames]) {
        expect([...names]).toEqual(expect.arrayContaining([mineName, sharedName]));
      }

      const search = encodeURIComponent('E2E Mine Filter');
      await page.goto(`/agents/all?q=${search}`, { timeout: 10000 });
      await expectMarketplaceAgent(page, mineName, true);
      await expectMarketplaceAgent(page, sharedName, true);

      const mineToggle = page.getByRole('button', { name: /My Agents/i });
      await expect(mineToggle).toHaveAttribute('aria-pressed', 'false');
      await mineToggle.click();
      await expect(mineToggle).toHaveAttribute('aria-pressed', 'true');
      await expectMarketplaceAgent(page, mineName, true);
      await expectMarketplaceAgent(page, sharedName, false);
    } finally {
      await cleanupAgents(createdAgentIds);
    }
  });

  test('@scenario:mine-link-opens-on-the-callers-agents direct mine links use All instead of the promoted category', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120000);
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for marketplace mock tests');
    }

    const mineName = uniqueAgentName('E2E Mine Link Mine');
    const promotedName = uniqueAgentName('E2E Mine Link Promoted Seed');
    const createdAgentIds: string[] = [];

    try {
      const mineAgent = await createAgent(page, mineName);
      createdAgentIds.push(mineAgent.id);
      const promotedSeed = await createAgent(page, promotedName);
      createdAgentIds.push(promotedSeed.id);

      const token = await getAccessToken(page);
      const categoriesBefore = await fetchJson<CategoryResponse[]>(
        page,
        '/api/agents/categories',
        token,
      );
      if (!categoriesBefore.some((category) => category.value === 'promoted')) {
        await withMongo(async (db) => {
          await db
            .collection('agents')
            .updateOne({ id: promotedSeed.id }, { $set: { is_promoted: true } });
        });
      }
      const categoriesAfter = await fetchJson<CategoryResponse[]>(
        page,
        '/api/agents/categories',
        token,
      );
      expect(categoriesAfter.some((category) => category.value === 'promoted')).toBe(true);

      const search = encodeURIComponent('E2E Mine Link Mine');
      // Pins Marketplace.tsx: `/agents?mine=1` must resolve to `all`, not promoted.
      await page.goto(`/agents?mine=1&q=${search}`, { timeout: 10000 });
      await expectMarketplaceAgent(page, mineName, true);
      const allTab = page.getByRole('tab', { name: /All/i });
      await expect(allTab).toHaveAttribute('aria-selected', 'true');

      /* The category the user is looking at has to survive both transitions: turning the
         filter off must not hand the view back to Top Picks, and choosing Top Picks must
         actually select it rather than resolving to All again. */
      const mineFromLink = page.getByRole('button', { name: /My Agents/i });
      await mineFromLink.click();
      await expect(mineFromLink).toHaveAttribute('aria-pressed', 'false');
      await expect(allTab).toHaveAttribute('aria-selected', 'true');

      await page.goto(`/agents?mine=1&q=${search}`, { timeout: 10000 });
      await expect(allTab).toHaveAttribute('aria-selected', 'true');
      const topPicksTab = page.getByRole('tab', { name: /Top Picks/i });
      await topPicksTab.click();
      await expect(topPicksTab).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('button', { name: /My Agents/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      );

      await page.goto(`/agents?q=${search}`, { timeout: 10000 });
      await expect(page.getByRole('tab', { name: /Top Picks/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const mineToggle = page.getByRole('button', { name: /My Agents/i });
      await mineToggle.click();
      await expect(page).toHaveURL(
        /\/agents\/all\?q=E2E(?:%20|\+)Mine(?:%20|\+)Link(?:%20|\+)Mine&mine=1/,
      );
      await expectMarketplaceAgent(page, mineName, true);
      await expect(page.getByRole('tab', { name: /All/i })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    } finally {
      await cleanupAgents(createdAgentIds);
    }
  });
});
