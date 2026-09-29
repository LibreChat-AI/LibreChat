/** Identify the loaded entry asset, not the version returned by a newer server. */
export function getClientBuildId(targetDocument = document) {
  const buildId = targetDocument.querySelector('meta[name="lc-asset-build-id"]')?.content;
  if (/^assets-[a-f0-9]{64}$/.test(buildId ?? '')) {
    return buildId;
  }
  for (const script of targetDocument.querySelectorAll('script[type="module"][src]')) {
    const filename = script.getAttribute('src').split(/[?#]/, 1)[0].split('/').pop();
    if (/^index[.-][\w-]+\.js$/.test(filename)) {
      return filename;
    }
  }
  return 'unknown';
}
