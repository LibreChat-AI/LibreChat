import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { getE2EUser } from '../../../setup/user';
import { NEW_CHAT_PATH } from '../helpers';

/**
 * The colors these tests read now live in `packages/client/src/theme/tokens.css` as
 * `@theme inline`, and the class names that paint them changed from the `*-token-*`
 * rules that `client/src/style.css` carried to ordinary Tailwind utilities. Both halves
 * are only observable in a rendered page: the rule that used to paint an element sat
 * outside `@layer utilities` and therefore beat every utility on the same property, so
 * the questions are whether the element still takes its token color and whether the
 * theme still recolors it at runtime.
 */
test.describe.configure({ timeout: 120_000 });

const PROBE_TOKENS = {
  secondary: '--text-secondary',
  primary: '--text-primary',
} as const;

type PaintedColor = {
  /** The property as the browser computed it for the real element. */
  actual: string;
  /** The theme property the element is supposed to resolve to. */
  expected: string;
  /** The property it would show if the utility painted nothing and it inherited instead. */
  inherited: string;
};

/**
 * Compare a computed color against a theme custom property without restating the
 * theme's values: both sides are resolved by the browser, so the assertion holds in
 * light mode, dark mode and under a custom theme.
 */
async function paintedColor(
  element: Locator,
  options: { property: 'color' | 'borderTopColor'; expected: string; inherited?: string },
): Promise<PaintedColor> {
  return element.evaluate((node, properties) => {
    const root = getComputedStyle(document.documentElement);
    const normalize = (value: string) => {
      const probe = document.createElement('span');
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    /** `R G B` triplets, with the companion alpha a border token multiplies in. */
    const token = (property: string) => {
      const triplet = root.getPropertyValue(property).trim();
      const alpha = root.getPropertyValue(`${property}-alpha`).trim();
      return normalize(alpha ? `rgb(${triplet} / ${alpha})` : `rgb(${triplet})`);
    };
    const computed = getComputedStyle(node);
    return {
      actual: properties.property === 'color' ? computed.color : computed.borderTopColor,
      expected: token(properties.expected),
      /** No token named: the fallback is whatever the element would inherit, which for a
       *  border with no color of its own is `currentColor`. */
      inherited: properties.inherited ? token(properties.inherited) : computed.color,
    };
  }, options);
}

/** The account menu is the shortest path to an element the rename touched. */
async function openAccountMenu(page: Page): Promise<Locator> {
  await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
  // Settle the shell first: the header toggle and the sidebar both mount late, and probing
  // either one on a blank page answers for the wrong layout.
  await expect(page.getByRole('textbox', { name: 'Message input' })).toBeVisible({
    timeout: 30000,
  });
  // Below `md` the account button lives in the drawer's own header, which renders
  // off-canvas until the toggle opens it, present and "visible" to a locator, but not
  // clickable. The toggle itself is `md:hidden`, so its visibility is the layout probe.
  const opener = page.getByTestId('header-open-sidebar-button');
  if (await opener.isVisible()) {
    await opener.click({ timeout: 15000 });
  }
  const trigger = page.getByTestId('nav-user');
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click({ timeout: 15000 });
  const email = page.getByRole('note').filter({ hasText: getE2EUser().email }).first();
  await expect(email).toBeVisible({ timeout: 15000 });
  return email;
}

test.describe('theme token utilities', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('navVisible', 'true');
    });
  });

  test('the account menu email keeps its secondary text color @scenario:the-account-menu-email-keeps-its-secondary-text-color', async ({
    page,
  }) => {
    const email = await openAccountMenu(page);

    const painted = await paintedColor(email, {
      property: 'color',
      expected: PROBE_TOKENS.secondary,
      inherited: PROBE_TOKENS.primary,
    });
    // The row is the one `text-token-text-secondary` site a person reaches in two clicks.
    expect(painted.actual).toBe(painted.expected);
    // Painting nothing would leave the menu's own primary text color showing through.
    expect(painted.actual).not.toBe(painted.inherited);
  });

  test('a custom theme recolors the account menu email @scenario:a-custom-theme-recolors-the-account-menu-email', async ({
    page,
  }) => {
    const theme = {
      version: 1,
      name: 'e2e-token-utilities',
      // Pinned to light so the desktop-dark project's browser colorScheme cannot
      // select a mode this definition does not carry.
      modes: { light: { colors: { 'rgb-text-secondary': '9 240 120' } } },
    };
    await page.addInitScript((definition) => {
      localStorage.setItem('color-theme', 'light');
      localStorage.setItem('theme-definition', JSON.stringify(definition));
      localStorage.setItem('theme-source', 'definition');
      localStorage.removeItem('theme-colors');
      localStorage.removeItem('theme-name');
    }, theme);

    const email = await openAccountMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.name);

    // `@theme inline` keeps the utility resolving the custom property applyTheme writes,
    // so a theme switch has to reach the rendered row without rebuilding any CSS.
    await expect
      .poll(
        async () =>
          (
            await paintedColor(email, {
              property: 'color',
              expected: PROBE_TOKENS.secondary,
              inherited: PROBE_TOKENS.primary,
            })
          ).actual,
      )
      .toBe('rgb(9, 240, 120)');
  });

  test('the mention menu keeps its light border @scenario:the-mention-menu-keeps-its-light-border', async ({
    page,
  }) => {
    await page.goto(NEW_CHAT_PATH, { timeout: 15000 });
    const composer = page.getByRole('textbox', { name: 'Message input' });
    await expect(composer).toBeVisible({ timeout: 30000 });
    await composer.click();
    // `@` at the first position is what opens the mention menu.
    await composer.pressSequentially('@');

    const search = page.getByPlaceholder('Mention an endpoint');
    await expect(search).toBeVisible({ timeout: 15000 });
    const menu = page.locator('div.popover').filter({ has: search });
    await expect(menu).toBeVisible();

    const painted = await paintedColor(menu, {
      property: 'borderTopColor',
      expected: '--border-light',
    });
    // The frame carried `border-token-border-light`; with the rule gone and no token
    // resolving, a 1px border falls back to the text color instead of the hairline.
    expect(painted.actual).toBe(painted.expected);
    expect(painted.actual).not.toBe(painted.inherited);
  });
});

