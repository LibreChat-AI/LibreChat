# Dynamic Theme System for @librechat/client

## Versioned theme definitions

New themes should use the versioned `ThemeDefinition` interface. Definitions are data-only, may
provide separate light and dark overrides, and resolve missing values against LibreChat's bundled
defaults before any CSS variables are applied.

```tsx
const compactTheme: ThemeDefinition = {
  version: 1,
  name: 'compact',
  modes: {
    light: {
      appearance: {
        controlRadius: '0.25rem',
        roundControlRadius: '9999px',
        surfaceRadius: '0.5rem',
        largeSurfaceRadius: '0.75rem',
        controlHeight: '2rem',
      },
    },
  },
};

<ThemeProvider themeDefinition={compactTheme}>{children}</ThemeProvider>;
```

The appearance registry covers shared control shape, surface shape, control height, compact/normal
spacing, UI and code typography, surface elevation, fast/normal motion, and the radius and shadow
scales.

In the LibreChat app the plain Tailwind utilities read theme-owned properties, so a theme reshapes
existing call sites without a migration: `rounded-sm` through `rounded-3xl` read `radiusSm`
through `radius3xl` (`--theme-radius-*`), `font-sans` reads `fontFamily` (`--theme-font-family`),
`font-mono` reads `monoFontFamily` (`--theme-mono-font-family`), and `shadow-2xs` through
`shadow-2xl` (and bare `shadow`, which matches `sm`) read `shadow2xs` through `shadow2xl`
(`--theme-shadow-*`). A shadow step must be a concrete `box-shadow` list (no `var()`, `env()` or
`attr()`) or `none`. `elevationSurface` stays the separate role behind `shadow-theme-surface` and
keeps its original validation, so a released theme holding `var()` there still loads. `elevationDrag`
(`--theme-elevation-drag`) is the lift a dragged badge takes while it is held. On every
shadow role, `none` is written as a transparent layer so Tailwind can still compose it with ring
utilities.
The defaults reproduce the scale those utilities had before, so a theme that names none of them
changes nothing. The mapping lives in `tokens.css`, which the app stylesheet imports and
`@librechat/client/theme.css` publishes, so a consumer's utilities are the app's.

The stock families name Inter (`font-sans`, `font-theme-ui`) and Roboto Mono (`font-mono`), and
the ClickHouse theme names Inconsolata. `theme.css` ships all three: `fonts.css` declares their
`@font-face` rules against the package's own files by export (`@librechat/client/fonts/*`), and
the host's bundler (Vite, webpack's css-loader, esbuild) resolves and emits them, exactly as the
app's build does. A pipeline that serves the compiled CSS without a bundler has to serve those
paths itself. A face downloads only once text renders in it. The SIL Open Font License of
each family ships beside its files (`fonts/*-OFL.txt`); keep it with the files when redistributing
them.

> **Breaking change:** the preset used to pin `rounded-sm`, `rounded-md` and `rounded-lg` to
> `--radius` (0.125rem, 0.375rem and 0.5rem by default). They now read `--theme-radius-sm`,
> `--theme-radius-md` and `--theme-radius-lg` like the app's, so `rounded-sm` renders at
> `calc(0.5rem - 4px)` and `--radius` no longer retunes them. Set the `radiusSm` through
> `radius3xl` appearance roles, or the properties behind them, to reshape the scale.

Three primitives keep corners of their own outside that scale: the menu panel (`.popover-ui`) reads
`menuRadius` (0.7rem), the tooltip reads `tooltipRadius` (0.275rem) and the tab trigger reads
`tabRadius` (0.185rem, through `rounded-theme-tab`). The defaults are the corners they always drew.

Most appearance defaults hold in both modes. `darkAppearanceDefaults` lists the ones that differ in
dark mode, and `defaultAppearanceFor(mode)` returns the full set for a mode: the menu panel's
`menuShadow` and the tooltip's `tooltipShadow` are heavier on a dark page, as they always were. A
theme that names a role in one mode replaces that mode's default only, and a theme that names
`shadowLg` but not `menuShadow` keeps shading its light menus with `shadowLg`.

The bundled ClickHouse theme (`themes/clickhouse.ts`) is the reference for a theme that changes
shape as well as color: it tightens the radius scale to Click UI's `border.radii` steps, sets the
mono family to Inconsolata over a real fallback stack, and raises every surface with Click UI's
`shadow.1`, at 0.15 alpha in light mode and 0.6 in dark. Select it for a deployment with
`interface.theme: clickhouse` in `librechat.yaml`.

