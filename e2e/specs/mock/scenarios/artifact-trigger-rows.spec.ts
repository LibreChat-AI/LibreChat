import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import {
  deleteConversations,
  deleteMessagesByConversation,
  seedConversations,
  seedMessages,
} from '../db';
import type { SeedMessage } from '../db';
import { messagesView } from '../helpers';

const ROOT_PARENT = '00000000-0000-0000-0000-000000000000';
const SHOWCASE_TEXT = [
  ':::artifact{identifier="e2e-dashboard" type="text/html" title="dashboard.html"}',
  '<main><h1>Dashboard</h1></main>',
  ':::',
  '',
  ':::artifact{identifier="e2e-ingest" type="application/vnd.code" title="ingest.py"}',
  '```python',
  'print("ingest")',
  '```',
  ':::',
  '',
  ':::artifact{identifier="e2e-schema" type="application/vnd.code" title="schema.sql"}',
  '```sql',
  'SELECT 1;',
  '```',
  ':::',
  '',
  ':::artifact{identifier="e2e-findings" type="text/markdown" title="findings.md"}',
  '## Findings',
  '',
  'No findings.',
  ':::',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Start] --> B[Done]',
  '```',
].join('\n');

test.describe('artifact trigger rows', () => {
  test(
    'showcase artifacts share one tool row axis ' +
      '@scenario:artifact-triggers-share-one-tool-row-axis',
    async ({ page }) => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const userEmail = getE2EUser().email;
      const message: SeedMessage = {
        messageId,
        parentMessageId: ROOT_PARENT,
        text: SHOWCASE_TEXT,
        isCreatedByUser: false,
        sender: 'Assistant',
        model: 'mock-model-a',
      };

      try {
        await seedConversations(userEmail, [
          { conversationId, title: 'Artifact trigger rows', updatedAt: new Date() },
        ]);
        await seedMessages(userEmail, conversationId, [message]);
        await page.goto(`/c/${conversationId}`, { timeout: 10000 });

        const messages = messagesView(page);
        const rows = messages.locator('[data-artifact-trigger]');
        await expect(rows).toHaveCount(4);

        for (let index = 0; index < (await rows.count()); index++) {
          const row = rows.nth(index);
          await row.scrollIntoViewIfNeeded();
          await expect(row).toBeVisible();
        }

        const boxes = await rows.evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y + window.scrollY };
          }),
        );
        expect(boxes).toHaveLength(4);
        for (let index = 1; index < boxes.length; index++) {
          expect(boxes[index].y).toBeGreaterThan(boxes[index - 1].y);
          expect(Math.abs(boxes[index].x - boxes[0].x)).toBeLessThanOrEqual(1);
        }

        const expectedRows = [
          ['dashboard.html', 'HTML'],
          ['ingest.py', 'python'],
          ['schema.sql', 'sql'],
          ['findings.md', 'Markdown'],
        ] as const;
        for (const [title, format] of expectedRows) {
          const row = rows.filter({ hasText: title });
          await expect(row).toHaveCount(1);
          await expect(row.getByText(format, { exact: true })).toBeVisible();
        }

        const openMermaidButton = messages.getByRole('button', {
          name: 'Open as artifact',
          exact: true,
        });
        await openMermaidButton.click();

        const mermaidRow = messages.locator('[data-artifact-trigger^="mermaid-artifact-"]');
        await expect(mermaidRow).toHaveCount(1);
        await expect(mermaidRow).toBeVisible();
        await expect(rows).toHaveCount(5);
        await expect(rows.nth(4)).toHaveAttribute('data-artifact-trigger', /^mermaid-artifact-/);

        /* Opening an artifact narrows the chat column, so the axis is only
         * meaningful when every row is measured in the same layout state. */
        const finalBoxes = await rows.evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x, y: box.y + window.scrollY };
          }),
        );
        expect(finalBoxes).toHaveLength(5);
        for (let index = 1; index < finalBoxes.length; index++) {
          expect(finalBoxes[index].y).toBeGreaterThan(finalBoxes[index - 1].y);
          expect(Math.abs(finalBoxes[index].x - finalBoxes[0].x)).toBeLessThanOrEqual(1);
        }
        await expect(mermaidRow.getByText('Diagram', { exact: true })).toBeVisible();
      } finally {
        await deleteMessagesByConversation([conversationId]);
        await deleteConversations([conversationId]);
      }
    },
  );

  test(
    'artifact rows announce preview or source honestly ' +
      '@scenario:artifact-row-announces-preview-or-source',
    async ({ page }) => {
      const conversationId = randomUUID();
      const messageId = randomUUID();
      const userEmail = getE2EUser().email;
      const message: SeedMessage = {
        messageId,
        parentMessageId: ROOT_PARENT,
        text: SHOWCASE_TEXT,
        isCreatedByUser: false,
        sender: 'Assistant',
        model: 'mock-model-a',
      };

      try {
        await seedConversations(userEmail, [
          { conversationId, title: 'Artifact trigger rows', updatedAt: new Date() },
        ]);
        await seedMessages(userEmail, conversationId, [message]);
        await page.goto(`/c/${conversationId}`, { timeout: 10000 });

        const messages = messagesView(page);
        const rows = messages.locator('[data-artifact-trigger]');
        await expect(rows).toHaveCount(4);

        const dashboard = rows.filter({ hasText: 'dashboard.html' });
        await expect(dashboard).toHaveAccessibleName(
          /dashboard\.html.*HTML.*Opens as a rendered preview/,
        );

        const ingest = rows.filter({ hasText: 'ingest.py' });
        await expect(ingest).toHaveAccessibleName(/ingest\.py.*python.*Opens as source/);

        const findings = rows.filter({ hasText: 'findings.md' });
        await expect(findings).toHaveAccessibleName(
          /findings\.md.*Markdown.*Opens as a rendered preview/,
        );

        await ingest.click();
        await expect(ingest).toHaveAttribute('aria-expanded', 'true');
        await expect(ingest).toHaveAccessibleName(/Click to close/);

        const panel = page.locator('#artifact-viewer');
        await expect(panel).toBeVisible();
        await expect(panel).toHaveAttribute('aria-label', 'ingest.py');
        await expect(panel.getByRole('radio', { name: 'Preview', exact: true })).toHaveCount(0);
        const width = page.viewportSize()?.width ?? 0;
        if (width >= 869) {
          await expect(panel.getByRole('radio')).toHaveCount(1);
          await expect(panel.getByRole('radio', { name: 'ingest.py', exact: true })).toBeVisible();
        }
      } finally {
        await deleteMessagesByConversation([conversationId]);
        await deleteConversations([conversationId]);
      }
    },
  );
});
