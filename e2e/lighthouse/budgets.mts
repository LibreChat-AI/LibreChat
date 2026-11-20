/** Budgets keyed by Lighthouse audit id. */
export type Budgets = Record<string, number>;

/**
 * The numbers live apart from the runner so a fork that ships a heavier client changes this
 * file alone. `total-blocking-time` is asserted at the reference CPU: see `measure.mts`.
 */
export const BUDGETS: Budgets = {
  'largest-contentful-paint': 4500,
  'cumulative-layout-shift': 0.1,
  'total-blocking-time': 500,
};
