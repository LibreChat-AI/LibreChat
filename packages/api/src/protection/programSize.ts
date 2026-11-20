import { RE2JS } from 're2js';

const MAX_CACHE_ENTRIES = 512;
const PROGRAM_SIZE_CACHE = new Map<string, number | null>();

/**
 * Size of a PII pattern in RE2 instructions, or null when RE2 cannot compile it. The server
 * registers this with `setPiiRegexProgramSizer` so config validation and the runtime detectors
 * measure patterns with the same engine.
 */
export function getPiiRegexProgramSize(pattern: string): number | null {
  if (PROGRAM_SIZE_CACHE.has(pattern)) {
    return PROGRAM_SIZE_CACHE.get(pattern) ?? null;
  }
  let programSize: number | null = null;
  let compiled: RE2JS | undefined;
  try {
    compiled = RE2JS.compile(pattern);
    const candidate = compiled.programSize();
    if (Number.isSafeInteger(candidate) && candidate > 0) {
      programSize = candidate;
    }
  } catch {
    programSize = null;
  } finally {
    compiled?.reset();
  }
  if (PROGRAM_SIZE_CACHE.size >= MAX_CACHE_ENTRIES) {
    PROGRAM_SIZE_CACHE.clear();
  }
  PROGRAM_SIZE_CACHE.set(pattern, programSize);
  return programSize;
}
