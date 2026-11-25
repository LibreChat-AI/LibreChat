import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { chromium, request } from '@playwright/test';
import type { Browser, FullConfig, Page } from '@playwright/test';
import type { User } from '../types';
import { getE2EUser, storageStatePath } from './user';
import cleanupUser from './cleanupUser';
import { getMongoUri } from './env';
dotenv.config();

const timeout = Number(process.env.E2E_AUTH_TIMEOUT ?? 15000);
const chromiumChannel = process.env.E2E_CHROMIUM_CHANNEL || undefined;

export async function submitRegistration(page: Page, user: User) {
  await page.getByLabel('Full name').click();
  await page.getByLabel('Full name').fill(user.name);
  await page.getByLabel('Email').click();
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Email').press('Tab');
  await page.getByTestId('password').click();
  await page.getByTestId('password').fill(user.password);
  await page.getByTestId('confirm_password').click();
  await page.getByTestId('confirm_password').fill(user.password);
  await page.getByLabel('Submit registration').click();
}

export async function register(page: Page, user: User) {
  await page.getByRole('link', { name: 'Sign up' }).click();
  await submitRegistration(page, user);
}

async function registrationErrorIsVisible(page: Page) {
  return page
    .getByTestId('registration-error')
    .isVisible({ timeout: 500 })
    .catch(() => false);
}

export async function login(page: Page, user: User) {
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByTestId('login-button').click();
}

/**
 * Opens a setup page in the project's locale, `en-US` unless configured, matching the test
 * fixtures. A bare `browser.newPage()` follows the host locale, so the app renders translated
 * labels and the English locators above never match.
 */
export function newSetupPage(browser: Browser, config: FullConfig) {
  return browser.newPage({ locale: config.projects[0].use.locale ?? 'en-US' });
}

export function appURL(baseURL: string, pathname = '') {
  const normalizedBaseURL = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  return new URL(pathname.replace(/^\/+/, ''), normalizedBaseURL).toString();
}

async function authenticate(config: FullConfig, user: User) {
  console.log('🤖: global setup has been started');
  const { baseURL, storageState } = config.projects[0].use;
  console.log('🤖: using baseURL', baseURL);
  console.log('🤖: using E2E user:', user.email);
  if (typeof storageState !== 'string') {
    throw new Error('🤖: storageState must be a file path');
  }

  const browser = await chromium.launch({
    headless: config.projects[0].use.headless ?? true,
    ...(chromiumChannel ? { channel: chromiumChannel } : {}),
  });
  try {
    const page = await newSetupPage(browser, config);
    console.log('🤖: 🗝  authenticating user:', user.email);

    if (typeof baseURL !== 'string') {
      throw new Error('🤖: baseURL is not defined');
    }
    const conversationURL = appURL(baseURL, 'c/new');
    const loginURL = appURL(baseURL, 'login');

    // Set localStorage before navigating to the page
    await page.context().addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });
    console.log('🤖: ✔️  localStorage: set Nav as Visible', storageState);

    await page.goto(baseURL, { timeout });
    await register(page, user);
    try {
      await page.waitForURL(conversationURL, { timeout });
    } catch (error) {
      console.error('Error:', error);
      if (await registrationErrorIsVisible(page)) {
        console.log('🤖: 🚨  user already exists');
        await cleanupUser(user);
        await page.goto(baseURL, { timeout });
        await register(page, user);
        await page.waitForURL(conversationURL, { timeout });
      } else {
        throw new Error('🤖: 🚨  user failed to register');
      }
    }
    console.log('🤖: ✔️  user successfully registered');

    await page.goto(loginURL, { timeout });
    await login(page, user);
    await page.waitForURL(conversationURL, { timeout });
    console.log('🤖: ✔️  user successfully authenticated');

    await page.context().storageState({ path: storageState });
    console.log('🤖: ✔️  authentication state successfully saved in', storageState);
    // await browser.close();
    // console.log('🤖: global setup has been finished');
  } finally {
    await browser.close();
    console.log('🤖: global setup has been finished');
  }
}

/**
 * Gives worker `index` an account of its own, with the role worker 0's account has, and saves
 * its signed-in state where that worker's browser contexts load it (`storageStatePath`).
 *
 * Worker 0's account is the deployment's first, so the server made it an ADMIN, and specs rely
 * on that. Later accounts register as USER, so the role is copied before the account first signs
 * in: registering over the API opens no session, so no request has cached the account as a USER.
 */
export async function authenticateWorker(config: FullConfig, index: number) {
  const { baseURL } = config.projects[0].use;
  if (typeof baseURL !== 'string') {
    throw new Error('🤖: baseURL is not defined');
  }
  const user = getE2EUser(index);
  console.log(`🤖: 🗝  authenticating worker ${index} user:`, user.email);

  const client = new MongoClient(getMongoUri());
  await client.connect();
  try {
    const users = client.db().collection('users');
    /** Left by an interrupted run against a persistent database. */
    if (await users.findOne({ email: user.email })) {
      await cleanupUser(user);
    }

    const api = await request.newContext({ ignoreHTTPSErrors: true });
    try {
      const response = await api.post(appURL(baseURL, 'api/auth/register'), {
        data: { ...user, confirm_password: user.password },
        failOnStatusCode: false,
        timeout,
      });
      if (!response.ok()) {
        throw new Error(`🤖: 🚨  worker ${index} user failed to register (${response.status()})`);
      }
    } finally {
      await api.dispose();
    }

    const primary = await users.findOne({ email: getE2EUser(0).email });
    if (!primary) {
      throw new Error('🤖: 🚨  worker 0 user must be registered before the other workers');
    }
    const { matchedCount } = await users.updateOne(
      { email: user.email },
      { $set: { role: primary.role } },
    );
    if (matchedCount !== 1) {
      throw new Error(`🤖: 🚨  worker ${index} user was not created`);
    }
  } finally {
    await client.close();
  }

  const browser = await chromium.launch({
    headless: config.projects[0].use.headless ?? true,
    ...(chromiumChannel ? { channel: chromiumChannel } : {}),
  });
  try {
    const page = await newSetupPage(browser, config);
    await page.context().addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });
    await page.goto(appURL(baseURL, 'login'), { timeout });
    await login(page, user);
    await page.waitForURL(appURL(baseURL, 'c/new'), { timeout });
    await page.context().storageState({ path: storageStatePath(index) });
    console.log(`🤖: ✔️  worker ${index} state saved in`, storageStatePath(index));
  } finally {
    await browser.close();
  }
}

export default authenticate;
