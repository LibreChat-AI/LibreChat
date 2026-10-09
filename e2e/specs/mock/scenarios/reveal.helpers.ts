import { randomUUID } from 'crypto';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { deleteConversations, seedConversations, seedMessages } from '../db';
import { getAccessToken, requestJson } from '../helpers';
import { getE2EUser } from '../../../setup/user';

/**
 * Shared by the hover-reveal scenarios: a seeded chat with one reply, a project in the
 * sidebar, and the opacity a control actually paints with.
 */

export const REPLY_TEXT = 'Reveal scenario reply';

/** A chat with one user turn and one reply, opened at its route. */
export async function seedReplyChat(title: string): Promise<string> {
  const conversationId = randomUUID();
  const { email } = getE2EUser();
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  const userMessageId = randomUUID();
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Reveal scenario question',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: userMessageId,
      text: REPLY_TEXT,
      isCreatedByUser: false,
      sender: 'Mock Provider A',
    },
  ]);
  return conversationId;
}

export async function deleteChat(conversationId: string): Promise<void> {
  await deleteConversations([conversationId]);
}

export async function createProject(page: Page, name: string): Promise<string> {
  const token = await getAccessToken(page);
  const body = await requestJson<{ _id?: string }>(page, {
    path: '/api/projects',
    token,
    method: 'POST',
    body: { name },
  });
  const id = body._id ?? '';
  expect(id).not.toBe('');
  return id;
}

export async function deleteProject(page: Page, id: string): Promise<void> {
  const token = await getAccessToken(page);
  await requestJson<unknown>(page, {
    path: `/api/projects/${encodeURIComponent(id)}`,
    token,
    method: 'DELETE',
  });
}

/** The sidebar row of a project, which carries its two trailing actions. */
export const projectRow = (page: Page, name: string): Locator =>
  page.getByRole('button', { name, exact: true }).first().locator('..');

/** The opacity a control paints with: its own times every ancestor's, since any of them may be
 *  the one a reveal rule fades. */
export const paintedOpacity = (locator: Locator): Promise<number> =>
  locator.evaluate((node) => {
    let opacity = 1;
    for (let element: Element | null = node; element; element = element.parentElement) {
      opacity *= Number(getComputedStyle(element).opacity);
    }
    return opacity;
  });

/** Whether a finger landing on the control's centre would reach the control itself. */
export const hitAtCenter = (locator: Locator): Promise<boolean> =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      return false;
    }
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return hit !== null && (hit === node || node.contains(hit));
  });
