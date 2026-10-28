import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const baseURL = new URL(process.env.E2E_BASE_URL as string);
baseURL.pathname = baseURL.pathname.replace(/\/?$/, '/');

const newChatURL = new URL('c/new', baseURL);
const configuredModel = process.env.E2E_DEPLOYED_MODEL?.trim();
const prompt = process.env.E2E_DEPLOYED_PROMPT?.trim() || 'Reply with exactly DEPLOYED_E2E_OK.';

type PersistedMessage = {
  messageId?: string;
  parentMessageId?: string;
  isCreatedByUser?: boolean;
  unfinished?: boolean;
  error?: boolean;
  endpoint?: string;
  thread_id?: string;
  text?: string;
  content?: Array<{ type?: string }>;
};

async function selectConfiguredModel(page: Page) {
  const modelSelector = page.getByTestId('model-selector-button');
  const selectorIsVisible = await modelSelector
    .waitFor({ state: 'visible', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (!selectorIsVisible) {
    if (configuredModel) {
      throw new Error(
        '[e2e:deployed] E2E_DEPLOYED_MODEL cannot be applied because this deployment hides model selection.',
      );
    }
    return;
  }

  if (configuredModel) {
    if ((await modelSelector.textContent())?.trim() === configuredModel) {
      return;
    }
    await modelSelector.click();
    await page.locator('#model-search').fill(configuredModel);
    await page.getByRole('option', { name: configuredModel, exact: true }).first().click();
    await expect(modelSelector).toContainText(configuredModel);
  }
}

function conversationIdFromURL(url: string) {
  const match = new URL(url).pathname.match(/\/c\/([^/]+)\/?$/);
  const conversationId = match?.[1];
  return conversationId && conversationId !== 'new'
    ? decodeURIComponent(conversationId)
    : undefined;
}

async function loadAuthenticatedApp(page: Page) {
  await page.addInitScript((appOrigin) => {
    if (location.origin !== appOrigin) {
      return;
    }
    /** The persistence probe must not inherit a dedicated account's temporary-chat default.
     * These changes live only in this browser context; the storage-state file is never rewritten. */
    localStorage.setItem('isTemporary', 'false');
    localStorage.setItem('defaultTemporaryChat', 'false');
  }, baseURL.origin);
  await page.goto(newChatURL.toString(), { waitUntil: 'domcontentloaded' });

  const input = page.getByTestId('text-input');
  try {
    await expect(input).toBeVisible({ timeout: 20_000 });
  } catch (error) {
    const currentURL = new URL(page.url());
    if (currentURL.origin !== baseURL.origin || currentURL.pathname.includes('/login')) {
      throw new Error(
        `[e2e:deployed] Authentication state is missing or expired; the deployment redirected to ${currentURL.origin}.`,
        { cause: error },
      );
    }
    throw error;
  }

  expect(new URL(page.url()).origin).toBe(baseURL.origin);
  await expect(page).toHaveURL(/\/c\/new\/?$/);
  return input;
}

async function getAccessToken(page: Page) {
  const result = await page.evaluate(async (appBaseURL) => {
    const response = await fetch(new URL('api/auth/refresh', appBaseURL), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = (await response.json().catch(() => null)) as { token?: string } | null;
    return { ok: response.ok, status: response.status, token: body?.token };
  }, baseURL.toString());

  if (!result.ok || !result.token) {
    throw new Error(
      `[e2e:deployed] Token refresh failed before the persistence check (${result.status}).`,
    );
  }
  return result.token;
}

async function getPersistedMessages(page: Page, conversationId: string, token: string) {
  return page.evaluate(
    async ({ appBaseURL, id, accessToken }) => {
      const response = await fetch(new URL(`api/messages/${encodeURIComponent(id)}`, appBaseURL), {
        credentials: 'include',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        return { status: response.status };
      }
      return { status: response.status, messages: (await response.json()) as PersistedMessage[] };
    },
    { appBaseURL: baseURL.toString(), id: conversationId, accessToken: token },
  );
}

async function deleteConversation(page: Page, conversationId: string) {
  const result = await page.evaluate(
    async ({ appBaseURL, id }) => {
      const signal = AbortSignal.timeout(15_000);
      const refreshResponse = await fetch(new URL('api/auth/refresh', appBaseURL), {
        method: 'POST',
        credentials: 'include',
        signal,
      });
      if (!refreshResponse.ok) {
        return { ok: false, step: 'refresh', status: refreshResponse.status };
      }

      const { token } = (await refreshResponse.json()) as { token?: string };
      if (!token) {
        return {
          ok: false,
          step: 'refresh-token',
          status: refreshResponse.status,
        };
      }

      const messagesResponse = await fetch(
        new URL(`api/messages/${encodeURIComponent(id)}`, appBaseURL),
        {
          credentials: 'include',
          headers: { Authorization: `Bearer ${token}` },
          signal,
        },
      );
      if (!messagesResponse.ok) {
        return { ok: false, step: 'messages', status: messagesResponse.status };
      }
      const messages = (await messagesResponse.json()) as PersistedMessage[];
      const latestMessageWithEndpoint = messages
        .slice()
        .reverse()
        .find((message) => message.endpoint);
      const latestMessageWithThread = messages
        .slice()
        .reverse()
        .find((message) => message.thread_id);

      const deleteResponse = await fetch(new URL('api/convos', appBaseURL), {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        signal,
        body: JSON.stringify({
          arg: {
            conversationId: id,
            endpoint: latestMessageWithEndpoint?.endpoint,
            thread_id: latestMessageWithThread?.thread_id,
            source: 'e2e-deployed',
          },
        }),
      });
      return {
        ok: deleteResponse.ok,
        step: 'delete',
        status: deleteResponse.status,
      };
    },
    { appBaseURL: baseURL.toString(), id: conversationId },
  );

  if (!result.ok) {
    throw new Error(
      `[e2e:deployed] Conversation cleanup failed during ${result.step} (${result.status}).`,
    );
  }
}

let createdConversationId: string | undefined;

test.describe('deployed LibreChat smoke', () => {
  test.beforeEach(() => {
    createdConversationId = undefined;
  });

  /** Hooks receive a separate timeout budget after a timed-out test, so cleanup still runs. */
  test.afterEach(async ({ page }) => {
    if (createdConversationId) {
      await deleteConversation(page, createdConversationId);
    }
  });

  test('loads the authenticated shell and persists a real conversation', async ({ page }) => {
    test.setTimeout(240_000);
    const input = await loadAuthenticatedApp(page);

    await selectConfiguredModel(page);

    const messageBodies = page.getByTestId('message-body');
    const initialMessageCount = await messageBodies.count();
    await input.fill(prompt);

    const sendButton = page.getByTestId('send-button');
    const canSubmit = await expect(sendButton)
      .toBeEnabled({ timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!canSubmit) {
      throw new Error(
        '[e2e:deployed] The prompt cannot be submitted. Set E2E_DEPLOYED_MODEL when the account has no default model.',
      );
    }

    await Promise.all([
      page.waitForURL((url) => conversationIdFromURL(url.toString()) != null, {
        timeout: 30_000,
      }),
      sendButton.click(),
    ]);
    createdConversationId = conversationIdFromURL(page.url());
    expect(createdConversationId).toBeTruthy();

    await expect(messageBodies.getByText(prompt, { exact: true })).toBeVisible();
    let accessToken = await getAccessToken(page);
    await expect
      .poll(
        async () => {
          let result = await getPersistedMessages(
            page,
            createdConversationId as string,
            accessToken,
          );
          if (result.status === 401) {
            accessToken = await getAccessToken(page);
            result = await getPersistedMessages(page, createdConversationId as string, accessToken);
          }
          if (!result.messages) {
            return false;
          }
          const messages = result.messages;
          const userMessageIds = new Set(
            messages
              .filter((message) => message.isCreatedByUser === true)
              .map((message) => message.messageId),
          );
          const assistantMessages = messages.filter(
            (message) =>
              message.isCreatedByUser === false &&
              message.parentMessageId != null &&
              userMessageIds.has(message.parentMessageId),
          );
          return (
            userMessageIds.size > 0 &&
            assistantMessages.length > 0 &&
            assistantMessages.every(
              (message) =>
                message.unfinished === false &&
                message.error !== true &&
                message.content?.some((part) => part.type === 'error') !== true,
            )
          );
        },
        {
          timeout: 90_000,
          intervals: [500, 1_000, 2_000],
          message: 'assistant response should be durably finalized and error-free',
        },
      )
      .toBe(true);
    await expect
      .poll(() => messageBodies.count(), { timeout: 10_000 })
      .toBeGreaterThan(initialMessageCount + 1);
    await expect(messageBodies.last()).not.toBeEmpty();
    await expect(messageBodies.getByRole('alert')).toHaveCount(0);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(messageBodies.getByText(prompt, { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(() => messageBodies.count(), { timeout: 30_000 })
      .toBeGreaterThan(initialMessageCount + 1);
  });
});
