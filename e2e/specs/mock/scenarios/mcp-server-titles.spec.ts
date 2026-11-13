import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { openAgentBuilder } from '../agents.helpers';

/** `librechat.e2e.yaml` gives this server a `title` that differs from its key. */
const SERVER_KEY = 'e2e-memory';
const SERVER_TITLE = 'E2E Memory';

async function openToolLibrary(page: Page): Promise<{ form: Locator; library: Locator }> {
  const form = await openAgentBuilder(page);
  await form.getByRole('button', { name: 'Add tools', exact: true }).click();
  const library = page.getByRole('dialog', { name: 'Tool Library', exact: true });
  await expect(library).toBeVisible();
  return { form, library };
}

/** A card is a toggle button whose accessible name starts with the item's label. */
function card(library: Locator, label: string): Locator {
  return library.getByRole('button', { name: new RegExp(`^${label}`) });
}

function search(library: Locator): Locator {
  return library.getByRole('textbox', { name: 'Search tools…' });
}

test.describe('MCP server titles in the Tool Library', () => {
  test('@scenario:tool-library-card-shows-mcp-title an MCP card is labelled with the server title, not its key', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const { library } = await openToolLibrary(page);

    await expect(card(library, SERVER_TITLE)).toBeVisible();
    await expect(card(library, SERVER_KEY)).toHaveCount(0);
  });

  test('@scenario:tool-library-search-matches-mcp-title-and-key searching by the title or the key finds the server', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const { library } = await openToolLibrary(page);

    await search(library).fill(SERVER_TITLE);
    await expect(card(library, SERVER_TITLE)).toBeVisible();

    await search(library).fill(SERVER_KEY);
    await expect(card(library, SERVER_TITLE)).toBeVisible();
  });

  test('@scenario:agent-tool-row-shows-mcp-title an added MCP server is listed on the agent by its title', async ({
    page,
  }) => {
    test.setTimeout(120000);
    const { form, library } = await openToolLibrary(page);

    const server = card(library, SERVER_TITLE);
    await server.click();
    await expect(server).toHaveAttribute('aria-pressed', 'true');
    await library.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(library).toBeHidden();

    const row = form
      .getByRole('listitem')
      .filter({ has: page.getByText(SERVER_TITLE, { exact: true }) });
    await expect(row).toBeVisible();
    await expect(form.getByText(SERVER_KEY, { exact: true })).toHaveCount(0);
  });
});
