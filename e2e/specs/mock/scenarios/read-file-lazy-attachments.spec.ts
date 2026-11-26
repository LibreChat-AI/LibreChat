import { expect, test } from '@playwright/test';
import {
  NEW_CHAT_PATH,
  MOCK_ENDPOINTS,
  uniqueName,
  getCodeExecs,
  resetProvisioning,
  selectMockEndpoint,
  enableCodeInterpreter,
  uploadViaUnifiedButton,
  sendMessageAndWaitForCompletion,
} from '../helpers';

/** A unified upload routed to `none` reaches the sandbox only when a code tool first runs. A
 *  turn that reads with read_file before its first bash_tool call must mount the file for both
 *  calls; the read used to take the handoff and leave the bash call without it. */
test('an attachment a read_file call provisions stays mounted for the next bash call @scenario:read-file-keeps-lazy-attachment-for-bash', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);
  await resetProvisioning(page);
  await enableCodeInterpreter(page);

  const label = uniqueName('readbash');
  const fileName = `${label}.csv`;
  const upload = await uploadViaUnifiedButton(page, {
    name: fileName,
    mimeType: 'text/csv',
    content: 'name,score\nzoe,9\n',
  });
  expect(upload.ok()).toBeTruthy();
  await expect(
    page.getByTestId('composer-tray').getByRole('button', { name: fileName }),
  ).toBeVisible({ timeout: 15000 });

  await sendMessageAndWaitForCompletion(page, `E2E_READ_THEN_BASH:${label}`);
  /* Scoped to the message view: the live region announces the same final text. */
  await expect(
    page.getByTestId('screenshot-target').getByText(`E2E read then bash complete: ${label}`),
  ).toBeVisible({ timeout: 30000 });

  const execs = (await getCodeExecs(page)).filter((exec) => exec.code.includes(fileName));
  const bash = execs.filter((exec) => exec.code.includes(`E2E_READ_THEN_BASH:${label}`));
  const read = execs.filter((exec) => !exec.code.includes('E2E_READ_THEN_BASH'));
  expect(read, 'the read_file call reaches the sandbox').toHaveLength(1);
  expect(read[0].fileNames, 'the first read sees the file it provisioned').toContain(fileName);
  expect(bash, 'the bash call reaches the sandbox').toHaveLength(1);
  expect(bash[0].fileNames, 'the bash call after the read still has the file').toContain(fileName);
});
