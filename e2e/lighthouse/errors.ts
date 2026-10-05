/** Keep process diagnostics useful without letting execFile's command echo session cookies. */
export function redactLighthouseError(error: unknown, secrets: readonly string[]): Error {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const redact = (text: string) =>
    values.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), text);
  const original = error instanceof Error ? error : new Error(String(error));
  const sanitized = new Error(redact(original.message));
  sanitized.name = redact(original.name);
  if (original.stack) sanitized.stack = redact(original.stack);
  // Copy only the documented process diagnostics. A cause or arbitrary nested property
  // could retain the original error and print the unredacted command again.
  for (const key of ['code', 'signal', 'killed', 'cmd', 'command', 'stdout', 'stderr']) {
    const value = (original as unknown as Record<string, unknown>)[key];
    if (typeof value === 'string') Object.assign(sanitized, { [key]: redact(value) });
    else if (value === null || typeof value === 'number' || typeof value === 'boolean')
      Object.assign(sanitized, { [key]: value });
  }
  return sanitized;
}

/** chrome-launcher can fail to remove a Windows profile after writing a successful audit. */
export function isCompletedLighthouseCleanup(
  error: Error,
  report: unknown,
  html: string,
  url: string,
  audits: string[],
): boolean {
  const stderr = (error as unknown as Record<string, unknown>).stderr;
  const diagnostic = `${error.message}\n${typeof stderr === 'string' ? stderr : ''}`;
  if (
    !/\bEPERM\b/.test(diagnostic) ||
    !/chrome-launcher/.test(diagnostic) ||
    !/destroyTmp/.test(diagnostic)
  )
    return false;
  if (!/^(?:\s|<!--[\s\S]*?-->)*<!doctype html>/i.test(html) || !/<\/html>\s*$/i.test(html))
    return false;
  if (!report || typeof report !== 'object') return false;
  const result = report as Record<string, unknown>;
  if (result.runtimeError != null || result.finalDisplayedUrl !== url || !result.lighthouseVersion)
    return false;
  if (!result.audits || typeof result.audits !== 'object') return false;
  return audits.every((audit) => {
    const value = (result.audits as Record<string, { numericValue?: unknown }>)[audit]
      ?.numericValue;
    return typeof value === 'number' && Number.isFinite(value);
  });
}
