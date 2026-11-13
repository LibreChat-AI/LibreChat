export type ReadComposerRoute = () => string;

export const readBrowserComposerRoute: ReadComposerRoute = () =>
  window.location.pathname + window.location.search;
