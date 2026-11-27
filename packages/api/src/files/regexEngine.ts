import { RE2JS } from 're2js';
import { setFileConfigRegexCompiler } from 'librechat-data-provider';

/**
 * Route admin-configured file-config MIME patterns through a linear-time engine (RE2) on the
 * server so a catastrophic-backtracking pattern cannot ReDoS the event loop when tested against
 * an uploaded file's Content-Type. Call once at server startup, before any upload is handled.
 * Browser builds keep the native compiler, so no regex engine is added to the client bundle.
 */
export function configureFileConfigRegexEngine(): void {
  setFileConfigRegexCompiler((pattern) => RE2JS.compile(pattern));
}
