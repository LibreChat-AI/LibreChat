import { randomUUID } from 'crypto';
import { expect, test } from '@playwright/test';
import {
  deleteProjects,
  seedProjects,
  deleteConversations,
  seedConversations,
  withMongo,
} from '../db';
import { getPrimaryE2EUser } from '../../../setup/users.mock';
import { openSidebar } from './sidebar';
import { NEW_CHAT_PATH } from '../helpers';

test('leading icons preserve conversation focus after keyboard unpin @scenario:sidebar-icons-and-unpin-focus', async ({
  page,
}) => {
  const ids = [randomUUID(), randomUUID()];
  const titles = ids.map((id) => `Icon focus ${id}`);
  const { email } = getPrimaryE2EUser();
  const projects = await seedProjects(email, [`Icons ${randomUUID()}`]);
  try {
    await seedConversations(
      email,
      ids.map((conversationId, i) => ({
        conversationId,
        title: titles[i],
        updatedAt: new Date(Date.now() - i * 1000),
      })),
    );
    await withMongo((db) =>
      db.collection('conversations').updateMany(
        { conversationId: { $in: ids } },
        {
          $set: {
            pinned: true,
            chatProjectId: projects[0],
            codeEnvironmentMode: 'attached',
            laneGit: {
              branch: 'feat/enterprise-header',
              head: 'a'.repeat(40),
              repo: 'e2e-org/e2e-app',
              seq: 1,
            },
          },
        },
      ),
    );
    await page.goto(NEW_CHAT_PATH);
    await openSidebar(page);
    const pinned = page.locator('[data-pinned-section]').filter({ visible: true });
    const first = pinned.getByTestId('convo-item').filter({ hasText: titles[0] });
    const second = pinned.getByTestId('convo-item').filter({ hasText: titles[1] });
    await expect(second.getByTestId('convo-pull-request')).toBeVisible();
    const unpin = first.getByTestId('convo-unpin-button');
    await unpin.focus();
    await unpin.press('Enter');
    await expect(first).toHaveCount(0);
    await expect(second.locator('[data-conversation-link]')).toBeFocused();
    await expect(page.getByRole('dialog', { name: 'Pull request', exact: true })).toBeHidden();

    await second.getByTestId('convo-unpin-button').click();
    await expect(second).toHaveCount(0);
    await page.getByRole('button', { name: 'Filter and sort chats', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Show project chats', exact: true }).click();
    await page.keyboard.press('Escape');
    const regular = page
      .getByTestId('convo-item')
      .filter({ hasText: titles[1] })
      .filter({ visible: true });
    const project = regular.getByTestId('convo-project-badge');
    const pr = regular.getByTestId('convo-pull-request');
    const title = regular.locator('[data-conversation-link]');
    await expect(project).toBeVisible();
    await expect(pr).toBeVisible();
    const projectBox = await project.boundingBox();
    const prBox = await pr.boundingBox();
    const titleBox = await title.boundingBox();
    expect(projectBox!.x + projectBox!.width).toBeLessThanOrEqual(prBox!.x);
    expect(prBox!.x + prBox!.width).toBeLessThanOrEqual(titleBox!.x);
    await title.focus();
    const menu = regular.getByRole('button', { name: 'Conversation Menu Options' });
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox!.x).toBeGreaterThan(titleBox!.x);
  } finally {
    await deleteConversations(ids);
    await deleteProjects(projects);
  }
});
