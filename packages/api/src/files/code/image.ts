import { logger } from '@librechat/data-schemas';

/**
 * Windowed base64 reader for images living in a code-execution sandbox.
 *
 * The bytes can only come back through `/exec` stdout, which the runner
 * truncates and SIGKILLs past its own `SANDBOX_OUTPUT_MAX_SIZE`. One read
 * is therefore a series of `/exec` calls, each spending a request against
 * the Code API's per-user execution limiter (20 per 30s in the reference
 * deployment). Everything here exists to keep that count down and bounded:
 * the window fills the runner's stdout budget, narrows itself if a runner
 * rejects it, and a file that still needs more calls than one read may
 * spend is reported as unreadable-inline rather than stalling a chat turn
 * across limiter windows.
 *
 * The transport stays with the caller ({@link SandboxImageChunkReader}) so
 * this module owns only the sizing, windowing, and assembly decisions.
 */

/**
 * Sandbox stdout a single `/exec` response may carry, in bytes — 64KB in
 * the reference deployment. Deployments that changed the runner's cap set
 * `LIBRECHAT_CODE_SANDBOX_OUTPUT_MAX_SIZE` to match; a smaller cap is also
 * discovered at runtime (see {@link narrowSandboxImageChunkBytes}).
 */
const DEFAULT_SANDBOX_OUTPUT_MAX_SIZE = 64 * 1024;

/** JSON envelope around the base64 window (`{"total":…,"n":…,"b64":"…"}`),
 *  plus room for a trailing newline and a stray shell banner line. */
const IMAGE_CHUNK_ENVELOPE_BYTES = 256;

/** Base64 encodes in 3-byte groups; windowing on a multiple of 3 keeps
 *  every response padding-free. */
const BASE64_GROUP_BYTES = 3;

/**
 * Hard round-trip ceiling for one image read, matched to a single window of
 * the Code API's per-user execution limiter (20 requests per 30s in the
 * reference deployment). Beyond it a read would have to wait out limiter
 * windows to finish, stalling a chat turn; a file that needs more windows
 * than this degrades to the same "too large to inline" result as one over
 * the byte cap — and {@link readWindowedSandboxImage} detects that from the
 * first window rather than spending the whole budget discovering it.
 */
export const MAX_SANDBOX_IMAGE_EXEC_CALLS = 20;

/** Per-base-URL window size, narrowed in place the first time a runner
 *  reports truncation so later reads start at a size it accepts. */
const learnedChunkBytes = new Map<string, number>();

/**
 * One `/exec` window's outcome, as the transport observed it. Fields are
 * optional because the body is whatever the in-sandbox reader printed:
 * `error` when it refused the path, `too_large` when the file is over the
 * caller's cap, `total`/`n`/`b64` for a window of bytes, `outputOverflow`
 * when the runner truncated the response, and nothing at all when it
 * produced no output.
 */
export interface SandboxImageChunk {
  outputOverflow?: boolean;
  /** Bytes of stdout the runner did emit before truncating — its actual
   *  cap, and a far better next window than another blind halving. */
  observedStdoutBytes?: number;
  error?: string;
  too_large?: boolean;
  bytes?: number;
  total?: number;
  n?: number;
  b64?: string;
}

export type SandboxImageChunkReader = (params: { code: string }) => Promise<SandboxImageChunk>;

export type SandboxImageReadResult =
  | { base64: string; bytes: number }
  /** `size`: over the caller's cap. `round_trips`: within the byte cap, but
   *  more windows than {@link MAX_SANDBOX_IMAGE_EXEC_CALLS} allows —
   *  `inlineCeiling` is the largest file this deployment's window size can
   *  actually deliver, which the caller can name as a downscale target. */
  | { tooLarge: true; reason: 'size' | 'round_trips'; bytes: number; inlineCeiling?: number }
  | null;

/**
 * Raw bytes to pull per `/exec` round-trip. Each window is base64-encoded
 * (~1.33x) into the response's stdout, so the auto-derived size is the
 * largest multiple of 3 whose encoding plus envelope fits the runner's
 * stdout budget. `LIBRECHAT_CODE_IMAGE_CHUNK_BYTES` overrides it outright
 * and is used verbatim, multiple of 3 or not.
 */
export function getSandboxImageChunkBytes(baseUrl?: string): number {
  const baseline = baselineChunkBytes();
  const learned = baseUrl == null ? undefined : learnedChunkBytes.get(baseUrl);
  /* A learned narrowing only ever caps the configured size: an operator who
   * sets a smaller window explicitly still wins. */
  return learned == null ? baseline : Math.min(learned, baseline);
}

