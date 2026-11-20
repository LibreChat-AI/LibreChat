import type { TModelSpec } from './models';
import {
  resolveSpecToolFlag,
  resolveSpecArtifacts,
  resolveSpecMcpServers,
  resolveSpecUserToggle,
  resolveSpecUserToggles,
  resolveSpecSkillsEnabled,
  specWithholdsUserToggles,
} from './models';

/**
 * A model spec's tool configuration seeds the chat badge row; it does not
 * override what the user then sends back. See #15277 — every one of these
 * cases held before the fix except the "spec on, user off" rows.
 */
describe('model spec defaults vs. explicit user toggles', () => {
  describe('resolveSpecToolFlag', () => {
    it.each([
      ['spec on, user off', false, true, false],
      ['spec on, user on', true, true, true],
      ['spec on, user silent', undefined, true, true],
      ['spec off, user on', true, false, true],
      ['spec off, user off', false, false, false],
      ['spec off, user silent', undefined, false, false],
      ['spec absent, user on', true, undefined, true],
      ['spec absent, user silent', undefined, undefined, false],
    ])('%s', (_label, userValue, specValue, expected) => {
      expect(resolveSpecToolFlag(userValue, specValue)).toBe(expected);
    });
  });

  describe('resolveSpecMcpServers', () => {
    it('treats a cleared selection as a deselection, not an absent value', () => {
      expect(resolveSpecMcpServers([], ['crm'])).toEqual([]);
    });

    it('replaces the spec list with the selection rather than unioning them', () => {
      expect(resolveSpecMcpServers(['jira'], ['crm'])).toEqual(['jira']);
    });

    it('falls back to the spec list when no selection accompanies the request', () => {
      expect(resolveSpecMcpServers(undefined, ['crm'])).toEqual(['crm']);
    });

    it('yields an empty list when neither side names a server', () => {
      expect(resolveSpecMcpServers(undefined, undefined)).toEqual([]);
    });
  });

  describe('resolveSpecSkillsEnabled', () => {
    it.each([
      ['spec true, user off', false, true, false],
      ['spec true, user silent', undefined, true, true],
      ['allowlist, user off', false, ['research'], false],
      ['allowlist, user silent', undefined, ['research'], true],
      ['spec absent, user on', true, undefined, true],
      ['spec absent, user silent', undefined, undefined, false],
    ])('%s', (_label, userValue, specValue, expected) => {
      expect(resolveSpecSkillsEnabled(userValue, specValue as boolean | string[] | undefined)).toBe(
        expected,
      );
    });

    it('keeps `skills: false` a hard opt-out the badge cannot lift', () => {
      expect(resolveSpecSkillsEnabled(true, false)).toBe(false);
      expect(resolveSpecSkillsEnabled(undefined, false)).toBe(false);
    });
  });

  describe('resolveSpecUserToggles', () => {
    const hidden = (spec: Partial<TModelSpec>) => ({ hideBadgeRow: true, ...spec }) as TModelSpec;

    it('drops only the toggles whose capability the hidden spec configures', () => {
      /** Authority follows configuration: a hidden spec silent on a capability
       *  has nothing to protect, so the request still decides there. */
      expect(
        resolveSpecUserToggles(
          { web_search: false, file_search: false, run_in_background: true },
          hidden({ webSearch: true }),
        ),
      ).toEqual({ file_search: false, run_in_background: true });
    });

    it('drops the object entirely when the spec governs every toggle sent', () => {
      expect(
        resolveSpecUserToggles({ web_search: false }, hidden({ webSearch: true })),
      ).toBeUndefined();
    });

    it('preserves fields with no spec counterpart', () => {
      expect(
        resolveSpecUserToggles(
          { unknown_future_toggle: true } as never,
          hidden({ webSearch: true }),
        ),
      ).toEqual({ unknown_future_toggle: true });
    });

    it('passes toggles through untouched for every ordinary spec', () => {
      const toggles = { web_search: false };
      expect(resolveSpecUserToggles(toggles, { webSearch: true } as TModelSpec)).toBe(toggles);
      expect(resolveSpecUserToggles(toggles, null)).toBe(toggles);
      expect(resolveSpecUserToggles(toggles, undefined)).toBe(toggles);
    });

    it('treats a spec value of false as configured', () => {
      expect(
        resolveSpecUserToggles({ web_search: true }, hidden({ webSearch: false })),
      ).toBeUndefined();
    });
  });

  describe('specWithholdsUserToggles', () => {
    it.each([
      ['an ordinary spec', {}, false],
      ['a spec listed in the menu', { showInMenu: true }, false],
      ['a spec that hides the badge row', { hideBadgeRow: true }, true],
      ['a spec left out of the menu', { showInMenu: false }, true],
    ])('%s', (_label, spec, expected) => {
      expect(specWithholdsUserToggles(spec as TModelSpec)).toBe(expected);
    });

    it('is false without a spec', () => {
      expect(specWithholdsUserToggles(null)).toBe(false);
      expect(specWithholdsUserToggles(undefined)).toBe(false);
    });

    it('gives a spec left out of the menu authority over what it configures', () => {
      /** The client never received this spec, so the badges sent beside it were
       *  seeded from the user's own defaults rather than from the spec. */
      const spec = { showInMenu: false, webSearch: true } as TModelSpec;
      expect(resolveSpecUserToggles({ web_search: false, file_search: true }, spec)).toEqual({
        file_search: true,
      });
    });
  });

  describe('resolveSpecUserToggle', () => {
    it('drops a single field the hidden spec configures', () => {
      expect(
        resolveSpecUserToggle(false, { hideBadgeRow: true, skills: true } as TModelSpec, 'skills'),
      ).toBeUndefined();
    });

    it('keeps it when the hidden spec is silent on that capability', () => {
      expect(resolveSpecUserToggle(false, { hideBadgeRow: true } as TModelSpec, 'skills')).toBe(
        false,
      );
    });

    it('keeps it for an ordinary spec', () => {
      expect(resolveSpecUserToggle(false, { skills: true } as TModelSpec, 'skills')).toBe(false);
    });
  });

  describe('resolveSpecArtifacts', () => {
    it.each([
      ['spec true means the default renderer', undefined, true, 'default'],
      ['a spec string passes through', undefined, 'shadcn', 'shadcn'],
      ['a request value decides', 'custom', true, 'custom'],
      ['an empty request value is the badge turned off', '', 'shadcn', undefined],
      ['neither side asks', undefined, undefined, undefined],
      ['an empty spec string is not a request', undefined, '', undefined],
    ])('%s', (_label, userValue, specValue, expected) => {
      expect(
        resolveSpecArtifacts(userValue as string | undefined, specValue as TModelSpec['artifacts']),
      ).toBe(expected);
    });
  });
});
