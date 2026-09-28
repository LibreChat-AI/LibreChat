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

The initial appearance registry intentionally covers only shared control shape, surface shape,
control height, compact/normal spacing, UI typography, surface elevation, and fast/normal motion.
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

1. **CSS Variables Layer**: Default colors defined in your app's CSS
2. **ThemeProvider Layer**: React context that manages theme state and applies CSS variables
3. **Tailwind Layer**: Maps CSS variables to Tailwind utility classes

### Default Behavior (No Custom Theme)

- CSS variables cascade from your app's `style.css` definitions
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

Ensure your app has CSS variables defined as fallbacks. Every theme variable must
hold a **bare `R G B` channel triplet**, not a complete CSS color, because the
Tailwind color map wraps them as `rgb(var(--x) / <alpha-value>)` so that opacity
modifiers such as `bg-surface-primary/50` work:

```css
/* style.css */
:root {
  --white: 255 255 255;
  --gray-800: 33 33 33;
  --gray-100: 236 236 236;
  /* ... other color definitions */
}

html {
  --text-primary: var(--gray-800);
  --surface-primary: var(--white);
  /* ... other theme variables */
}

.dark {
  --text-primary: var(--gray-100);
  --surface-primary: var(--gray-900);
  /* ... other dark theme variables */
}
```

Any direct use of these variables in hand-written CSS must wrap the triplet
itself: `color: rgb(var(--text-primary));`.

> **Breaking change:** earlier versions accepted complete colors
> (`--text-primary: #212121`). Hex, `rgb(...)`, and named colors now produce
> invalid declarations and must be converted to channel triplets.

### 4. Configure Tailwind

Update your `tailwind.config.js`:

```js
const libreChatTailwindPreset = require('@librechat/client/tailwind-preset');

module.exports = {
  presets: [libreChatTailwindPreset],
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    // Include component library files
    './node_modules/@librechat/client/dist/**/*.js',
  ],
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        // Wrap each channel triplet so opacity modifiers keep working
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        'surface-primary': 'rgb(var(--surface-primary) / <alpha-value>)',
        'brand-purple': 'rgb(var(--brand-purple) / <alpha-value>)',
        // ... other colors
      },
    },
  },
};
```

The published preset supplies the semantic appearance utilities used by theme-aware component
variants, including `h-theme-control`, `rounded-theme-control`, `gap-theme-compact`, and
`duration-theme-fast`. Keep the preset enabled even when defining additional project utilities.

### 5. Use Theme Colors in Components

```tsx
function MyComponent() {
  return (
    <div className="border border-border-light bg-surface-primary text-text-primary">
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

### Surface Colors

- `bg-surface-primary` - Primary background
- `bg-surface-secondary` - Secondary background
- `bg-surface-tertiary` - Tertiary background
- `bg-surface-submit` - Submit button background
- `bg-surface-destructive` - Destructive action background
- `bg-surface-dialog` - Dialog/modal background
- `bg-surface-overlay` - Dialog/modal scrim, adapted per theme
- `bg-surface-chat` - Chat interface background

### Border Colors

- `border-border-light` - Light border
- `border-border-medium` - Medium border
- `border-border-heavy` - Heavy border
- `border-border-xheavy` - Extra heavy border
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
- `bg-presentation` - Presentation background
- `ring-ring-primary` - Focus ring color

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
│   ├── tailwindConfig.ts   # Tailwind helpers
│   └── createTailwindColors.js
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
