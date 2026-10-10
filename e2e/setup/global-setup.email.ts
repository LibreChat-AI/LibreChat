import { chromium } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import cleanupUser from './cleanupUser';
import { appURL, login, submitRegistration } from './authenticate';
import { clearMailbox, getVerificationURL, waitForMessage } from './mailbox';
import { getEmailChangeTarget, getEmailChangeUser } from './users.email';

const timeout = Number(process.env.E2E_AUTH_TIMEOUT ?? 15_000);
const chromiumChannel = process.env.E2E_CHROMIUM_CHANNEL || undefined;

async function globalSetup(config: FullConfig) {
  const user = getEmailChangeUser();
  await cleanupUser({ email: getEmailChangeTarget(), password: user.password });
  await cleanupUser(user);
  await clearMailbox();

  const { baseURL, storageState } = config.projects[0].use;
  if (typeof baseURL !== 'string' || typeof storageState !== 'string') {
    throw new Error('Email E2E setup requires string baseURL and storageState values');
  }

  const browser = await chromium.launch({
    headless: config.projects[0].use.headless ?? true,
    ...(chromiumChannel ? { channel: chromiumChannel } : {}),
  });
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    const failedResponses: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.goto(appURL(baseURL, 'register'), { timeout });
    try {
      await page.getByLabel('Full name').waitFor({ timeout });
    } catch (error) {
      const body = (await page.locator('body').innerText()).slice(0, 2000);
      throw new Error(
        `Registration form did not render at ${page.url()}\nPage errors: ${pageErrors.join(' | ') || 'none'}\nFailed responses: ${failedResponses.join(' | ') || 'none'}\nBody: ${body || '(empty)'}`,
        { cause: error },
      );
    }
    const registrationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/auth/register',
    );
    await submitRegistration(page, user);
    const registrationResponse = await registrationResponsePromise;
    if (!registrationResponse.ok()) {
      throw new Error(
        `Registration failed with ${registrationResponse.status()}: ${await registrationResponse.text()}`,
      );
    }

    const verificationEmail = await waitForMessage({
      to: user.email,
      subject: 'Verify your email',
    });
    await page.goto(getVerificationURL(verificationEmail, baseURL), { timeout });
    await page.getByRole('heading', { name: /Email verified successfully/ }).waitFor({ timeout });

    await page.goto(appURL(baseURL, 'login'), { timeout });
    await login(page, user);
    await page.waitForURL(appURL(baseURL, 'c/new'), { timeout });
    await page.context().storageState({ path: storageState });
  } finally {
    await browser.close();
  }
}

export default globalSetup;
