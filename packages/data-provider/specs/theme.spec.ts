import { collectThemeIssues } from '../src/theme';
import { deploymentThemeSchema } from '../src/config';

/** A deployment theme as `librechat.yaml` delivers it, with appearance only in the given modes. */
const definition = (modes: Record<string, Record<string, string>>) => ({
  version: 1,
  name: 'mode-shadow-reference',
  modes: Object.fromEntries(
    Object.entries(modes).map(([mode, appearance]) => [mode, { appearance }]),
  ),
});

const messages = (theme: unknown) => collectThemeIssues(theme).map(({ message }) => message);

describe('menu and tooltip shadow roles in a theme definition', () => {
  it('accepts a different shadow per mode, `none` included', () => {
    const theme = definition({
      light: { menuShadow: '0 4px 6px -1px rgb(21 21 21 / 0.15)', tooltipShadow: 'none' },
      dark: {
        menuShadow: '0 4px 6px -1px rgb(21 21 21 / 0.6), 0 2px 4px -1px rgb(21 21 21 / 0.6)',
        tooltipShadow: '0 1px 2px 0 rgb(0 0 0 / 0.35)',
      },
    });

    expect(deploymentThemeSchema.safeParse(theme).success).toBe(true);
    expect(messages(theme)).toEqual([]);
  });

  it('accepts a shadow named in one mode only, leaving the other to its default', () => {
    const theme = definition({ dark: { tooltipShadow: 'none' } });

    expect(deploymentThemeSchema.safeParse(theme).success).toBe(true);
    expect(messages(theme)).toEqual([]);
  });

  it.each([
    ['menuShadow', 'var(--theme-shadow-lg)'],
    ['menuShadow', '0 4px; color: red'],
    ['menuShadow', 'big'],
    ['tooltipShadow', '0 1px 2px 0 rgb(0 0 0 / 0.35),'],
    ['tooltipShadow', 'url(x.png)'],
  ])('rejects %s %s in either mode', (role, value) => {
    for (const mode of ['light', 'dark']) {
      expect(messages(definition({ [mode]: { [role]: value } }))).toEqual([
        `Invalid appearance value for ${role}: ${value}`,
      ]);
    }
  });
});
