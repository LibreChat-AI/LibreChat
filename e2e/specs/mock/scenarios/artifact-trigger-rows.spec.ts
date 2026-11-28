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
    'authored artifact cards align in the transcript above the Mermaid row ' +
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
        const cards = messages.getByTestId('authored-artifact-card');
        const expectedCards = [
          ['dashboard.html', 'HTML'],
          ['ingest.py', 'python'],
          ['schema.sql', 'sql'],
          ['findings.md', 'Markdown'],
        ] as const;
        await expect(cards).toHaveCount(expectedCards.length);
        for (const [index, [title, format]] of expectedCards.entries()) {
          const card = cards.nth(index);
          await card.scrollIntoViewIfNeeded();
          await expect(card.getByText(title, { exact: true })).toBeVisible();
          await expect(card.getByText(format, { exact: true })).toBeVisible();
          await expect(card.getByRole('status')).toHaveText('Ready');
        }

        const boxes = await cards.evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
          }),
        );
        expect(boxes).toHaveLength(expectedCards.length);
        for (let index = 1; index < boxes.length; index++) {
          expect(boxes[index].top).toBeGreaterThanOrEqual(boxes[index - 1].bottom);
          expect(Math.abs(boxes[index].left - boxes[0].left)).toBeLessThanOrEqual(1);
          expect(Math.abs(boxes[index].right - boxes[0].right)).toBeLessThanOrEqual(1);
        }

        await messages.getByRole('button', { name: 'Open as artifact', exact: true }).click();
        const mermaidRow = messages.locator('[data-artifact-trigger^="mermaid-artifact-"]');
        await expect(mermaidRow.getByText('Diagram', { exact: true })).toBeVisible();
        const exhibits = cards.or(mermaidRow);
        await expect(exhibits).toHaveCount(expectedCards.length + 1);
        await expect(exhibits.last()).toHaveAttribute(
          'data-artifact-trigger',
          /^mermaid-artifact-/,
        );
      } finally {
        await deleteMessagesByConversation([conversationId]);
        await deleteConversations([conversationId]);
      }
    },
  );

  test(
    'artifact actions announce preview or source honestly ' +
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
        const open = (title: string) =>
          messages.getByRole('button', { name: `Open artifact: ${title}.`, exact: false });
        await expect(open('dashboard.html')).toHaveAccessibleName(
          'Open artifact: dashboard.html. Opens as a rendered preview',
        );
        await expect(open('findings.md')).toHaveAccessibleName(
          'Open artifact: findings.md. Opens as a rendered preview',
        );

        const ingest = open('ingest.py');
        await expect(ingest).toHaveAccessibleName('Open artifact: ingest.py. Opens as source');
        await ingest.click();
        const close = messages.getByRole('button', {
          name: 'Close artifact: ingest.py. Opens as source',
          exact: true,
        });
        await expect(close).toHaveAttribute('aria-expanded', 'true');

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
