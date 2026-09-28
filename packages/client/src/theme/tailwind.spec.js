const fs = require('fs');
const path = require('path');
const resolveConfig = require('tailwindcss/resolveConfig');
const tailwindPreset = require('../../tailwind.preset.cjs');
const packageConfig = require('../../tailwind.config.js');
const packageJson = require('../../package.json');
const { defaultAppearance, themeAppearanceProperties } = require('./registry');

describe('LibreChat Tailwind preset', () => {
  it('publishes the appearance roles without removing Tailwind defaults', () => {
    const resolved = resolveConfig(packageConfig);

    expect(packageConfig.presets).toContain(tailwindPreset);
    expect(resolved.theme.fontFamily.sans).toBeDefined();
    expect(resolved.theme.fontFamily['theme-ui']).toEqual([
      `var(--theme-font-family, ${defaultAppearance.fontFamily})`,
    ]);
    expect(resolved.theme.height['theme-control']).toBe(
      `var(--theme-control-height, ${defaultAppearance.controlHeight})`,
    );
    expect(resolved.theme.spacing['theme-compact']).toBe(
      `var(--theme-space-compact, ${defaultAppearance.spaceCompact})`,
    );
    expect(resolved.theme.spacing['theme-normal']).toBe(
      `var(--theme-space-normal, ${defaultAppearance.spaceNormal})`,
    );
    expect(resolved.theme.spacing['theme-control']).toBe(
      `var(--theme-control-height, ${defaultAppearance.controlHeight})`,
    );
    expect(resolved.theme.spacing['theme-control-touch']).toBe(
      `max(var(--theme-control-height, ${defaultAppearance.controlHeight}), 2.75rem)`,
    );
    expect(resolved.theme.borderRadius['theme-control']).toBe(
      `var(--theme-control-radius, ${defaultAppearance.controlRadius})`,
    );
    expect(resolved.theme.borderRadius['theme-control-round']).toBe(
      `var(--theme-round-control-radius, ${defaultAppearance.roundControlRadius})`,
    );
    expect(resolved.theme.borderRadius['theme-surface']).toBe(
      `var(--theme-surface-radius, ${defaultAppearance.surfaceRadius})`,
    );
    expect(resolved.theme.borderRadius['theme-surface-lg']).toBe(
      `var(--theme-large-surface-radius, ${defaultAppearance.largeSurfaceRadius})`,
    );
    expect(resolved.theme.boxShadow['theme-surface']).toBe(
      `var(--theme-elevation-surface, ${defaultAppearance.elevationSurface})`,
    );
    expect(resolved.theme.transitionDuration['theme-fast']).toBe(
      `var(--theme-motion-fast, ${defaultAppearance.motionFast})`,
    );
    expect(resolved.theme.transitionDuration['theme-normal']).toBe(
      `var(--theme-motion-normal, ${defaultAppearance.motionNormal})`,
    );
  });

  /** The tap-target floor is half CSS and half variant: a spacing key nothing can
   *  reach is not a floor, so the registration is asserted, not just the value. */
  it('registers the appearance variants the utilities are written against', () => {
    const variants = {};
    tailwindPreset.plugins.forEach((plugin) =>
      plugin({
        addVariant: (name, value) => {
          variants[name] = value;
        },
      }),
    );

    /** `any-pointer`, not `pointer`: the floor has to apply to a 2-in-1's
     *  touchscreen while its trackpad is the primary device and reports `fine`. */
    expect(variants.touch).toBe('@media (any-pointer: coarse)');
    /** Its inverse gates hidden-until-hover states, so a 2-in-1's finger user —
     *  whose trackpad makes `(hover: hover)` true — never loses the control. */
    expect(variants['no-touch']).toBe('@media not all and (any-pointer: coarse)');
    expect(variants['high-contrast']).toBe('html.high-contrast &');
  });

  it('exposes the preset in the published package', () => {
    expect(packageJson.files).toContain('tailwind.preset.cjs');
    expect(packageJson.exports['./tailwind-preset']).toBe('./tailwind.preset.cjs');
  });

  it('keeps application CSS defaults aligned with the appearance registry', () => {
    const applicationStyles = fs.readFileSync(
      path.resolve(__dirname, '../../../../client/src/style.css'),
      'utf8',
    );

    Object.entries(themeAppearanceProperties).forEach(([key, property]) => {
      expect(applicationStyles).toContain(`${property}: ${defaultAppearance[key]};`);
    });
  });
});
