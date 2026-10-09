const v8 = require('v8');

/** Tailwind's compiler clones its theme with `structuredClone`, which jsdom does not provide.
 *  V8 serialization is the same structured-clone algorithm Node's global uses. */
globalThis.structuredClone ??= (value) => v8.deserialize(v8.serialize(value));

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { compile } = require('tailwindcss');
const tailwindPreset = require('../../tailwind.preset.cjs');
const packageConfig = require('../../tailwind.config.js');
const packageJson = require('../../package.json');
const { defaultAppearance, themeAppearanceProperties } = require('./registry');

const packageRoot = path.resolve(__dirname, '../..');

/**
 * Compiles the library's theme entry, the same file an app or tool loads, and returns the CSS
 * for `candidates`. Tailwind v4 has no `resolveConfig`, and a resolved config would only prove
 * the preset's objects merged; what a consumer actually depends on is that the appearance
 * utilities generate and fall back to the registry's defaults.
 */
async function generate(candidates) {
  const compiler = await compile(`@import './src/theme/theme.css';\n`, {
    base: packageRoot,
    async loadModule(id, base) {
      const modulePath = id.startsWith('.') ? path.resolve(base, id) : require.resolve(id);
      const loaded = require(modulePath);
      return { base: path.dirname(modulePath), module: loaded.default ?? loaded, path: modulePath };
    },
    async loadStylesheet(id, base) {
      /** Resolved through package.json: jest's moduleNameMapper turns a `.css` request into a
       *  style stub, which would hand Tailwind JavaScript to parse. */
      const stylesheet =
        id === 'tailwindcss'
          ? path.join(path.dirname(require.resolve('tailwindcss/package.json')), 'index.css')
          : path.resolve(base, id);
      return {
        base: path.dirname(stylesheet),
        content: await fsp.readFile(stylesheet, 'utf8'),
        path: stylesheet,
      };
    },
  });

  return compiler.build(candidates);
}

const tailwindRoot = path.dirname(require.resolve('tailwindcss/package.json'));
const applicationRoot = path.resolve(packageRoot, '../../client');

/** The application stylesheet, compiled the way the SPA's build compiles it. */
async function generateApplication(candidates) {
  const stylesheet = path.join(applicationRoot, 'src/style.css');
  const compiler = await compile(await fsp.readFile(stylesheet, 'utf8'), {
    base: path.dirname(stylesheet),
    async loadModule(id, base) {
      const modulePath = id.startsWith('.') ? path.resolve(base, id) : require.resolve(id);
      const loaded = require(modulePath);
      return { base: path.dirname(modulePath), module: loaded.default ?? loaded, path: modulePath };
    },
    async loadStylesheet(id, base) {
      const resolved =
        id === 'tailwindcss' ? path.join(tailwindRoot, 'index.css') : path.resolve(base, id);
      return {
        base: path.dirname(resolved),
        content: await fsp.readFile(resolved, 'utf8'),
        path: resolved,
      };
    },
  });

  return compiler.build(candidates);
}

/** The declarations of `.candidate`, whitespace collapsed. */
function rule(css, candidate) {
  const match = css.match(new RegExp(`\\.${candidate}\\s*\\{([^}]*)\\}`));
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined;
}

/** Tailwind's own default for a theme variable, read from the installed package. */
function tailwindDefault(variable) {
  const theme = fs.readFileSync(path.join(tailwindRoot, 'theme.css'), 'utf8');
  return theme.match(new RegExp(`\\s${variable}:\\s*([^;]+);`))?.[1].trim();
}

