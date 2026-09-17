import { MAX_PARSER_OUTPUT_BYTES, runNativeParserChild } from '../documents/nativeProcess';

/** Deadline a caller that configures none gets. */
const ANYDOC_CHILD_TIMEOUT_MS = 30_000;

/** Measured here so an oversized conversion never crosses IPC into the API process. */
const CHILD_SOURCE = `
process.once('message', async (request) => {
  const fs = require('fs');
  try {
    const anydoc = require(request.modulePath);
    const data = fs.readFileSync(request.path);
    const markdown = await anydoc.toMarkdownBytes(new Uint8Array(data), request.format);
    const bytes = __serializedBytes(markdown);
    if (bytes > request.maxOutputBytes) {
      process.send({
        ok: false,
        code: 'PARSER_OUTPUT_LIMIT',
        message:
          'extracted ' +
          Math.round(bytes / (1024 * 1024)) +
          'MB of text, over the ' +
          Math.round(request.maxOutputBytes / (1024 * 1024)) +
          'MB limit',
      });
      return;
    }
    process.send({ ok: true, result: markdown });
  } catch (error) {
    process.send({ ok: false, message: error && error.message ? error.message : String(error) });
  }
});
`;

/** Parse an AnyDoc-supported document outside the API process. */
export function extractMarkdownIsolated(
  filePath: string,
  format: string | null,
  signal?: AbortSignal,
  timeoutMs: number = ANYDOC_CHILD_TIMEOUT_MS,
): Promise<string> {
  return runNativeParserChild<string>({
    childSource: CHILD_SOURCE,
    parserName: 'anydoc',
    request: {
      path: filePath,
      format,
      modulePath: require.resolve('@firecrawl/anydoc'),
      maxOutputBytes: MAX_PARSER_OUTPUT_BYTES,
    },
    timeoutMs,
    signal,
  });
}
