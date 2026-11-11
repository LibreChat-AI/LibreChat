/** jsdom has no TextEncoder; the subagent reducers measure payload sizes with it. */
const { TextEncoder } = require('node:util');

if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = TextEncoder;
}

/** jsdom has no layout, so it ships none of the observers or media queries every browser has. The
 *  message list's rail and scroll control need them to mount; a spec about what they report
 *  installs its own. */
if (typeof window !== 'undefined') {
  class InertObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  window.IntersectionObserver ??= InertObserver;
  window.ResizeObserver ??= InertObserver;
  window.matchMedia ??= (media) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
}