describe('LibreChat Tailwind preset', () => {
  it('owns the loading-dot delay with a zero-delay fallback for plain preset consumers', async () => {
    const css = await generate(['animate-loading-dot']);

    expect(rule(css, 'animate-loading-dot')).toContain('var(--loading-dot-delay, 0ms)');
    expect(rule(css, 'animate-loading-dot')).toContain('1.2s ease-in-out');
  });

  it('generates every component animation and its keyframes together', async () => {
    const names = ['loading-dot', 'accordion-down', 'accordion-up', 'caret-blink'];
    const css = await generate(names.map((name) => `animate-${name}`));

    for (const name of names) {
      expect(css).toContain(`.animate-${name}`);
      expect(css).toContain(`@keyframes ${name}`);
    }
  });

  it('publishes the appearance roles without removing Tailwind defaults', async () => {
    expect(packageConfig.presets).toContain(tailwindPreset);

    const roles = [
      ['font-theme-ui', '--theme-font-family', defaultAppearance.fontFamily],
      ['h-theme-control', '--theme-control-height', defaultAppearance.controlHeight],
      ['h-theme-switch', '--theme-switch-height', defaultAppearance.switchHeight],
      ['h-theme-button', '--theme-button-height', defaultAppearance.buttonHeight],
      ['h-theme-button-sm', '--theme-button-height-sm', defaultAppearance.buttonHeightSm],
      ['h-theme-field', '--theme-field-height', defaultAppearance.fieldHeight],
      ['py-theme-field-y', '--theme-field-padding-y', defaultAppearance.fieldPaddingY],
      ['font-theme-control', '--theme-control-font-weight', defaultAppearance.controlFontWeight],
      ['px-theme-button-x', '--theme-button-padding-x', defaultAppearance.buttonPaddingX],
      ['px-theme-dialog-x', '--theme-dialog-padding-x', defaultAppearance.dialogPaddingX],
      [
        'font-theme-dialog-title-weight',
        '--theme-dialog-title-font-weight',
        defaultAppearance.dialogTitleFontWeight,
      ],
      ['w-theme-switch', '--theme-switch-width', defaultAppearance.switchWidth],
      ['size-theme-switch-thumb', '--theme-switch-height', defaultAppearance.switchHeight],
      ['translate-x-theme-switch-travel', '--theme-switch-width', defaultAppearance.switchWidth],
      ['py-theme-table-cell', '--theme-table-cell-space-y', defaultAppearance.tableCellSpaceY],
      ['h-theme-table-head', '--theme-table-cell-space-y', defaultAppearance.tableCellSpaceY],
      [
        'h-theme-table-head-compact',
        '--theme-table-cell-space-y',
        defaultAppearance.tableCellSpaceY,
      ],
      [
        'py-theme-table-cell-compact',
        '--theme-table-cell-space-y',
        defaultAppearance.tableCellSpaceY,
      ],
      [
        'py-theme-table-cell-dense',
        '--theme-table-cell-space-y',
        defaultAppearance.tableCellSpaceY,
      ],
      ['p-theme-compact', '--theme-space-compact', defaultAppearance.spaceCompact],
      ['p-theme-normal', '--theme-space-normal', defaultAppearance.spaceNormal],
      ['p-theme-control-touch', '--theme-control-height', defaultAppearance.controlHeight],
      ['rounded-theme-control', '--theme-control-radius', defaultAppearance.controlRadius],
      [
        'rounded-theme-control-round',
        '--theme-round-control-radius',
        defaultAppearance.roundControlRadius,
      ],
      ['rounded-theme-surface', '--theme-surface-radius', defaultAppearance.surfaceRadius],
      [
        'rounded-theme-surface-lg',
        '--theme-large-surface-radius',
        defaultAppearance.largeSurfaceRadius,
      ],
      ['rounded-theme-tab', '--theme-tab-radius', defaultAppearance.tabRadius],
      ['rounded-theme-popover', '--theme-popover-radius', defaultAppearance.popoverRadius],
      ['rounded-theme-menu-panel', '--theme-menu-panel-radius', defaultAppearance.menuPanelRadius],
      [
        'rounded-theme-composer-action',
        '--theme-composer-action-radius',
        defaultAppearance.composerActionRadius,
      ],
      ['min-w-theme-tab', '--theme-tab-min-width', defaultAppearance.tabMinWidth],
      ['min-w-theme-list', '--theme-list-min-width', defaultAppearance.listMinWidth],
      ['max-h-theme-list', '--theme-list-max-height', defaultAppearance.listMaxHeight],
      ['h-theme-button-xs', '--theme-button-height-xs', defaultAppearance.buttonHeightXs],
      ['h-theme-button-lg', '--theme-button-height-lg', defaultAppearance.buttonHeightLg],
      [
        'h-theme-button-compact',
        '--theme-button-height-compact',
        defaultAppearance.buttonHeightCompact,
      ],
      ['h-theme-field-lg', '--theme-field-height-lg', defaultAppearance.fieldHeightLg],
      ['size-theme-button', '--theme-button-height', defaultAppearance.buttonHeight],
      [
        'size-theme-icon-button-sm',
        '--theme-icon-button-size-sm',
        defaultAppearance.iconButtonSizeSm,
      ],
      ['size-theme-checkbox', '--theme-checkbox-size', defaultAppearance.checkboxSize],
      ['size-theme-icon', '--theme-icon-size', defaultAppearance.iconSize],
      ['size-theme-icon-md', '--theme-icon-size-md', defaultAppearance.iconSizeMd],
      ['size-theme-icon-lg', '--theme-icon-size-lg', defaultAppearance.iconSizeLg],
      ['shadow-theme-surface', '--theme-elevation-surface', defaultAppearance.elevationSurface],
      ['duration-theme-fast', '--theme-motion-fast', defaultAppearance.motionFast],
      ['duration-theme-normal', '--theme-motion-normal', defaultAppearance.motionNormal],
    ];

    const css = await generate([
      ...roles.map(([candidate]) => candidate),
      'px-theme-control-x',
      'gap-theme-control-gap',
      'font-theme-dialog-title',
      'space-y-theme-dialog-header',
      'font-sans',
      'p-4',
    ]);

    roles.forEach(([candidate, property, fallback]) => {
      expect(css).toContain(`.${candidate}`);
      expect(css).toContain(`var(${property}, ${fallback})`);
    });

    /** The tap-target floor is the role's reason to exist, so the floor itself is asserted
     *  rather than only the control-height variable it is built from. */
    expect(css).toContain(
      `max(var(--theme-control-height, ${defaultAppearance.controlHeight}), 2.75rem)`,
    );

    /** The target floor is WCAG 2.5.8's 24px, not a role a theme could lower. */
    const target = await generate(['h-theme-target', 'min-h-theme-target', 'min-w-theme-target']);
    ['height', 'min-height', 'min-width'].forEach((property) =>
      expect(target).toContain(`${property}: 24px`),
    );
    expect(target).not.toContain('--theme-min-target-size');

    /** A stylesheet that predates the control spacing roles pads controls with the shared
     *  spacing they read before. */
    expect(rule(css, 'px-theme-control-x')).toContain(
      `padding-inline: var(--theme-control-padding-x, var(--theme-space-normal, ${defaultAppearance.spaceNormal}))`,
    );
    expect(rule(css, 'gap-theme-control-gap')).toContain(
      `gap: var(--theme-control-gap, var(--theme-space-compact, ${defaultAppearance.spaceCompact}))`,
    );

    /** A dialog title falls back to the display family it was set in. */
    expect(rule(css, 'font-theme-dialog-title')).toContain(
      'font-family: var(--theme-dialog-title-font-family, var(--theme-display-font-family, inherit))',
    );
    expect(css).toContain(`var(--theme-dialog-header-gap, ${defaultAppearance.dialogHeaderGap})`);

    /** The preset extends the default theme rather than replacing it. */
    expect(css).toContain('.font-sans');
    expect(css).toContain('.p-4');
  });

  it('keeps the high-contrast variant keyed to the resolved app mode', async () => {
    const css = await generate(['high-contrast:bg-surface-primary']);

    expect(css).toContain('html.high-contrast');
  });

  /** The tap-target floor is half CSS and half variant: a spacing key nothing can
   *  reach is not a floor, so the registration is asserted, not just the value. */
  it('registers the appearance variants the utilities are written against', () => {
    const variants = {};
    /** The preset also carries `tailwindcss-animate`, which Tailwind hands an
     *  object rather than a bare function; the variants live in the plugin this
     *  file owns, so only the callable entries are invoked here. */
    tailwindPreset.plugins
      .filter((plugin) => typeof plugin === 'function')
      .forEach((plugin) =>
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

  it('keeps the stock CSS defaults aligned with the appearance registry', () => {
    const stockStyles = fs.readFileSync(path.resolve(__dirname, 'defaults.css'), 'utf8');

    /** Prettier wraps a long font stack, so declarations compare with whitespace collapsed. */
    const collapsed = stockStyles
      .replace(/\s+/g, ' ')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')');
    /** Roles split out of a broader one alias the role they were split from. */
    const aliases = {
      controlPaddingX: 'spaceNormal',
      controlGap: 'spaceCompact',
      labelSize: 'textSm',
      dialogTitleSize: 'textLg',
      dialogTitleFontFamily: 'displayFontFamily',
      menuShadow: 'shadowLg',
      popoverRadius: 'radius2xl',
      menuPanelRadius: 'radiusXl',
      composerActionRadius: 'roundControlRadius',
    };
    Object.entries(themeAppearanceProperties).forEach(([key, property]) => {
      const value = aliases[key]
        ? `var(${themeAppearanceProperties[aliases[key]]}, ${defaultAppearance[key]})`
        : defaultAppearance[key];
      expect(collapsed).toContain(`${property}: ${value};`);
    });
  });
});

describe('radius, font and shadow scales', () => {
  const scale = [
    ['rounded-sm', '--theme-radius-sm', 'radiusSm'],
    ['rounded-md', '--theme-radius-md', 'radiusMd'],
    ['rounded-lg', '--theme-radius-lg', 'radiusLg'],
    ['rounded-xl', '--theme-radius-xl', 'radiusXl'],
    ['rounded-2xl', '--theme-radius-2xl', 'radius2xl'],
    ['rounded-3xl', '--theme-radius-3xl', 'radius3xl'],
  ];
  const shadows = [
    ['shadow-2xs', '--theme-shadow-2xs', 'shadow2xs', '--shadow-2xs'],
    ['shadow-xs', '--theme-shadow-xs', 'shadowXs', '--shadow-xs'],
    ['shadow-sm', '--theme-shadow-sm', 'shadowSm', '--shadow-sm'],
    ['shadow-md', '--theme-shadow-md', 'shadowMd', '--shadow-md'],
    ['shadow-lg', '--theme-shadow-lg', 'shadowLg', '--shadow-lg'],
    ['shadow-xl', '--theme-shadow-xl', 'shadowXl', '--shadow-xl'],
    ['shadow-2xl', '--theme-shadow-2xl', 'shadow2xl', '--shadow-2xl'],
  ];

  it('routes the plain radius and font utilities through theme-owned properties', async () => {
    const css = await generateApplication([
      'rounded',
      ...scale.map(([candidate]) => candidate),
      'font-sans',
      'font-mono',
      'shadow',
      ...shadows.map(([candidate]) => candidate),
      'rounded-theme-control',
      'font-theme-ui',
      'shadow-theme-surface',
    ]);

    scale.forEach(([candidate, property]) => {
      expect(rule(css, candidate)).toBe(`border-radius: var(${property});`);
    });
    /** Bare `rounded` was a fixed 0.25rem, which `sm`'s `calc(0.5rem - 4px)` only equals at a
     *  16px root, so it keeps Tailwind's value rather than following `sm`. */
    expect(rule(css, 'rounded')).toBe('border-radius: 0.25rem;');
    expect(rule(css, 'font-sans')).toBe('font-family: var(--theme-font-family);');
    expect(rule(css, 'font-mono')).toBe('font-family: var(--theme-mono-font-family);');
    shadows.forEach(([candidate, property]) => {
      expect(rule(css, candidate)).toContain(`--tw-shadow: var(${property});`);
    });
    /** Bare `shadow` has always matched `sm`, and follows it. */
    expect(rule(css, 'shadow')).toContain('--tw-shadow: var(--theme-shadow-sm);');

    /** Preflight gives `html` and `code` the same families the utilities do. */
    expect(css).toContain('--default-font-family: var(--theme-font-family);');
    expect(css).toContain('--default-mono-font-family: var(--theme-mono-font-family);');

    /** The existing appearance roles are untouched. */
    expect(rule(css, 'rounded-theme-control')).toBe(
      `border-radius: var(--theme-control-radius, ${defaultAppearance.controlRadius});`,
    );
    expect(rule(css, 'font-theme-ui')).toBe(
      `font-family: var(--theme-font-family, ${defaultAppearance.fontFamily});`,
    );
    expect(rule(css, 'shadow-theme-surface')).toContain(
      `--tw-shadow: var(--theme-elevation-surface, ${defaultAppearance.elevationSurface});`,
    );
  });

  /** The app and the library compile the same `tokens.css`, so every scale utility, and every
   *  color role, must come out of both entries as the same declarations. */
  it('publishes the same scale and color utilities the application compiles', async () => {
    const tokens = fs.readFileSync(path.resolve(__dirname, 'tokens.css'), 'utf8');
    const colors = Array.from(tokens.matchAll(/--color-([\w-]+):/g), (match) => `bg-${match[1]}`);
    const candidates = [
      'rounded',
      ...scale.map(([candidate]) => candidate),
      'font-sans',
      'font-mono',
      'shadow',
      ...shadows.map(([candidate]) => candidate),
      'rounded-theme-control',
      'font-theme-ui',
      'shadow-theme-surface',
      ...colors,
    ];
    const [application, library] = await Promise.all([
      generateApplication(candidates),
      generate(candidates),
    ]);

    candidates.forEach((candidate) => {
      expect(rule(library, candidate)).toBeDefined();
      expect([candidate, rule(library, candidate)]).toEqual([
        candidate,
        rule(application, candidate),
      ]);
    });
    /** `rounded-sm` is the step the preset used to pin to 0.125rem for consumers. */
    expect(rule(library, 'rounded-sm')).toBe('border-radius: var(--theme-radius-sm);');
  });

  it('defaults to the values the utilities resolved to before the remap', () => {
    /** `sm`, `md` and `lg` were `calc(var(--radius) - 4px)`, `calc(var(--radius) - 2px)` and
     *  `var(--radius)` over `--radius: 0.5rem`. The px offsets stay, so the corners match at
     *  every root font size, not only at 16px; a theme still supplies plain lengths. */
    expect(defaultAppearance.radiusSm).toBe('calc(0.5rem - 4px)');
    expect(defaultAppearance.radiusMd).toBe('calc(0.5rem - 2px)');
    expect(defaultAppearance.radiusLg).toBe('0.5rem');
    /** The rest were Tailwind's own steps, read from the installed package. */
    expect(defaultAppearance.radiusXl).toBe(tailwindDefault('--radius-xl'));
    expect(defaultAppearance.radius2xl).toBe(tailwindDefault('--radius-2xl'));
    expect(defaultAppearance.radius3xl).toBe(tailwindDefault('--radius-3xl'));

    expect(defaultAppearance.fontFamily).toBe('Inter, sans-serif');
    expect(defaultAppearance.monoFontFamily).toBe(
      "'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, 'Cascadia Mono', 'Liberation Mono', Consolas, monospace",
    );

    /** The shadow steps were Tailwind's own, read from the installed package. */
    shadows.forEach(([, , key, variable]) => {
      expect(defaultAppearance[key]).toBe(tailwindDefault(variable));
    });
    /** The surface elevation stays the alias it was, equal to `shadow-lg` by default. */
    expect(defaultAppearance.elevationSurface).toBe(defaultAppearance.shadowLg);
  });
});

describe('Click UI spaces drawn by Tailwind steps', () => {
  /** The steps of Click UI's `spaces` scale that no spacing role carries, each with the Tailwind
   *  spacing step the application draws at the same size. */
  const steps = {
    'spaces.0': 0,
    'spaces.1': 1,
    'spaces.4': 4,
    'spaces.5': 6,
    'spaces.6': 8,
    'spaces.7': 10,
    'spaces.8': 16,
  };

  it('compiles each step to the Click UI space of the same size in every mode', async () => {
    const snapshot = require('./themes/clickui.json');
    const css = (
      await generateApplication(Object.values(steps).map((step) => `p-${step}`))
    ).replace(/\s+/g, ' ');
    const base = /--spacing: ([0-9.]+)rem;/.exec(css)?.[1];

    expect(base).toBe('0.25');
    /** The size the last `.p-N` rule draws, in rem: `0px`, the base step, or a multiple of it. */
    const drawn = (step) => {
      const rules = [...css.matchAll(new RegExp(`\\.p-${step} \\{ padding: ([^;]+); \\}`, 'g'))];
      const value = rules.at(-1)?.[1];
      if (value === '0px') {
        return 0;
      }
      if (value === 'var(--spacing)') {
        return Number(base);
      }
      const multiple = /^calc\(var\(--spacing\) \* ([0-9.]+)\)$/.exec(value ?? '')?.[1];
      return multiple === undefined ? undefined : Number(multiple) * Number(base);
    };
    Object.entries(steps).forEach(([token, step]) => {
      ['light', 'dark'].forEach((mode) => {
        const source = snapshot[mode][token];
        const rem = source === '0' ? 0 : parseFloat(source);
        expect([token, mode, drawn(step)]).toEqual([token, mode, rem]);
      });
    });
  });
});