function baselineChunkBytes(): number {
  const override = Number(process.env.LIBRECHAT_CODE_IMAGE_CHUNK_BYTES);
  if (Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const configured = Number(process.env.LIBRECHAT_CODE_SANDBOX_OUTPUT_MAX_SIZE);
  return chunkBytesForBudget(
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_SANDBOX_OUTPUT_MAX_SIZE,
  );
}

/** Largest window whose base64 encoding plus envelope fits `budget`. */
function chunkBytesForBudget(budget: number): number {
  const usable = Math.max(budget - IMAGE_CHUNK_ENVELOPE_BYTES, 0);
  return alignToBase64Group(Math.floor((usable * 3) / 4));
}

function alignToBase64Group(bytes: number): number {
  return Math.max(Math.floor(bytes / BASE64_GROUP_BYTES) * BASE64_GROUP_BYTES, BASE64_GROUP_BYTES);
}

/**
 * Returns the window to retry a truncated read with, or `null` when no
 * smaller one exists.
 *
 * A truncated response reveals the runner's real cap — it emitted exactly
 * as much as it allows — so `observedStdoutBytes` sizes the retry directly
 * and one round-trip is usually enough to land on a size that fits. Blind
 * halving is the fallback, and bounds the result either way so every retry
 * is strictly smaller than the window that just failed.
 *
 * The reduction is computed from the caller's own failing window, never
 * from the shared learned value: reads run concurrently (one per tool
 * call), so two reads failing at the same size would otherwise reduce the
 * shared value twice and skip a size the runner would have accepted. For
 * the same reason the learned value only ever moves down to the narrowest
 * size any read has needed.
 */
export function narrowSandboxImageChunkBytes(
  failedChunkBytes: number,
  baseUrl?: string,
  observedStdoutBytes?: number,
): number | null {
  const halved = alignToBase64Group(Math.floor(failedChunkBytes / 2));
  const fromObserved =
    observedStdoutBytes != null && observedStdoutBytes > 0
      ? chunkBytesForBudget(observedStdoutBytes)
      : Number.POSITIVE_INFINITY;
  const narrowed = Math.min(halved, fromObserved);
  /* Already as small as a base64 group: this runner cannot emit an image
   * window at all, and another attempt would only be truncated again. */
  if (narrowed >= failedChunkBytes) {
    return null;
  }
  if (baseUrl != null) {
    const learned = learnedChunkBytes.get(baseUrl);
    learnedChunkBytes.set(baseUrl, learned == null ? narrowed : Math.min(learned, narrowed));
  }
  logger.warn(
    `[readSandboxImage] Sandbox stdout limit exceeded at ${failedChunkBytes} bytes; retrying with ${narrowed} for ${baseUrl}. ` +
      "Set LIBRECHAT_CODE_SANDBOX_OUTPUT_MAX_SIZE to this runner's stdout cap to skip the discovery reads.",
  );
  return narrowed;
}

/**
 * The in-sandbox reader for one window. Stats the file, refuses (without
 * transferring) anything over `limit` or any non-regular file, and prints
 * a single JSON line the transport hands back as a {@link SandboxImageChunk}.
 * The parameters travel base64-encoded so neither the path nor the numbers
 * are interpolated into shell syntax.
 */
export function buildSandboxImageReaderCode(params: {
  filePath: string;
  limit: number;
  offset: number;
  chunkBytes: number;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      file_path: params.filePath,
      limit: params.limit,
      offset: params.offset,
      chunk: params.chunkBytes,
    }),
    'utf8',
  ).toString('base64');
  return [
    "python3 - <<'PY'",
    'import base64, json, os, stat',
    `payload = ${JSON.stringify(payload)}`,
    "data = json.loads(base64.b64decode(payload).decode('utf-8'))",
    "p = data['file_path']",
    "limit = data['limit']",
    "offset = data['offset']",
    "chunk = data['chunk']",
    'try:',
    '    st = os.stat(p)',
    'except OSError as e:',
    '    print(json.dumps({"error": str(e)}))',
    '    raise SystemExit(0)',
    // Reject FIFOs, sockets, and device files (e.g. a symlink to /dev/zero):
    // os.stat can report a small/zero size while an unbounded read blocks or
    // streams forever until the request times out.
    'if not stat.S_ISREG(st.st_mode):',
    '    print(json.dumps({"error": "not a regular file"}))',
    '    raise SystemExit(0)',
    'if st.st_size > limit:',
    '    print(json.dumps({"too_large": True, "bytes": st.st_size}))',
    '    raise SystemExit(0)',
    // Read only this window. The whole base64 payload cannot be emitted in
    // one shot: the runner caps stdout at SANDBOX_OUTPUT_MAX_SIZE and
    // SIGKILLs the job on overflow, which truncates the JSON mid-string.
    "with open(p, 'rb') as f:",
    '    f.seek(offset)',
    '    raw = f.read(chunk)',
    'print(json.dumps({"total": st.st_size, "n": len(raw), "b64": base64.b64encode(raw).decode("ascii")}))',
    'PY',
  ].join('\n');
}

/**
 * Turns one `/exec` response into a {@link SandboxImageChunk}. Throws only
 * for output the reader could not have produced, so the caller can tell a
 * broken transport from a file the sandbox declined to serve.
 */