`themeRGB`, `REACT_APP_THEME_*`, and the existing localStorage keys remain supported through legacy
adapters. Theme application removes only variables owned by the theme module when a theme is reset.

This theme system allows you to dynamically change colors in your React application using CSS variables and Tailwind CSS. It combines dark/light mode switching with dynamic color theming capabilities.

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Basic Usage](#basic-usage)
- [Available Theme Colors](#available-theme-colors)
- [Creating Custom Themes](#creating-custom-themes)
- [Environment Variable Themes](#environment-variable-themes)
- [Dark/Light Mode](#darklight-mode)
- [Migration Guide](#migration-guide)
- [Implementation Details](#implementation-details)
- [Troubleshooting](#troubleshooting)

## Overview

The theme system provides:

1. **Dark/Light Mode Switching** - Automatic theme switching based on user preference
2. **Dynamic Color Theming** - Change colors at runtime without recompiling CSS
3. **CSS Variable Based** - Uses CSS custom properties for performance
4. **Tailwind Integration** - Works seamlessly with Tailwind CSS utilities
5. **TypeScript Support** - Full type safety for theme definitions

## How It Works

The theme system operates in three layers:

1. **CSS Variables Layer**: Default colors, shape, type and elevation shipped by the package
2. **ThemeProvider Layer**: React context that manages theme state and applies CSS variables
3. **Tailwind Layer**: Maps CSS variables to Tailwind utility classes

### Default Behavior (No Custom Theme)

- CSS variables cascade from the stock values `@librechat/client/theme.css` ships
  (`defaults.css`), which the LibreChat app reads through the same import
- Light mode uses variables under `html` selector
- Dark mode uses variables under `.dark` selector
- No JavaScript intervention in color values

### Custom Theme Behavior

- Prefer the versioned `themeDefinition` prop; the legacy `themeRGB` prop remains supported
- Overrides CSS variables with bare `R G B` channel triplets
- Resolves missing `themeDefinition` values against the bundled light/dark defaults
- Leaves colors omitted by legacy `themeRGB` unset so consumer CSS continues to cascade

## Basic Usage

### 1. Install the Component Library

```bash
npm install @librechat/client
```

### 2. Wrap Your App with ThemeProvider

```tsx
import { ThemeProvider } from '@librechat/client';

function App() {
  return (
    <ThemeProvider initialTheme="system">
      <YourApp />
    </ThemeProvider>
  );
}
```

### 3. Set Up Your Base CSS

Import the published token stylesheet. It declares every token and the stock value of every
property the tokens read, for light (`html`) and dark (`.dark`), so the components render the
LibreChat palette with nothing else defined. Restate only what you change, after the import.
Every theme color must hold a **bare `R G B` channel triplet**, not a complete CSS color,
because each token wraps them as `rgb(var(--x))` so that opacity modifiers such as
`bg-surface-primary/50` work. The stock roles are written against primitive scales under
`:root` (`--white`, `--gray-*`, `--green-*`, `--red-*`, `--amber-*`, `--blue-*`), so
redefining a step retints every role that reads it:

```css
/* style.css */
@import 'tailwindcss';
/* Declares --color-text-primary, --color-surface-primary and the rest of the tokens as
 * `@theme inline`, so every utility resolves its custom property at runtime, along with the
 * stock value of each property. */
@import '@librechat/client/theme.css';
/* v4 reads no config by default: this is what loads the preset, the content globs and
 * class-based dark mode from step 4. This app's own entry does the same
 * (`client/src/style.css`), and so does the library's (`src/theme/theme.css`). */
@config './tailwind.config.js';

/* Optional: only what differs from the stock palette. */
html {
  --surface-primary: 250 250 249;
}

.dark {
  --surface-primary: 12 10 9;
}
```

Any direct use of these variables in hand-written CSS must wrap the triplet
itself: `color: rgb(var(--text-primary));`.

> **Breaking change:** earlier versions accepted complete colors
> (`--text-primary: #212121`). Hex, `rgb(...)`, and named colors now produce
> invalid declarations and must be converted to channel triplets.

> **Breaking change:** the color map used to be built in JavaScript by
> `createTailwindColors()` and spread into `theme.extend.colors`. Both are gone. The tokens
> are declared in CSS, which is what lets a linter and an editor resolve them; a config that
> still defines a `colors` block for these names shadows them and can be deleted.

### 4. Configure Tailwind

Update your `tailwind.config.js`:

```js
const libreChatTailwindPreset = require('@librechat/client/tailwind-preset');

module.exports = {
  presets: [libreChatTailwindPreset],
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    // Include component library files: tsdown emits .mjs/.cjs, never .js
    './node_modules/@librechat/client/dist/**/*.{js,mjs,cjs}',
  ],
  darkMode: ['class'],
};
```

The semantic colors come from the stylesheet imported in step 3, so the config carries only content,
dark mode and the preset, and it only applies through the `@config` line in that stylesheet:
v4 loads no config file on its own, so without the directive the preset, the `content` globs
and class-based dark mode are all silently absent.

The published preset supplies the semantic appearance utilities used by theme-aware component
variants, including `h-theme-control`, `rounded-theme-control`, `px-theme-control-x`, `gap-theme-control-gap`, and
`duration-theme-fast`. Keep the preset enabled even when defining additional project utilities.

The published stylesheet and preset preserve the host's standard Tailwind color palettes.
LibreChat's legacy gray and green compatibility scales apply only to its repository builds.

The package requires Tailwind v4 and declares `tailwindcss: ^4.3.3` as a peer dependency: the
published components emit v4-only utilities such as `outline-hidden`, `shadow-xs` and
`origin-(--radix-…)`, which Tailwind 3 silently generates nothing for.

Tailwind 4 is also a different build integration. `tailwindcss` no longer exports a PostCSS
plugin, so a host on the classic PostCSS setup installs `@tailwindcss/postcss` and names that
instead — the SPA's `postcss.config.cjs` is the shape:

```js
module.exports = { plugins: { '@tailwindcss/postcss': {} } };
```

A Vite host can use `@tailwindcss/vite` in place of both. Without one of the two, the directives
below are never compiled and the import fails with Tailwind's direct-plugin error.

Tailwind 4 does not look for a JavaScript config on its own, so writing the file above is not
enough: the stylesheet has to load it, next to the import that pulls Tailwind in. Without the
directive the preset, the package content glob and the `high-contrast:` variant are absent,
and the published components render with most of their classes ungenerated. A consumer uses the same import order as the SPA's `client/src/style.css`, with the package stylesheet among the imports: every `@import` has to precede `@config`, or Vite's CSS pipeline drops the ones after it.

```css
@import 'tailwindcss';
@import '@librechat/client/theme.css';
@import '@librechat/client/style.css';
@config '../tailwind.config.js';
```

The package stylesheet carries the component CSS and the one preflight rule the primitives
depend on — Tailwind 3 gave every `button` a pointer cursor and Tailwind 4 does not — so import
it once, after Tailwind.

`tailwindcss-animate` is a peer dependency too, and the preset registers it: the components' own
`animate-in`, `fade-in-0`, `zoom-in-95` and `slide-in-from-*` classes are its utilities, so a
consumer that loads the preset gets them without configuring anything.

### 5. Use Theme Colors in Components

```tsx
function MyComponent() {
  return (
    <div className="border-border-light bg-surface-primary text-text-primary border">
      <h1 className="text-text-secondary">Hello World</h1>
      <button className="bg-surface-submit text-text-on-status hover:bg-surface-submit-hover">
        Submit
      </button>
    </div>
  );
}
```

## Available Theme Colors

### Text Colors

- `text-text-primary` - Primary text color
- `text-text-secondary` - Secondary text color
- `text-text-secondary-alt` - Alternative secondary text
- `text-text-tertiary` - Tertiary text color
- `text-text-warning` - Warning text color
- `text-text-destructive` - Destructive/error text color
- `text-text-on-status` - Text color for strong status surfaces
- `text-link-prose` - Links in rendered Markdown (`link` in light, primary text in dark by default)

### Surface Colors

- `bg-surface-primary` - Primary background
- `bg-surface-secondary` - Secondary background
- `bg-surface-tertiary` - Tertiary background
- `bg-surface-submit` - Submit button background
- `bg-surface-destructive` - Destructive action background
- `bg-surface-dialog` - Dialog/modal background
- `bg-surface-overlay` - Dialog/modal scrim, adapted per theme
- `bg-surface-media-overlay` - Scrim, chip or progress drawn over the user's own media (lightbox, image preview, upload); `text-text-on-media` is its ink. Black and white in every bundled theme, since they frame the image rather than the page
- `bg-surface-chat` - Chat interface background
- `bg-surface-code` - Code block chrome: toolbar, output and result switcher
- `bg-surface-code-body` - Code block pane behind the highlighted code
- `fill-illustration-subtle`, `fill-illustration`, `fill-illustration-strong` - The three tones of in-app artwork, such as the file drop zone's illustration
- `fill-file-document`, `fill-file-sheet`, `fill-file-code`, `fill-file-artifact`, `fill-file-audio`, `fill-file-video`, `fill-file-generic` - File-type tile fills; `stroke-file-ink` and `fill-file-ink` draw the glyph on them
- `bg-surface-qr` - Backdrop behind a QR code, kept light in every mode so it scans

### Border Colors

- `border-border-light` - Light border
- `border-border-medium` - Medium border
- `border-border-heavy` - Heavy border
- `border-border-xheavy` - Extra heavy border
- `border-drawer-edge` - The mobile drawer's trailing edge: the drawer's own fill in light, `border-xheavy` in dark
- `border-border-destructive` - Destructive action border

### Status Colors

Each status family has a foreground, a `-subtle` background, a `-border`, and a
`-strong` surface for high-contrast notifications:

- `text-status-success` / `bg-status-success-subtle` / `border-status-success-border`
- `text-status-info` / `bg-status-info-subtle` / `border-status-info-border`
- `text-status-warning` / `bg-status-warning-subtle` / `border-status-warning-border`
- `text-status-error` / `bg-status-error-subtle` / `border-status-error-border`
- `text-status-neutral` / `bg-status-neutral-subtle` / `border-status-neutral-border`
- `bg-status-success-strong` / `bg-status-info-strong` / `bg-status-warning-strong` / `bg-status-error-strong`
- `text-status-verified` — fill of the verified mark `VerifiedIcon` paints,
  carrying a `stroke-text-on-status` check. See `rgb-status-verified` in
  `types/index.ts` for why it is its own role and what a pre-token theme gets.

### Other Colors

- `bg-brand-purple` - Brand purple color
- `bg-avatar-fill` / `text-avatar-text` - The default user avatar drawn when a
  user has no image, and its glyph. A theme that sets `rgb-text-primary` but not
  `rgb-avatar-text` inks the glyph in its primary text, as it did before the role.
- `bg-avatar-placeholder` - Behind an agent or assistant avatar while its image
  loads or where it is transparent. A theme that sets only its surfaces keeps it
  on `surface-secondary` in light and `surface-tertiary` in dark, where it sat
  before the role existed.
- `bg-presentation` - Presentation background
- `ring-ring-primary` - Decorative ring color (selection and hover rings)
- `focus-outline` - The app-wide keyboard focus outline. Defaults to black in
  light and white in dark; a theme that names only `rgb-ring-primary` draws its
  outline in that ring.
- `bg-surface-pressed` / `bg-surface-inverted-pressed` - The fill a neutral or
  inverted control takes while held (`hover:active:`). Defaults to the hover fill,
  which a pointer press has always shown; a theme that names only its hover fills
  presses in them.
- `bg-button-primary` / `bg-button-primary-hover` - The `Button`'s primary fill
  and its hover, apart from the inverted surface the checkbox and switch keep.
  They follow `surface-inverted` and its hover when a theme names only those.
- `bg-surface-disabled` / `text-text-disabled` / `border-border-disabled` - The
  disabled fill, ink and edge, painted through the `theme-disabled:` variant only
  when the theme's `disabledStyle` appearance role is `fill`. The default `dim`
  keeps the half-opacity treatment every primitive carries.
- `font-display` - Headings (`displayFontFamily`). Follows the theme's
  `fontFamily` when it names no display family.
- Keyboard focus outline - The global `:focus-visible` outline is drawn in
  `focus-outline`, `focusRingWidth` wide and `focusRingOffset` off the edge (2px
  each by default). The contrast modes keep their own 3px outline.
- Control and icon sizes - `h-theme-button-xs` / `h-theme-button-lg`
  (`buttonHeightXs`, `buttonHeightLg`) size the Button's `xs` and `lg` steps;
  its `icon`, `icon-sm` and `icon-xs` squares are `size-theme-button`,
  `size-theme-icon-button-sm` (`iconButtonSizeSm`) and `size-theme-button-xs`.
  `size-theme-checkbox` (`checkboxSize`) sizes the checkbox, `size-theme-icon` and
  `size-theme-icon-lg` (`iconSize`, `iconSizeLg`) the icons in menus and selects and
  the dialog's close icon, `h-theme-field-lg` (`fieldHeightLg`) the large `title`
  input, and `h-theme-target` the switch's hit area, and `min-w-theme-tab` (`tabMinWidth`, `0` to size a tab by its label) the tab
  trigger. `min-w-theme-list` and `max-h-theme-list` (`listMinWidth`, `0` to size the list by
  its trigger, and `listMaxHeight`, 8 to 40rem) bound the Select's list. Every default is the size the primitive drew before. The icon and checkbox roles
  are bounded to the room their layouts leave: `iconSize` 0.75 to 1.25rem, `iconSizeMd` (the
  exported Dialog's close glyph) 1.25 to 1.5rem, `iconSizeLg` 1 to 2rem, `checkboxSize` 1 to
  1.5rem. The target floor (`h-theme-target`, `min-h-theme-target`, `min-w-theme-target`) is
  a fixed 24px, WCAG 2.5.8's minimum, not a role, so a theme cannot lower it. The Button's
  `xs`, `lg`, `compact` and `icon-sm` heights and `fieldHeightLg` reject a value under 24px;
  `controlHeight`, `buttonHeight`, `buttonHeightSm` and `fieldHeight` predate the floor and
  keep their earlier validation.
- `bg-field-fill` / `text-field-text` - A form field's fill and typed value. The
  ink follows `text-primary` and the fill follows `surface-primary` when a theme
  names those and not these. Fields stay clear unless the theme's
  `fieldFillStyle` appearance role is `fill` (the default is `transparent`),
  read from the nearest themed root through the `theme-field-fill:` variant.
- `bg-surface-tooltip` / `text-tooltip` - The tooltip chip and its label. They follow
  `surface-primary` and `text-primary` when a theme names those and not these. The padding and
  text size are the `tooltipPaddingX`, `tooltipPaddingY` and `tooltipTextSize` appearance roles
  (0.5rem, 0.25rem and 1rem by default).
- `bg-alert-error-fill` / `border-alert-error-border` - The error `Alert`'s fill and edge. They
  follow `status-error-subtle` and `status-error-border`, which the badges, tags and diffs keep.
- Layering roles - `bg-surface-canvas` (the chat canvas and its header fade),
  `bg-surface-user-message` (the user turn's bubble), `bg-surface-card` and
  `bg-surface-card-hover` (marketplace cards), `bg-surface-nav-hover` and
  `bg-surface-nav-selected` (sidebar, rail and drawer rows), `bg-surface-tab-selected`
  (the settings tab rail), `bg-surface-menu` and `bg-surface-popover` with `border-border-menu` (menu and popover
  panels), `bg-surface-composer` (the composer box) and `bg-surface-search` (the sidebar
  search pill). Each follows the surface it painted before it had a name
  (`surface-primary-alt`, `surface-tertiary`, `surface-secondary`, `surface-active-alt`,
  `presentation` for menus, `surface-primary` or `surface-secondary` for popovers, `border-light`, `surface-chat`),
  so a theme that repaints that surface keeps the layer on it, and a theme steps the layers
  apart by naming them.
- `border-border-field-focus` - A form field's edge while it holds focus, under
  `fieldFocusStyle: border`. Follows `focus-control` when a theme names only that.
- Form fields and labels - `h-theme-field` (`fieldHeight`) sizes `Input`, `Dropdown`
  and `ControlCombobox`. `fieldFocusStyle` picks the focus treatment: `ring` (the
  default) draws the keyboard-only focus ring, and `border` swaps the field's edge
  to `border-field-focus` on any focus, adding a 1px ring in that color on keyboard
  focus so the indicator keeps the 2px focus floor, through the
  `theme-field-border:` variant.
- Nested theme roots - `fieldFocusStyle` and `disabledStyle` are read from the
  `--theme-field-focus-style` and `--theme-disabled-style` properties
  `applyTheme` writes on every root it themes, through CSS style queries, so a
  control follows the nearest themed root. A browser without style queries
  (Firefox before 151) keeps the default `ring` and `dim` treatment.
  `Label` reads `labelSize` (follows `textSm`), `labelLeading` and
  `labelFontWeight` (`inherit` by default, so a label keeps the weight around it).
- `text-badge-label` - The shared `Badge`'s resting label ink; a hovered or selected
  badge moves to `text-primary`. Follows `text-primary` when a theme names only that.
- `text-dialog-title` - An OGDialog title's ink. Follows `text-primary` when a
  theme names only that.
- OGDialog chrome - `border-(length:--theme-dialog-stroke)` (`dialogStroke`, painted in
  `border-light`, none by default), `px-theme-dialog-x` (`dialogPaddingX`),
  `space-y-theme-dialog-header` (`dialogHeaderGap`), and for the title
  `text-(length:--theme-dialog-title-size)` and
  `leading-(--theme-dialog-title-leading)` (`dialogTitleSize`, `dialogTitleLeading`),
  `font-theme-dialog-title-weight` (`dialogTitleFontWeight`) and
  `font-theme-dialog-title` (`dialogTitleFontFamily`). The title size and family
  follow `textLg` and `displayFontFamily` when a theme omits them, and a caller's
  own padding, size or weight class replaces the role.
- `text-xs` to `text-2xl` - Sizes and line heights read `textXs`..`text2xl` and
  `leadingXs`..`leading2xl`, in the app and in a consumer alike; the defaults are
  Tailwind's own values.
- `bg-scrim` / `bg-scrim-alert` / `bg-scrim-modal` - The OGDialog, AlertDialog
  and Dialog scrims: `surface-overlay` at the `scrimOpacity`,
  `alertScrimOpacity` and `modalScrimOpacity` appearance roles (80%, 90% and
  65% by default). A bundled scrim dims the page and never lifts it.
- `theme-destructive-soft:` - A variant for a `destructive` Button's tint: the
  button paints a 10% tint of the destructive surface under the destructive ink
  when the theme's `destructiveStyle` is `soft`. The default `fill` keeps the
  solid destructive surface.
- `border-border-inset-medium` - `border-medium` at the `insetBorderAlpha`
  appearance role, for the box edges of a form that sits on a stroked page.
- `ring-focus-subtle` / `outline-focus-subtle` - The keyboard ring of a row or
  control inside content (tool rows, attachments, summaries, message
  navigation). Defaults to `border-heavy`, so a theme that names neither keeps
  the ring it had.
- `border-border-chrome` / `border-border-inset` - `border-light` at the
  `chromeBorderAlpha` and `insetBorderAlpha` appearance roles (both 1 by
  default, so they draw as `border-light`). Chrome is the outline of an icon
  button, pill, chip or avatar ring on the shell; inset is a hairline inside a
  surface that is already stroked. A theme sets 0 to separate them by fill; the
  1px box stays so layout does not shift. `border-border-chrome-heavy` and `border-border-chrome-medium` are
  `border-heavy` and `border-medium` at the chrome share, for the selected and hover
  states of a chrome control.
- `ring-focus-control` - The keyboard focus ring of the shared primitives
  (`Checkbox`, `Switch`, `Field`, `IconButton` and their siblings). Defaults to
  the primary text ink; a theme that names only `rgb-text-primary` rings its
  controls in that ink.

## Creating Custom Themes

### 1. Define Your Theme

```tsx
import { IThemeRGB } from '@librechat/client';

export const customTheme: IThemeRGB = {
  'rgb-text-primary': '0 0 0', // Black
  'rgb-text-secondary': '100 100 100', // Gray
  'rgb-surface-primary': '255 255 255', // White
  'rgb-surface-submit': '0 128 0', // Green
  'rgb-brand-purple': '138 43 226', // Blue Violet
  // ... define other colors
};
```

### 2. Use Your Custom Theme

```tsx
import { ThemeProvider } from '@librechat/client';
import { customTheme } from './themes/custom';

function App() {
  return (
    <ThemeProvider themeRGB={customTheme} themeName="custom">
      <YourApp />
    </ThemeProvider>
  );
}
```

## Environment Variable Themes

Load theme colors from environment variables:

### 1. Create Environment Variables

```env
# .env.local
REACT_APP_THEME_BRAND_PURPLE=171 104 255
REACT_APP_THEME_TEXT_PRIMARY=33 33 33
REACT_APP_THEME_TEXT_SECONDARY=66 66 66
REACT_APP_THEME_SURFACE_PRIMARY=255 255 255
REACT_APP_THEME_SURFACE_SUBMIT=4 120 87
REACT_APP_THEME_LINK=37 99 235
REACT_APP_THEME_ACCENT_PRIMARY=18 110 107
REACT_APP_THEME_STATUS_ERROR=185 28 28
REACT_APP_THEME_STATUS_ERROR_SUBTLE=254 226 226
REACT_APP_THEME_STATUS_ERROR_BORDER=252 165 165
```

Every `IThemeRGB` key is configurable this way: drop the `rgb-` prefix and
upper-snake-case the rest, so `rgb-status-error-border` becomes
`REACT_APP_THEME_STATUS_ERROR_BORDER`.

The prefix must be listed in the bundler's `envPrefix` (Vite) or equivalent, and
values are inlined at build time, so the client has to be rebuilt after changing
them.

### 2. Create a Theme Loader

```tsx
function getThemeFromEnv(env = import.meta.env): IThemeRGB | undefined {
  const theme = {
    'rgb-text-primary': env.REACT_APP_THEME_TEXT_PRIMARY,
    'rgb-brand-purple': env.REACT_APP_THEME_BRAND_PURPLE,
    // ... other colors
  };

  const set = Object.fromEntries(Object.entries(theme).filter(([, value]) => value));
  return Object.keys(set).length > 0 ? set : undefined; // Fall back to default themes
}
```

### 3. Apply Environment Theme

```tsx
<ThemeProvider initialTheme="system" themeRGB={getThemeFromEnv()}>
  <App />
</ThemeProvider>
```

## Dark/Light Mode

The ThemeProvider handles dark/light mode automatically:

### Using the Theme Hook

```tsx
import { useTheme } from '@librechat/client';

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
      Current theme: {theme}
    </button>
  );
}
```

### Theme Options

- `'light'` - Force light mode
- `'dark'` - Force dark mode
- `'system'` - Follow system preference, for both colour scheme and contrast
- `'high-contrast-light'` - Accessibility mode: black on white, WCAG AAA
- `'high-contrast-dark'` - Accessibility mode: white on black, WCAG AAA

High contrast applies the built-in `highContrastTheme` definition
(`themes/highContrast.ts`), which outranks a deployment's custom theme, and adds
a `high-contrast` class to `<html>` for the CSS-only variables the token layer
cannot reach.

Three predicates, and they answer different questions:

- `isDark(theme)` - which colour scheme to render. `high-contrast-dark` is dark.
- `isHighContrast(theme)` - did the user _pick_ a contrast mode. This is what the
  theme toggle preserves when it flips the scheme, so `system` is never included.
- `resolvesToHighContrast(theme)` - will the contrast palette actually apply.
  True for the two explicit modes, and for `system` when the OS asks for more
  contrast through any of `prefers-contrast: more`, `prefers-contrast: custom`
  or `forced-colors: active`.

Because `system` resolves contrast from the OS, a user who has switched on
"Increase contrast" (macOS) or "Contrast themes" (Windows) gets the accessible
palette without first finding this setting. Windows is why the list has three
queries: a Contrast Theme surfaces as `forced-colors: active` with
`prefers-contrast: custom`, never `more`.

## Migration Guide

If you're migrating from an older theme system:

### 1. Update Imports

**Before:**

```tsx
import { ThemeContext, ThemeProvider } from '~/hooks/ThemeContext';
```

**After:**

```tsx
import { ThemeContext, ThemeProvider } from '@librechat/client';
```

### 2. Update ThemeProvider Usage

The new ThemeProvider is backward compatible but adds new capabilities:

```tsx
<ThemeProvider
  initialTheme="system" // Same as before
  themeRGB={customTheme} // New: optional custom colors
>
  <App />
</ThemeProvider>
```

### 3. Existing Components

Components using ThemeContext continue to work without changes:

```tsx
// This still works!
const { theme, setTheme } = useContext(ThemeContext);
```

## Implementation Details

### File Structure

```
packages/client/src/theme/
├── context/
│   └── ThemeProvider.tsx    # Main theme provider
├── types/
│   └── index.ts            # TypeScript interfaces
├── themes/
│   ├── default.ts          # Light theme colors
│   ├── dark.ts             # Dark theme colors
│   └── index.ts            # Theme exports
├── utils/
│   ├── applyTheme.ts       # Apply CSS variables
│   └── tailwindConfig.ts   # Tailwind helpers
├── tokens.css              # Tailwind color tokens (published as @librechat/client/theme.css)
├── README.md               # This documentation
└── index.ts               # Main exports
```

### CSS Variable Format

The theme system uses RGB values in CSS variables:

- CSS Variable: `--text-primary: 33 33 33`
- Theme Definition: `'rgb-text-primary': '33 33 33'`
- Tailwind Usage: `text-text-primary`

### RGB Format Requirements

All color values must be in space-separated RGB format:

- ✅ Correct: `'255 255 255'`
- ❌ Incorrect: `'#ffffff'` or `'rgb(255, 255, 255)'`

This format allows Tailwind to apply opacity modifiers like `bg-surface-primary/50`.

## Troubleshooting

### Common Issues

#### 1. Colors Not Applying

- **Issue**: Custom theme colors aren't showing
- **Solution**: Pass a valid `themeDefinition`, or use the legacy `themeRGB` prop for color-only overrides
- **Check**: CSS variables in DevTools should show a bare `R G B` triplet

#### 2. Circular Reference Errors

- **Issue**: `--brand-purple: var(--brand-purple)` creates infinite loop
- **Solution**: Use direct channel values: `--brand-purple: 171 104 255`

#### 3. Dark Mode Not Working

- **Issue**: Dark mode doesn't switch
- **Solution**: Ensure `darkMode: ['class']` is in your Tailwind config
- **Check**: The `<html>` element should have `class="dark"` in dark mode

#### 4. TypeScript Errors

- **Issue**: Type errors when defining themes
- **Solution**: Import and use the `IThemeRGB` interface:

```tsx
import { IThemeRGB } from '@librechat/client';
```

### Debugging Tips

1. **Check CSS Variables**: Use browser DevTools to inspect computed CSS variables
2. **Verify Theme Application**: Look for inline styles on the root element
3. **Console Errors**: Check for validation errors in the console
4. **Test Isolation**: Try a minimal theme to isolate issues

## Examples

### Dynamic Theme Switching

```tsx
import { ThemeProvider, defaultTheme, darkTheme } from '@librechat/client';
import { useState } from 'react';

function App() {
  const [isDark, setIsDark] = useState(false);

  return (
    <ThemeProvider
      initialTheme={isDark ? 'dark' : 'light'}
      themeRGB={isDark ? darkTheme : defaultTheme}
      themeName={isDark ? 'dark' : 'default'}
    >
      <button onClick={() => setIsDark(!isDark)}>Toggle Theme</button>
      <YourApp />
    </ThemeProvider>
  );
}
```

### Multi-Theme Selector

```tsx
const themes = {
  default: undefined, // Use CSS defaults
  ocean: {
    'rgb-brand-purple': '0 119 190',
    'rgb-surface-primary': '240 248 255',
    // ... ocean theme colors
  },
  forest: {
    'rgb-brand-purple': '34 139 34',
    'rgb-surface-primary': '245 255 250',
    // ... forest theme colors
  },
};

function App() {
  const [selectedTheme, setSelectedTheme] = useState('default');

  return (
    <ThemeProvider themeRGB={themes[selectedTheme]} themeName={selectedTheme}>
      <select onChange={(e) => setSelectedTheme(e.target.value)}>
        {Object.keys(themes).map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <YourApp />
    </ThemeProvider>
  );
}
```

### Using with the Main Application

When using the ThemeProvider in your main application with localStorage persistence:

```tsx
import { ThemeProvider } from '@librechat/client';
import { getThemeFromEnv } from './utils';

function App() {
  const envTheme = getThemeFromEnv();

  return (
    <ThemeProvider
      // Only pass props if you want to override stored values
      // If you always pass props, they will override localStorage
      initialTheme={envTheme ? 'system' : undefined}
      themeRGB={envTheme || undefined}
    >
      {/* Your app content */}
    </ThemeProvider>
  );
}
```

**Important**: The `themeDefinition`, `themeRGB`, and `themeName` props override stored values and
remain synchronized when they change. Only pass theme props when the parent should control those
values; otherwise use the context setters and allow stored preferences to remain authoritative.

Set `persistThemeDefinition={false}` when a parent controls a deployment or embedded theme that
must not replace the user's stored theme definition, legacy colors, name, or source. Appearance
mode changes remain independently persisted through `color-theme`; leave `initialTheme` undefined
when the stored light, dark, or system preference should remain authoritative.

## Contributing

When adding new theme colors:

1. Add the type definition in `types/index.ts`
2. Add the color to default and dark themes
3. Update the applyTheme mapping
4. Add to Tailwind configuration
5. Document in this README

## License

This theme system is part of the @librechat/client package.
