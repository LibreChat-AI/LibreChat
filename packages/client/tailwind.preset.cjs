/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      fontFamily: {
        'theme-ui': ['var(--theme-font-family, Inter, sans-serif)'],
      },
      height: {
        'theme-control': 'var(--theme-control-height, 2.25rem)',
      },
      spacing: {
        'theme-compact': 'var(--theme-space-compact, 0.375rem)',
        'theme-normal': 'var(--theme-space-normal, 0.75rem)',
        'theme-control': 'var(--theme-control-height, 2.25rem)',
        /**
         * The comfortable tap target (2.75rem / 44px), held against the theme's
         * own control height with `max()` so a theme that already draws larger
         * controls is never shrunk on a phone. Pair it with `touch:`.
         */
        'theme-control-touch': 'max(var(--theme-control-height, 2.25rem), 2.75rem)',
      },
      borderRadius: {
        'theme-control': 'var(--theme-control-radius, 0.75rem)',
        'theme-control-round': 'var(--theme-round-control-radius, 9999px)',
        'theme-surface': 'var(--theme-surface-radius, 1rem)',
        'theme-surface-lg': 'var(--theme-large-surface-radius, 1.5rem)',
      },
      boxShadow: {
        'theme-surface':
          'var(--theme-elevation-surface, 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1))',
      },
      transitionDuration: {
        'theme-fast': 'var(--theme-motion-fast, 150ms)',
        'theme-normal': 'var(--theme-motion-normal, 200ms)',
      },
    },
  },
  plugins: [
    /**
     * A bare function rather than `plugin()` from `tailwindcss/plugin`, because
     * this preset ships as a raw file through the `./tailwind-preset` export and
     * `tailwindcss` is a devDependency here. Requiring it would fail to resolve
     * for an external consumer under pnpm or Yarn PnP. Tailwind accepts a plain
     * function in `plugins`; the wrapper only adds option and config handling
     * this variant does not need.
     */
    ({ addVariant }) => {
      /**
       * Styling that applies only in the high contrast appearance modes, the
       * same way `dark:` applies only under the `dark` class. Distinct from
       * Tailwind's built-in `contrast-more:`, which is the raw
       * `prefers-contrast: more` media query: this follows the resolved app
       * mode, so it covers an explicit `high-contrast-light` /
       * `high-contrast-dark` choice as well as the OS preference.
       */
      addVariant('high-contrast', 'html.high-contrast &');

      /**
       * Touch is reachable at all — `any-pointer`, deliberately not `pointer`.
       * `pointer` describes only the PRIMARY pointing device, so a 2-in-1 driven
       * by its trackpad reports `fine` with its touchscreen right there, and a
       * tap-target floor written against `(pointer: coarse)` would never reach
       * the finger it exists for.
       *
       * Not the query `useFocusChatEffect` and the composer's focus guard branch
       * on, though it looks like it: those ask "would focusing raise an on-screen
       * keyboard over the thread", which is a question about the primary input and
       * must keep answering `fine` for the trackpad user on that same 2-in-1. A
       * tap target asks the other question — whether a finger can reach the
       * control at all — so the two queries differ on purpose.
       */
      addVariant('touch', '@media (any-pointer: coarse)');

      /**
       * The inverse of `touch`, for hiding something until hover: hover-gating
       * alone strands the finger user of a 2-in-1, because `(hover: hover)` is
       * true there — it describes the trackpad — while the touchscreen sits
       * right next to it. Gating the hidden state on the absence of any coarse
       * pointer keeps a reveal-on-hover affordance from ever hiding a control
       * that only a tap can reach.
       *
       * `not all and`, not the Media Queries Level 4 `not (...)`, because
       * lightningcss lowers this for the production build's browser targets.
       */
      addVariant('no-touch', '@media not all and (any-pointer: coarse)');
    },
  ],
};
