/** @type {import('tailwindcss').Config} */
module.exports = {
  theme: {
    extend: {
      fontFamily: {
        'theme-ui': ['var(--theme-font-family, Inter, sans-serif)'],
      },
      height: {
        'theme-control': 'var(--theme-control-height, 2.25rem)',
        'theme-switch': 'var(--theme-switch-height, 1.5rem)',
        /** A header cell: the table's vertical cell space on both sides of one text line. */
        'theme-table-head': 'calc(var(--theme-table-cell-space-y, 1rem) * 2 + 1rem)',
        /** A compact header: half the cell space on both sides of a text-sm line. */
        'theme-table-head-compact': 'calc(var(--theme-table-cell-space-y, 1rem) + 1.25rem)',
      },
      width: {
        /** Never narrower than the track is tall, so the knob always has somewhere to travel. */
        'theme-switch':
          'max(var(--theme-switch-width, 2.75rem), var(--theme-switch-height, 1.5rem))',
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
        /** The switch knob inside the track's 2px border, in px so it holds at any root size,
         *  and how far it travels when checked (the borders cancel out of the travel). */
        'theme-switch-thumb': 'max(0px, calc(var(--theme-switch-height, 1.5rem) - 4px))',
        'theme-switch-travel':
          'max(0px, calc(var(--theme-switch-width, 2.75rem) - var(--theme-switch-height, 1.5rem)))',
        'theme-table-cell': 'var(--theme-table-cell-space-y, 1rem)',
        /** The compact and dense table sizes: half and a quarter of the cell space. */
        'theme-table-cell-compact': 'calc(var(--theme-table-cell-space-y, 1rem) / 2)',
        'theme-table-cell-dense': 'calc(var(--theme-table-cell-space-y, 1rem) / 4)',
      },
      keyframes: {
        /** Discord-style "connecting" dots: each dot lifts and brightens in
         *  turn, so a stalled request still shows motion. Lives in the preset
         *  because `LoadingDots` ships from this package and the app's own
         *  config extends it. */
        'loading-dot': {
          '0%, 70%, 100%': { opacity: '0.35', transform: 'translateY(0)' },
          '35%': { opacity: '1', transform: 'translateY(-2px)' },
        },
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        'caret-blink': {
          '0%,70%,100%': { opacity: '1' },
          '20%,50%': { opacity: '0' },
        },
      },
      animation: {
        'loading-dot': 'loading-dot 1.2s ease-in-out infinite',
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'caret-blink': 'caret-blink 1.25s ease-out infinite',
      },
      /**
       * `rounded-sm` through `rounded-3xl` are not restated here: `@librechat/client/theme.css`
       * maps them onto `--theme-radius-*` as `@theme inline`, the same declarations the app
       * compiles, so a consumer's corners are the app's and follow the same theme.
       */
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
     * The published components write `animate-in`, `fade-in-0`, `zoom-in-95` and
     * `slide-in-from-*` (dialogs, popovers, dropdowns), which this plugin owns.
     * It belongs in the preset rather than in the app's config alone: a consumer
     * following the documented setup loads only this file, and without it those
     * classes generate nothing and the surfaces appear without their motion.
     * Declared as a peer dependency so the consumer's install provides it.
     */
    require('tailwindcss-animate'),
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
