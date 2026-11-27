const libreChatTailwindPreset = require('./tailwind.preset.cjs');
const compatibilityColors = require('./tailwind.compat.cjs');

/**
 * The library's own Tailwind config, used when developing and testing the package in isolation.
 * Semantic colors are declared in `src/theme/tokens.css`, published as
 * `@librechat/client/theme.css`. Legacy compatibility colors apply only inside this repository.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: ['./src/**/*.{js,jsx,ts,tsx}'],
  darkMode: ['class'],
  presets: [libreChatTailwindPreset],
  theme: { extend: { colors: compatibilityColors } },
  // No plugins here: the components write `animate-in`, `fade-in-0`, `slide-in-from-*` and the
  // accordion keyframes, and the preset above is what registers the plugin generating them, for
  // this config and for a consumer's alike. Registering it a second time emits each of those
  // utilities twice.
  plugins: [],
};
