import bcrypt from 'bcryptjs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomInt, randomBytes, randomUUID } from 'node:crypto';
import { withMongo, deleteUserByEmail } from '../db';

/**
 * Mail security gateways (Defender Safe Links, Sophos, Hornetsecurity) open every link in an
 * incoming message and run the page's scripts. The verification token is single use, so the
 * page must not submit it on load: only the person who selects the confirm button spends it.
 */

type SeededLink = { email: string; token: string; userId: string };

/** An unverified local account holding one live verification token, as registration leaves it. */
async function seedUnverifiedAccount(): Promise<SeededLink> {
  const email = `verify-${randomUUID().slice(0, 8)}@example.com`;
  const token = randomBytes(32).toString('hex');
  const hash = await bcrypt.hash(token, 10);
  const userId = await withMongo(async (db) => {
    const now = new Date();
    const { insertedId } = await db.collection('users').insertOne({
      email,
      name: 'Verify Link',
      username: email.split('@')[0],
      provider: 'local',
      role: 'USER',
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    await db.collection('tokens').insertOne({
      userId: insertedId,
      email,
      type: 'email_verification',
      token: hash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 900_000),
    });
    return insertedId.toString();
  });
  return { email, token, userId };
}

async function readAccount(email: string) {
  return withMongo(async (db) => {
    const user = await db.collection('users').findOne({ email });
    const tokens = await db
      .collection('tokens')
      .countDocuments({ userId: user?._id, type: 'email_verification' });
    return { emailVerified: user?.emailVerified, tokens };
  });
}

/** Counts POSTs to an endpoint so a test can prove the page never sent one. */
function countPosts(page: Page, pathname: string) {
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === pathname) {
      posts.push(request.url());
    }
  });
  return posts;
}

const verifyLink = ({ email, token }: SeededLink) =>
  `/verify?${new URLSearchParams({ token, email }).toString()}`;

test.describe('email verification link', () => {
  let seeded: SeededLink | undefined;

  test.afterEach(async () => {
    if (seeded) {
      await deleteUserByEmail(seeded.email);
      seeded = undefined;
    }
  });

  test('opening a verification link does not spend its token @scenario:opening-a-verification-link-leaves-the-token-unused', async ({
    page,
  }) => {
    test.setTimeout(60000);
    seeded = await seedUnverifiedAccount();
    const posts = countPosts(page, '/api/user/verify');

    await page.goto(verifyLink(seeded), { timeout: 15000 });

    await expect(page.getByRole('heading', { name: 'Verify your email address' })).toBeVisible();
    await expect(page.getByText(seeded.email)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify email' })).toBeVisible();
    /** Give a would-be auto-submit time to fire before asserting it did not. */
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    expect(posts).toHaveLength(0);
    expect(await readAccount(seeded.email)).toEqual({ emailVerified: false, tokens: 1 });
  });

  test('a link opened by a scanner first still verifies when the user selects the button @scenario:verification-completes-after-the-user-selects-verify', async ({
    page,
    browser,
  }) => {
    test.setTimeout(60000);
    seeded = await seedUnverifiedAccount();

    /** The scanner: a separate browser that renders the link and leaves. */
    const scanner = await browser.newContext();
    const scannerPage = await scanner.newPage();
    await scannerPage.goto(verifyLink(seeded), { timeout: 15000 });
    await expect(scannerPage.getByRole('button', { name: 'Verify email' })).toBeVisible();
    await scanner.close();

    /** The harness trusts one proxy; give each run its own budget on the 2-per-window submission limiter. */
    await page.setExtraHTTPHeaders({
      'X-Forwarded-For': `127.${randomInt(1, 255)}.${randomInt(1, 255)}.${randomInt(1, 255)}`,
    });
    const posts = countPosts(page, '/api/user/verify');
    await page.goto(verifyLink(seeded), { timeout: 15000 });
    const button = page.getByRole('button', { name: 'Verify email' });
    await button.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: /Email verified successfully/ })).toBeVisible({
      timeout: 15000,
    });
    expect(posts).toHaveLength(1);
    expect(await readAccount(seeded.email)).toEqual({ emailVerified: true, tokens: 0 });
  });

  test('a link without its token reports the problem and offers a new email @scenario:verification-link-missing-its-token-offers-resend', async ({
    page,
  }) => {
    const posts = countPosts(page, '/api/user/verify');

    await page.goto('/verify?email=someone%40example.com', { timeout: 15000 });

    await expect(
      page.getByRole('heading', { name: /Verification failed, token missing/ }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resend Email' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Verify email' })).toHaveCount(0);
    expect(posts).toHaveLength(0);
  });

  test('opening an email-change link waits for the user to confirm @scenario:opening-an-email-change-link-leaves-the-token-unused', async ({
    page,
  }) => {
    const posts = countPosts(page, '/api/user/email/verify');
    const query = new URLSearchParams({
      type: 'email-change',
      userId: '000000000000000000000000',
      email: 'moved@example.com',
      token: 'unused-token',
    });

    await page.goto(`/verify?${query.toString()}`, { timeout: 15000 });

    await expect(
      page.getByRole('heading', { name: 'Confirm your new email address' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm email change' })).toBeVisible();
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
    expect(posts).toHaveLength(0);
  });
});
