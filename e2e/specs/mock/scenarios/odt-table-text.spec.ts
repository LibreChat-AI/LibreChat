import JSZip from 'jszip';
import { expect, test } from '@playwright/test';
import type { UploadedFile } from '../helpers';
import {
  MOCK_ENDPOINTS,
  NEW_CHAT_PATH,
  fetchJson,
  uniqueName,
  messagesView,
  waitForUpload,
  getAccessToken,
  selectMockEndpoint,
  sendMessageAndWaitForCompletion,
} from '../helpers';
import { inOneProject } from './lint.helpers';

/**
 * An .odt attached as text reaches the model with each table row kept together as CSV, as a
 * spreadsheet or a .docx table does, instead of one cell per line. The text is read on the
 * server, so the scenario has no viewport and runs once.
 */
const ODT = 'application/vnd.oasis.opendocument.text';
/** A row of the table below, which only a CSV rendering writes on one line. */
const ROW = 'EU,Cable,12';

const paragraph = (text: string): string => `<text:p>${text}</text:p>`;

const table = (...rows: string[][]): string =>
  `<table:table table:name="Stock"><table:table-column table:number-columns-repeated="3"/>${rows
    .map(
      (cells) =>
        `<table:table-row>${cells
          .map(
            (text) =>
              `<table:table-cell office:value-type="string">${paragraph(text)}</table:table-cell>`,
          )
          .join('')}</table:table-row>`,
    )
    .join('')}</table:table>`;

/** An .odt package with just the parts the document parser reads. */
async function odt(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', ODT, { compression: 'STORE' });
  zip.file(
    'content.xml',
    '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.3">' +
      `<office:body><office:text>${body}</office:text></office:body></office:document-content>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

test('an uploaded .odt table reaches the model as CSV rows @scenario:an-uploaded-odt-table-reaches-the-model-as-csv-rows', async ({
  page,
}) => {
  inOneProject();
  test.setTimeout(120000);
  await page.goto(NEW_CHAT_PATH, { timeout: 10000 });
  /** Unified upload: an .odt has no override there, so it is read as text by the parser. */
  await selectMockEndpoint(page, MOCK_ENDPOINTS[1]);

  const name = `${uniqueName('stock')}.odt`;
  const buffer = await odt(
    paragraph('Stock report') +
      table(['Region', 'Product', 'Units'], ['EU', 'Cable', '12'], ['US', 'Hub', '7']) +
      paragraph('End of report'),
  );
  const upload = waitForUpload(page);
  await page.getByRole('button', { name: 'Attach and tools', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Attach and tools', exact: true });
  const source = palette.getByRole('button', {
    name: /^(From Local Computer|Upload to Provider)$/,
  });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), source.click()]);
  await chooser.setFiles({ name, mimeType: ODT, buffer });

  const response = await upload;
  expect(response.ok()).toBeTruthy();
  const uploaded = (await response.json()) as UploadedFile;
  expect(uploaded.llmDeliveryPath).toBe('text');

  const token = await getAccessToken(page);
  await expect
    .poll(
      async () =>
        (
          await fetchJson<{ text?: string }>(
            page,
            `/api/files/${encodeURIComponent(uploaded.file_id ?? '')}/preview`,
            token,
          )
        ).text,
      { timeout: 15000 },
    )
    .toBe('Stock report\n\nRegion,Product,Units\nEU,Cable,12\nUS,Hub,7\n\nEnd of report');

  await expect(
    page.getByTestId('composer-tray').getByRole('button', { name, exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await sendMessageAndWaitForCompletion(page, 'Read the stock report.');

  /** Asked on the next turn, so the row is looked for in the prompt, not in the question. */
  await sendMessageAndWaitForCompletion(page, `E2E_ASSERT_HISTORY:${ROW}`);
  await expect(messagesView(page).getByText(`E2E history assertion present: ${ROW}`)).toBeVisible({
    timeout: 30000,
  });
});
