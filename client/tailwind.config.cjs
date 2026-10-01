// Semantic colors are declared in
// packages/client/src/theme/tokens.css, which src/style.css imports. The radius scale and the
// sans and mono families are theme-owned properties mapped in src/style.css.
const libreChatTailwindPreset = require('../packages/client/tailwind.preset.cjs');
const compatibilityColors = require('../packages/client/tailwind.compat.cjs');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,jsx,ts,tsx}',
    // Include component library files
    '../packages/client/src/**/*.{js,jsx,ts,tsx}',
  ],
  // darkMode: 'class',
  darkMode: ['class'],
  presets: [libreChatTailwindPreset],
  theme: {
    extend: {
      colors: compatibilityColors,
      width: {
        authPageWidth: '370px',
      },
      keyframes: {
        'accordion-down': {
          from: { height: 0 },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: 0 },
        },
        /** Radix Collapsible exposes its own height variable, not the accordion one.
         *  The fade rides along so the rows dissolve instead of squashing. Opening
         *  decelerates into place; closing accelerates away, because a decelerating
         *  close stalls over its final pixels before the unmount. */
        'collapsible-down': {
          from: { height: 0, opacity: 0 },
          to: { height: 'var(--radix-collapsible-content-height)', opacity: 1 },
        },
        'collapsible-up': {
          from: { height: 'var(--radix-collapsible-content-height)', opacity: 1 },
          to: { height: 0, opacity: 0 },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-in-left': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(0)' },
        },
        'slide-out-left': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-100%)' },
        },
        'slide-out-right': {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'shortcut-shake': {
          '0%, 100%': { transform: 'translateX(0)' },
          '25%': { transform: 'translateX(-3px)' },
          '75%': { transform: 'translateX(3px)' },
        },
        /** Named distinctly: `blink` is already taken by keyframes in style.css. */
        'logo-blink': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        },
        'refresh-link-spin': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(360deg)' },
        },
        'reset-spin': {
          from: { transform: 'rotate(0deg)' },
          to: { transform: 'rotate(-360deg)' },
        },
      },
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out forwards',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'collapsible-down': 'collapsible-down 0.3s cubic-bezier(0, 0, 0.2, 1)',
        'collapsible-up': 'collapsible-up 0.2s cubic-bezier(0.4, 0, 1, 1)',
        'slide-in-right': 'slide-in-right 300ms cubic-bezier(0.25, 0.1, 0.25, 1)',
        'slide-in-left': 'slide-in-left 300ms cubic-bezier(0.25, 0.1, 0.25, 1)',
        'slide-out-left': 'slide-out-left 300ms cubic-bezier(0.25, 0.1, 0.25, 1)',
        'slide-out-right': 'slide-out-right 300ms cubic-bezier(0.25, 0.1, 0.25, 1)',
        'shortcut-shake': 'shortcut-shake 0.25s ease-in-out',
        'logo-blink': 'logo-blink 3s infinite',
        'refresh-link-spin': 'refresh-link-spin 650ms cubic-bezier(0.42, 0, 0.58, 1)',
        'reset-spin': 'reset-spin 500ms cubic-bezier(0.22, 1, 0.36, 1)',
      },
    },
  },
  plugins: [
    // tailwindcss-radix is gone: its addVariant call produces nothing under Tailwind v4, and
    // Radix sets the same attributes it keyed off, so callers use `data-[state=open]:` and
    // `data-[disabled]:` directly. Its last caller was a table mockup nothing rendered, removed
    // with this upgrade rather than migrated.
    //
    // tailwindcss-animate is not listed here: the published preset above registers it, and
    // Tailwind runs a plugin once per registration, so naming it again would emit every
    // `animate-in`/`fade-in-*` utility twice.
    // require('@tailwindcss/typography'),
  ],
};
