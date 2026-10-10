import { expect, test } from '@playwright/test';
import type { TStartupConfig } from 'librechat-data-provider';
import type { Browser, Page } from '@playwright/test';

/**
 * A deployment's policies are agreed to on the way in, so both ways in state
 * the consent, with a direct link to each policy it published: the registration
 * form under its own submit button, the login screen below the provider
 * buttons. Which of them creates the account is not knowable in the client, and
 * the sentence is about continuing, which both screens do. It is worded for
 * what is configured: a deployment that published only one policy must not
 * claim the reader agreed to the other, and one that published neither says
 * nothing at all.
 *
 * These run unauthenticated, because an authenticated session redirects away
 * from the auth screens before anything renders.
 */

const PRIVACY_URL = 'https://example.com/privacy';
const TERMS_URL = 'https://example.com/terms';

type ConfigOverrides = Partial<TStartupConfig>;

/** The harness deployment configures no policies, so a spec that needs them
 *  answers the startup config for itself. `interface` is merged rather than
 *  replaced: overwriting it would take the page's own capabilities with it. */
async function withConfig(page: Page, overrides: ConfigOverrides) {
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as TStartupConfig;
    await route.fulfill({
      response,
      json: {
        ...config,
        ...overrides,
        interface: { ...config.interface, ...overrides.interface },
      },
    });
  });
}

/** A signed-out visitor, which is the only one who ever reaches these screens. */
async function openAuthScreen(
  browser: Browser,
  baseURL: string | undefined,
  path: string,
  overrides: ConfigOverrides,
) {
  const context = await browser.newContext({ storageState: undefined, baseURL });
  const page = await context.newPage();
  await withConfig(page, overrides);
  await page.goto(path, { timeout: 15000 });
  await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible({ timeout: 15000 });
  return { context, page };
}

const bothPolicies: ConfigOverrides = {
  interface: {
    privacyPolicy: { externalUrl: PRIVACY_URL },
    termsOfService: { externalUrl: TERMS_URL },
  },
};

test.describe('registration consent', () => {
  test('registration states the consent with a link to each policy @scenario:registration-states-the-policy-consent', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const { context, page } = await openAuthScreen(browser, baseURL, '/register', bothPolicies);

    try {
      await expect(page.getByText(/By continuing, you agree to the/i)).toBeVisible();

      /** One link each: the screen states the consent instead of also carrying
       *  the footer bar that used to repeat both links beneath it. */
      const privacy = page.locator(`a[href="${PRIVACY_URL}"]`);
      const terms = page.locator(`a[href="${TERMS_URL}"]`);
      await expect(privacy).toHaveCount(1);
      await expect(terms).toHaveCount(1);
      await expect(privacy).toBeVisible();
      await expect(terms).toBeVisible();

      /** The links are read by name, so they carry their own text rather than
       *  leaving a screen reader with the sentence around them. */
      await expect(privacy).toHaveText('Privacy Policy');
      await expect(terms).toHaveText('Terms of Service');

      /** Reachable by keyboard, not only by pointer. */
      await terms.focus();
      await expect(terms).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('the consent names only the policy the deployment published @scenario:registration-consent-names-only-the-published-policy', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const { context, page } = await openAuthScreen(browser, baseURL, '/register', {
      interface: { privacyPolicy: { externalUrl: PRIVACY_URL } },
    });

    try {
      await expect(page.getByText(/By continuing, you acknowledge the/i)).toBeVisible();
      await expect(page.locator(`a[href="${PRIVACY_URL}"]`)).toHaveCount(1);
      await expect(page.getByText(/agree to the Terms of Service/i)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a deployment with no policies states no consent @scenario:registration-without-policies-states-no-consent', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60000);
    const { context, page } = await openAuthScreen(browser, baseURL, '/register', {});

    try {
      await expect(page.getByRole('button', { name: 'Submit registration' })).toBeVisible();
      await expect(page.getByText(/By continuing/i)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a blank policy url is not a published policy @scenario:a-blank-policy-url-is-not-a-published-policy', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60000);
    /** `externalUrl` is an optional string, so this is a configuration an
     *  operator can write; a link to nothing would name a document that does
     *  not exist and navigate back to this page. */
    const { context, page } = await openAuthScreen(browser, baseURL, '/register', {
      interface: { privacyPolicy: { externalUrl: '' }, termsOfService: { externalUrl: '' } },
    });

    try {
      await expect(page.getByRole('button', { name: 'Submit registration' })).toBeVisible();
      await expect(page.getByText(/By continuing/i)).toHaveCount(0);
      await expect(page.locator('a[href=""]')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('the login screen states the consent without any provider button @scenario:the-login-screen-states-the-consent', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60000);
    /** No provider button is needed for this screen to be a way in: a first
     *  LDAP sign-in creates the account through this very form
     *  (api/strategies/ldapStrategy.js). */
    const { context, page } = await openAuthScreen(browser, baseURL, '/login', bothPolicies);

    try {
      await expect(page.getByRole('link', { name: /Continue with/i })).toHaveCount(0);
      await expect(page.getByText(/By continuing, you agree to the/i)).toBeVisible();
      await expect(page.locator(`a[href="${PRIVACY_URL}"]`)).toHaveCount(1);
      await expect(page.locator(`a[href="${TERMS_URL}"]`)).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test('a modal-acceptance deployment keeps the bare links @scenario:a-modal-acceptance-deployment-states-no-passive-consent', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60000);
    /** That deployment asks for the terms to be accepted in a dialog after
     *  sign-in, so a sentence saying the reader already agreed by continuing
     *  would contradict the dialog it is about to show. */
    const { context, page } = await openAuthScreen(browser, baseURL, '/register', {
      interface: {
        privacyPolicy: { externalUrl: PRIVACY_URL },
        termsOfService: { externalUrl: TERMS_URL, modalAcceptance: true },
      },
    });

    try {
      await expect(page.getByText(/By continuing/i)).toHaveCount(0);
      await expect(page.locator(`a[href="${PRIVACY_URL}"]`)).toHaveCount(1);
      await expect(page.locator(`a[href="${TERMS_URL}"]`)).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test('a login screen that can create an account states the consent @scenario:a-social-login-screen-states-the-consent', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60000);
    /** A provider button on the login screen creates the account on a first
     *  sign-in, so that screen is a place an account is created. */
    const { context, page } = await openAuthScreen(browser, baseURL, '/login', {
      ...bothPolicies,
      socialLoginEnabled: true,
      googleLoginEnabled: true,
      socialLogins: ['google'],
    });

    try {
      await expect(page.getByRole('link', { name: /Continue with Google/i })).toBeVisible();
      await expect(page.getByText(/By continuing, you agree to the/i)).toBeVisible();
      await expect(page.locator(`a[href="${PRIVACY_URL}"]`)).toHaveCount(1);
      await expect(page.locator(`a[href="${TERMS_URL}"]`)).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
});
