/**
 * The modern @ariakit/* split packages (react-components and its peers) are ESM-only and
 * declare only an `import` export condition, which jest's CJS resolver can't match. Resolve
 * those with the `import` condition; babel (see transformIgnorePatterns) transpiles them to CJS.
 */
const ESM_ONLY_ARIAKIT =
  /^@ariakit\/(react-components|react-utils|react-store|components|store|utils)(\/|$)/;

module.exports = (request, options) => {
  if (ESM_ONLY_ARIAKIT.test(request)) {
    return options.defaultResolver(request, {
      ...options,
      conditions: [...(options.conditions ?? []), 'import'],
    });
  }
  return options.defaultResolver(request, options);
};