test.describe('logged out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('auth login links keep their color transitions @scenario:auth-login-links-keep-their-color-transitions', async ({
    page,
  }) => {
    const expectColorTransition = async (link: Locator) => {
      await expect(link).toBeVisible({ timeout: 30000 });
      const transition = await link.evaluate((node) => {
        const style = getComputedStyle(node);
        return { property: style.transitionProperty, duration: style.transitionDuration };
      });
      expect(transition.property).toContain('color');
      expect(transition.property).not.toBe('all');
      expect(parseFloat(transition.duration)).toBeGreaterThan(0);
    };

    await page.goto('/register', { timeout: 15000 });
    await expectColorTransition(page.getByRole('link', { name: 'Login', exact: true }));

    await page.goto('/forgot-password', { timeout: 15000 });
    await expectColorTransition(page.getByRole('link', { name: 'Back to Login', exact: true }));

    // Exercise the response state without delivering email; only the rendered link is under test.
    await page.route('**/api/auth/requestPasswordReset', (route) =>
      route.fulfill({ status: 200, json: {} }),
    );
    await page.getByLabel('Email', { exact: true }).fill('transition-check@example.com');
    await page.getByRole('button', { name: 'Continue with password reset' }).click();
    await expect(page.getByRole('form', { name: 'Password reset form' })).not.toBeVisible();
    await expectColorTransition(page.getByRole('link', { name: 'Back to Login', exact: true }));
  });

  test('the login email field transitions only its colors @scenario:the-login-email-field-transitions-only-its-colors', async ({
    page,
  }) => {
    await page.goto('/login', { timeout: 15000 });
    for (const label of ['Email', 'Password']) {
      const field = page.getByLabel(label, { exact: true });
      await expect(field).toBeVisible({ timeout: 30000 });

      const transition = await field.evaluate((node) => {
        const style = getComputedStyle(node);
        return { property: style.transitionProperty, duration: style.transitionDuration };
      });

      // `transition-color` leaves the initial `all` against the 200 ms duration.
      expect(transition.property).not.toBe('all');
      expect(transition.property).toContain('border-color');
      expect(transition.property).toContain('color');
      expect(transition.duration).toBe('0.2s');
    }
  });
});