export function parseSandboxImageChunk(response: {
  stdout?: unknown;
  stderr?: unknown;
  status?: unknown;
}): SandboxImageChunk {
  /* The runner truncates stdout at SANDBOX_OUTPUT_MAX_SIZE and SIGKILLs the
   * job (status `OL`). Detect that explicitly: the surviving stdout is a
   * base64 string cut mid-flight, so parsing it yields a misleading
   * "unexpected output" instead of the narrowable, fixable cause. */
  const stdout = response.stdout == null ? '' : String(response.stdout);
  if (response.status === 'OL') {
    /* What survived is exactly what the runner allows, so it doubles as a
     * measurement of the cap this deployment never declared. */
    return { outputOverflow: true, observedStdoutBytes: stdout.length };
  }
  if (response.stderr && stdout === '') {
    throw new Error(String(response.stderr).trim());
  }
  if (stdout.trim() === '') {
    return {};
  }
  /* Parse the LAST non-empty line: the reader's JSON is the final thing it
   * prints, so anything a shell profile or library emitted ahead of it
   * (banners, warnings) must not break the read. */
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    throw new Error(
      `Unexpected output while reading image bytes from the sandbox: ${stdout.slice(0, 120)}`,
    );
  }
}

/**
 * Pulls a sandbox image through as many windows as it takes, narrowing the
 * window if the runner truncates and stopping at the round-trip ceiling.
 * Returns `null` when the runner produced no output at all; throws what
 * the transport throws.
 */
export async function readWindowedSandboxImage(params: {
  filePath: string;
  limit: number;
  baseUrl?: string;
  readChunk: SandboxImageChunkReader;
}): Promise<SandboxImageReadResult> {
  const { filePath, limit, baseUrl, readChunk } = params;
  let chunkBytes = getSandboxImageChunkBytes(baseUrl);
  let sawOverflow = false;
  const parts: Buffer[] = [];
  let offset = 0;
  let total: number | null = null;

  for (let call = 0; call < MAX_SANDBOX_IMAGE_EXEC_CALLS; call++) {
    const chunk = await readChunk({
      code: buildSandboxImageReaderCode({ filePath, limit, offset, chunkBytes }),
    });

    if (chunk.outputOverflow === true) {
      /* The runner's stdout cap is smaller than this deployment assumed.
       * Halve the window and re-read the same offset rather than failing
       * the whole image; keep halving until the runner accepts a size or
       * the floor says it never will. */
      sawOverflow = true;
      const narrowed = narrowSandboxImageChunkBytes(chunkBytes, baseUrl, chunk.observedStdoutBytes);
      if (narrowed == null) {
        throw new Error(
          `Reading "${filePath}" exceeded the sandbox stdout limit (window ${chunkBytes} bytes).`,
        );
      }
      chunkBytes = narrowed;
      continue;
    }
    if (chunk.error) {
      throw new Error(String(chunk.error));
    }
    if (chunk.too_large === true) {
      return { tooLarge: true, reason: 'size', bytes: Number(chunk.bytes) || 0 };
    }
    if (typeof chunk.b64 !== 'string' || typeof chunk.n !== 'number') {
      return null;
    }

    if (total == null) {
      total = Number(chunk.total) || 0;
      if (total > limit) {
        return { tooLarge: true, reason: 'size', bytes: total };
      }
    } else if (Number(chunk.total) !== total) {
      /* The file changed underneath us; a spliced-together buffer would be
       * a mix of two versions rather than any real image. */
      throw new Error(`"${filePath}" changed while being read from the sandbox`);
    }

    parts.push(Buffer.from(chunk.b64, 'base64'));
    offset += chunk.n;

    if (chunk.n === 0 || offset >= total) {
      break;
    }
    /* The first window reveals both the file's size and what a call really
     * delivers, so a read that cannot finish is known now rather than after
     * draining the limiter. Project from the bytes actually returned, not
     * the window requested: a runner that serves short reads would other-
     * wise look like it was keeping up. */
    if (Math.ceil((total - offset) / chunk.n) > MAX_SANDBOX_IMAGE_EXEC_CALLS - call - 1) {
      return {
        tooLarge: true,
        reason: 'round_trips',
        bytes: total,
        inlineCeiling: chunk.n * MAX_SANDBOX_IMAGE_EXEC_CALLS,
      };
    }
  }

  if (total == null) {
    /* Every call was spent narrowing: the runner never accepted a window. */
    if (sawOverflow) {
      throw new Error(
        `Reading "${filePath}" exceeded the sandbox stdout limit (window ${chunkBytes} bytes).`,
      );
    }
    return null;
  }
  const buffer = Buffer.concat(parts);
  if (buffer.length !== total) {
    /* Short reads: returning a partial image would render as a corrupt
     * file, so surface it as unreadable-inline with the reason the caller
     * should report. */
    return {
      tooLarge: true,
      reason: 'round_trips',
      bytes: total,
      inlineCeiling: buffer.length,
    };
  }
  return { base64: buffer.toString('base64'), bytes: buffer.length };
}
