import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';
import { expect, test } from '../fixtures';

const SHAREPOINT_ORIGIN = 'https://contoso.sharepoint.example';

/**
 * The server issues the Graph token and it dies an hour later, but the chat page, and the picker
 * mounted in it, can stay open for days. The picker used to hand SharePoint the token cached when
 * the page loaded, so after an hour it failed to authenticate until the page was reloaded.
 *
 * The server is the token authority here: every call issues the next token, which stands for the
 * one from page load having expired by the time the user opens the picker.
 */

/** The picker page SharePoint serves: it hands the app a MessagePort, asks for a token, reports the answer. */
const PICKER_PAGE = `<!doctype html><html><body><script>
  const options = JSON.parse(new URLSearchParams(location.search).get('filePicker'));
  const channel = new MessageChannel();
  window.parent.postMessage(
    { type: 'initialize', channelId: options.messaging.channelId },
    options.messaging.origin,
    [channel.port2],
  );
  channel.port1.onmessage = (event) => {
    const message = event.data;
    if (message.type === 'activate') {
      channel.port1.postMessage({ type: 'command', id: '1', data: { command: 'authenticate' } });
    }
    if (message.type === 'result' && message.id === '1') {
      fetch('/answered?token=' + encodeURIComponent(message.data.token));
    }
  };
</script></body></html>`;

interface Tokens {
  issued: number;
  failing: boolean;
}

/** What SharePoint received: the token the picker was opened with, and the tokens it was answered with. */
interface Received {
  opened: string[];
  answered: string[];
}

async function enableSharePoint(page: Page, tokens: Tokens): Promise<Received> {
  const received: Received = { opened: [], answered: [] };
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: {
        ...config,
        sharePointFilePickerEnabled: true,
        sharePointBaseUrl: SHAREPOINT_ORIGIN,
        sharePointPickerGraphScope: 'Files.Read.All',
        sharePointPickerSharePointScope: `${SHAREPOINT_ORIGIN}/.default`,
      },
    });
  });
  await page.route('**/api/user', async (route) => {
    const response = await route.fetch();
    const user = await response.json();
    await route.fulfill({ response, json: { ...user, provider: 'openid' } });
  });
  await page.route('**/api/auth/graph-token*', (route) =>
    tokens.failing
      ? route.fulfill({ status: 500, json: { message: 'Failed to obtain Microsoft Graph token' } })
      : route.fulfill({
          json: {
            access_token: `token-${++tokens.issued}`,
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'x',
          },
        }),
  );
  await page.route(`${SHAREPOINT_ORIGIN}/**`, (route) => {
    const request = route.request();
    const { pathname, searchParams } = new URL(request.url());
    if (pathname === '/answered') {
      received.answered.push(searchParams.get('token') ?? '');
      return route.fulfill({ status: 204 });
    }
    received.opened.push(new URLSearchParams(request.postData() ?? '').get('access_token') ?? '');
    return route.fulfill({ contentType: 'text/html', body: PICKER_PAGE });
  });
  return received;
}

/** The page after it has loaded, with the token the picker prefetched on mount cached. */
async function loadChat(page: Page, tokens: Tokens): Promise<number> {
  await page.goto(NEW_CHAT_PATH);
  await expect.poll(() => tokens.issued).toBeGreaterThan(0);
  return tokens.issued;
}

async function chooseSharePoint(page: Page) {
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  await page.getByRole('button', { name: 'More upload options' }).click();
  await page
    .getByRole('button', { name: /From SharePoint/ })
    .first()
    .click();
}

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });

test('the SharePoint picker gets a Graph token issued when it opens, not the one from page load @scenario:sharepoint-picker-uses-a-current-token', async ({
  page,
}) => {
  test.setTimeout(60000);
  const tokens: Tokens = { issued: 0, failing: false };
  const received = await enableSharePoint(page, tokens);
  const atLoad = await loadChat(page, tokens);

  await chooseSharePoint(page);

  await expect.poll(() => received.answered.length).toBe(1);
  expect(received.opened).toEqual([`token-${atLoad + 1}`]);
  expect(received.answered).toEqual([`token-${atLoad + 2}`]);
});

test('the SharePoint picker says so when no new Graph token can be issued, rather than opening on the old one @scenario:sharepoint-picker-reports-an-unavailable-token', async ({
  page,
}) => {
  test.setTimeout(60000);
  const tokens: Tokens = { issued: 0, failing: false };
  const received = await enableSharePoint(page, tokens);
  await loadChat(page, tokens);
  tokens.failing = true;

  await chooseSharePoint(page);

  await expect(
    page.getByText('Unable to access SharePoint. Please ensure you are logged in with Microsoft.', {
      exact: true,
    }),
  ).toBeVisible();
  expect(received.opened).toEqual([]);
});
