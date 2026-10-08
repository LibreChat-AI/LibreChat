import { expect, test } from '@playwright/test';
import { clearMailbox, getMailboxMessages } from '../../setup/mailbox';
import { getEmailChangeTarget, getEmailChangeUser } from '../../setup/users.email';

test.describe('account settings · disabled registered-email changes', () => {
  test('hides the control and rejects both backend operations without sending mail', async ({
    page,
  }) => {
    const user = getEmailChangeUser();
    const newEmail = getEmailChangeTarget();
    const refreshResponse = await page.request.post('/api/auth/refresh');
    expect(refreshResponse.status()).toBe(200);
    const { token } = (await refreshResponse.json()) as { token: string };
    const headers = { Authorization: `Bearer ${token}` };

    const configResponse = await page.request.get('/api/config', { headers });
    expect(configResponse.status()).toBe(200);
    expect((await configResponse.json()).allowEmailChange).toBe(false);

    await page.goto('/c/new');
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Account' }).click();
    await expect(
      page.getByRole('tabpanel', { name: 'Account' }).getByRole('button', {
        name: 'Change email address',
      }),
    ).toHaveCount(0);

    await clearMailbox();

    const requestResponse = await page.request.post('/api/user/email/change', {
      headers,
      data: { currentPassword: user.password, newEmail },
    });
    expect(requestResponse.status()).toBe(403);
    expect(await requestResponse.json()).toMatchObject({ code: 'email_change_disabled' });

    const confirmationResponse = await page.request.post('/api/user/email/verify', {
      data: {
        email: newEmail,
        token: 'unused-token',
        userId: '507f1f77bcf86cd799439011',
      },
    });
    expect(confirmationResponse.status()).toBe(403);
    expect(await confirmationResponse.json()).toMatchObject({ code: 'email_change_disabled' });

    expect(await getMailboxMessages()).toEqual([]);
  });
});
