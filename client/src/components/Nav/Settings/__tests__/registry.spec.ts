import { isValidElementType } from 'react-is';
import { SettingsTabValues, isTwoFactorPolicyProvider } from 'librechat-data-provider';
import type { SettingsContextValue } from '../types';
import en from '~/locales/en/translation.json';
import { registry } from '../registry';
import { TABS } from '../types';

const validTabSections = new Map(TABS.map((t) => [t.id, new Set(t.sections.map((s) => s.id))]));

const settingsContext: SettingsContextValue = {
  balanceEnabled: false,
  hasAnyPersonalizationFeature: false,
  hasMemoryOptOut: false,
  hasStatefulCodeSessions: false,
  hasRemoteAgents: false,
  hasUserProvidedEndpoints: false,
  hasMultiConvo: false,
  hasPrompts: false,
  isLocalProvider: true,
  emailEnabled: true,
  allowEmailChange: true,
  passkeyLoginEnabled: false,
  isTwoFactorPolicyProvider: true,
  twoFactorEnabled: false,
  allowAccountDeletion: true,
  aboutEnabled: false,
  mascotAllowed: true,
  engineTTS: 'browser',
  langfuseConnectionAccess: false,
  adminPanelURL: '',
  replyTabBadgeAllowed: true,
  replyNotificationsAllowed: true,
  replyNotificationSoundAllowed: true,
};

const policyProviders = ['local', 'ldap', null, undefined];
const federatedProviders = ['openid', 'google', 'saml'];

const contextForProvider = (provider: string | null | undefined): SettingsContextValue => ({
  ...settingsContext,
  isTwoFactorPolicyProvider: isTwoFactorPolicyProvider(provider),
});

describe('settings registry', () => {
  it('has unique ids', () => {
    const ids = registry.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('references a valid tab and section for every entry', () => {
    for (const entry of registry) {
      const sections = validTabSections.get(entry.tab);
      expect(sections).toBeDefined();
      expect(sections!.has(entry.section)).toBe(true);
    }
  });

  it('uses label keys that exist in the English locale', () => {
    for (const entry of registry) {
      expect(en).toHaveProperty(entry.labelKey);
    }
  });

  it('has a renderable Component for every entry', () => {
    for (const entry of registry) {
      expect(isValidElementType(entry.Component)).toBe(true);
    }
  });

  describe('two-factor security visibility', () => {
    const twoFactorEntry = registry.find((entry) => entry.id === 'twoFactor');
    const backupCodesEntry = registry.find((entry) => entry.id === 'backupCodes');

    it.each(policyProviders)(
      'shows two-factor authentication for policy provider %s',
      (provider) => {
        expect(twoFactorEntry?.show?.(contextForProvider(provider))).toBe(true);
      },
    );

    it.each(federatedProviders)(
      'hides two-factor authentication for federated provider %s',
      (provider) => {
        expect(twoFactorEntry?.show?.(contextForProvider(provider))).toBe(false);
      },
    );

    it.each(policyProviders)('shows backup codes for enrolled policy provider %s', (provider) => {
      expect(
        backupCodesEntry?.show?.({ ...contextForProvider(provider), twoFactorEnabled: true }),
      ).toBe(true);
    });

    it.each(federatedProviders)(
      'hides backup codes for enrolled federated provider %s',
      (provider) => {
        expect(
          backupCodesEntry?.show?.({ ...contextForProvider(provider), twoFactorEnabled: true }),
        ).toBe(false);
      },
    );

    it.each(policyProviders)(
      'hides backup codes before enrollment for policy provider %s',
      (provider) => {
        expect(
          backupCodesEntry?.show?.({ ...contextForProvider(provider), twoFactorEnabled: false }),
        ).toBe(false);
      },
    );
  });

  describe('Langfuse connection visibility', () => {
    const langfuseEntry = registry.find((entry) => entry.id === 'langfuseConnection');

    it('places the connection in the Langfuse tab', () => {
      expect(langfuseEntry).toMatchObject({
        tab: SettingsTabValues.LANGFUSE,
        section: 'langfuse',
      });
    });

    it('shows the connection when the user can manage it', () => {
      expect(
        langfuseEntry?.show?.({
          ...settingsContext,
          langfuseConnectionAccess: true,
        }),
      ).toBe(true);
    });

    it('hides the connection without Langfuse config access', () => {
      expect(
        langfuseEntry?.show?.({
          ...settingsContext,
          langfuseConnectionAccess: false,
        }),
      ).toBe(false);
    });

    it('shows the connection in single-tenant mode without fanout', () => {
      expect(
        langfuseEntry?.show?.({
          ...settingsContext,
          langfuseConnectionAccess: true,
        }),
      ).toBe(true);
    });
  });

  describe('stateful workspace default visibility', () => {
    const entry = registry.find((setting) => setting.id === 'defaultStatefulWorkspace');

    it('shows the setting when stateful code sessions are available', () => {
      expect(entry?.show?.({ ...settingsContext, hasStatefulCodeSessions: true })).toBe(true);
    });

    it('hides the setting when stateful code sessions are unavailable', () => {
      expect(entry?.show?.({ ...settingsContext, hasStatefulCodeSessions: false })).toBe(false);
    });
  });

  describe('email change visibility', () => {
    const emailChangeEntry = registry.find((entry) => entry.id === 'changeEmail');

    it('places email changes in the Account profile section', () => {
      expect(emailChangeEntry).toMatchObject({
        tab: SettingsTabValues.ACCOUNT,
        section: 'profile',
      });
    });

    it('shows email changes for local accounts when email delivery is configured', () => {
      expect(emailChangeEntry?.show?.(settingsContext)).toBe(true);
    });

    it('hides email changes for federated accounts', () => {
      expect(emailChangeEntry?.show?.({ ...settingsContext, isLocalProvider: false })).toBe(false);
    });

    it('hides email changes when email delivery is unavailable', () => {
      expect(emailChangeEntry?.show?.({ ...settingsContext, emailEnabled: false })).toBe(false);
    });

    it('hides email changes when administrators disable them', () => {
      expect(emailChangeEntry?.show?.({ ...settingsContext, allowEmailChange: false })).toBe(false);
    });
  });
});
