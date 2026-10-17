import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { NEW_CHAT_PATH } from '../helpers';

const SHAREPOINT_ORIGIN = 'https://contoso.sharepoint.example';
const DOWNLOAD_URL = 'https://download.example.test/secret-contract.pdf';
const SECRET_FILE_NAME = 'secret-contract-q3.pdf';
const SECRET_TOKEN = 'graph-token-must-not-be-logged';

/** The picker page SharePoint serves: it hands the app a MessagePort, then plays the picker's side. */
const PICKER_PAGE = `<!doctype html><html><body><script>
  const options = JSON.parse(new URLSearchParams(location.search).get('filePicker'));
  const channel = new MessageChannel();
  window.parent.postMessage(
    { type: 'initialize', channelId: options.messaging.channelId },
    options.messaging.origin,
    [channel.port2],
  );
  channel.port1.onmessage = (event) => {
    if (event.data.type !== 'activate') return;
    channel.port1.postMessage({ type: 'notification', data: { note: '${SECRET_FILE_NAME}' } });
    channel.port1.postMessage({ type: 'command', id: '1', data: { command: 'authenticate' } });
    channel.port1.postMessage({
      type: 'command',
      id: '2',
      data: {
        command: 'pick',
        items: [{ id: 'item-1', name: '${SECRET_FILE_NAME}', downloadUrl: '${DOWNLOAD_URL}' }],
      },
    });
  };
</script></body></html>`;

async function enableSharePoint(page: Page) {
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
    route.fulfill({
      json: { access_token: SECRET_TOKEN, token_type: 'Bearer', expires_in: 3600, scope: 'x' },
    }),
  );
  await page.route(`${SHAREPOINT_ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: PICKER_PAGE }),
  );
  await page.route(DOWNLOAD_URL, (route) => route.fulfill({ status: 500, body: 'unavailable' }));
}

test.use({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });

test('picking SharePoint files keeps file names and tokens out of the console @scenario:sharepoint-picker-keeps-payloads-out-of-console', async ({
  page,
}) => {
  test.setTimeout(60000);
  const pending: Promise<string>[] = [];
  page.on('console', (message) => {
    const args = message.args().map((arg) => arg.jsonValue().catch(() => '[unserializable]'));
    pending.push(
      Promise.all(args).then((values) =>
        [message.text(), ...values.map((value) => JSON.stringify(value))].join(' '),
      ),
    );
  });
  await enableSharePoint(page);

  await page.goto(NEW_CHAT_PATH);
  await page.getByRole('button', { name: 'Attach and tools' }).click();
  await page.getByRole('button', { name: 'More upload options' }).click();
  await page
    .getByRole('button', { name: /From SharePoint/ })
    .first()
    .click();

  await expect
    .poll(async () => (await Promise.all(pending)).some((text) => text.includes('download failed')))
    .toBe(true);

  const logged = await Promise.all(pending);
  const leaked = logged.filter((text) =>
    [SECRET_FILE_NAME, SECRET_TOKEN, DOWNLOAD_URL].some((secret) => text.includes(secret)),
  );
  expect(leaked).toEqual([]);
});
