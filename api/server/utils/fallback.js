/** Static asset extensions that must 404 when missing — serving the SPA's
 * index.html for them breaks strict MIME checks and poisons SW/browser caches. */
const STATIC_ASSET_EXT =
  /\.(?:js|mjs|css|map|json|wasm|webmanifest|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot)$/i;

/**
 * Creates the SPA fallback middleware: serves index.html for unmatched
 * routes while returning 404 for missing static assets.
 * @param {(req: import('express').Request, res: import('express').Response) => void} sendIndexHtml
 */
function createSpaFallback(sendIndexHtml) {
  return (req, res) => {
    if (STATIC_ASSET_EXT.test(req.path)) {
      return res.status(404).end();
    }
    return sendIndexHtml(req, res);
  };
}

module.exports = createSpaFallback;
