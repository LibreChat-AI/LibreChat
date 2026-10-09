import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';

/**
 * LibreOffice-backed office preview pipeline.
 *
 * Convert a DOCX / PPTX (eventually XLSX, ODT) buffer to PDF via
 * `soffice --headless --convert-to pdf`, base64-encode it into a sandboxed
 * HTML document, and let pdf.js render each page to `<canvas>` inside the
 * Sandpack iframe. Result: high-fidelity rendering for any format
 * LibreOffice opens (which is "everything"), works inside Sandpack's
 * sandboxed iframe (where the browser's native PDF viewer is blocked).
 * The trade-off is the LibreOffice binary on the server (~250-350 MB disk,
 * ~2-3 s cold-start per first conversion in a process).
 *
 * Native LibreOffice previews are temporarily unavailable. The legacy
 * `OFFICE_PREVIEW_LIBREOFFICE` setting is still parsed for compatibility,
 * but cannot enable conversion. Its historical values were:
 *   - Truthy (`true`, `1`, `yes`): all formats use LibreOffice
 *   - Falsy (`false`, `0`, `no`, empty, unset): no formats — fall through
 *   - Comma-separated list (`pptx`, `pptx,docx`): only those formats
 *
 * The list form lets operators trade off cold-start latency against
 * fidelity per format. Practically: `pptx` is the most common opt-in —
 * pptx-preview chokes on pptxgenjs decks and the slide-list fallback
 * loses all formatting; LibreOffice handles them well. DOCX renders
 * ~instantly via docx-preview so paying the ~2-3 s LibreOffice cold-
 * start there is rarely worth it.
 *
 * When the gate is closed for a given format we fall through to the
 * existing CDN/mammoth/slide-list pipeline so a misconfiguration
 * doesn't break previews.
 *
 * Hardening:
 *   - Subprocess runs in an isolated temp directory (no shared profile, no
 *     access to the operator's home) and a stripped env (`PATH`, `HOME`,
 *     `TMPDIR` only). LibreOffice's `-env:UserInstallation` flag forces a
 *     fresh user profile per call so concurrent conversions can't collide
 *     on shared ~/.config/libreoffice locks.
 *   - 30-second timeout — soffice has been known to hang on malformed input;
 *     `SIGKILL` after the timer expires.
 *   - 50 MB PDF output cap — a runaway document or a deliberate pathology
 *     can't blow the server's disk.
 *   - Macros stay disabled (LibreOffice's default `--macro-security high`
 *     plus our `--norestore --invisible --nodefault` flags).
 *
 * What this module is NOT:
 *   - A LibreOffice service / pool. Each call spawns a fresh subprocess.
 *     If load grows we'd want to keep a long-lived `soffice` process and
 *     drive it via UNO, but that's a v2 concern.
 *   - A native PDF viewer integration. We tried that first — Chrome blocks
 *     `<iframe src="data:application/pdf">` AND `<iframe src="blob:...">`
 *     navigation in sandboxed iframes (the built-in viewer requires a
 *     top-level browsing context). pdf.js is the only thing that works
 *     in our iframe topology.
 */

/**
 * Parse `OFFICE_PREVIEW_LIBREOFFICE` into the set of formats opted in.
 * Three forms:
 *   - Truthy (`true`/`1`/`yes`): all formats
 *   - Falsy (`false`/`0`/`no`/empty/unset): no formats
 *   - Comma-separated list (`pptx`/`pptx,docx`): just those formats
 *
 * Returning `'all'` (vs. a Set containing every format) keeps the gate
 * future-proof — adding a new format to the LibreOffice route doesnt
 * require operators to re-enumerate their env value.
 */
type LibreOfficeFormatEnablement = 'all' | ReadonlySet<string> | null;

const IN_PROCESS_LIBREOFFICE_DISABLED: boolean = true;

function parseLibreOfficeEnablement(value: string | undefined): LibreOfficeFormatEnablement {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (/^(1|true|yes)$/i.test(trimmed)) {
    return 'all';
  }
  if (/^(0|false|no)$/i.test(trimmed)) {
    return null;
  }
  /* Comma-separated format list. Lowercased + trimmed; empty entries
   * dropped so trailing commas / `pptx, ,docx` don't enable spurious
   * formats. */
  const formats = trimmed
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return formats.length > 0 ? new Set(formats) : null;
}

/**
 * Whether the LibreOffice path is enabled for this specific format.
 * Read at call time (not module load) so tests can flip the env
 * without rebuilding.
 *
 * @param format extension token (`docx`, `pptx`, `xlsx`, `odt`, ...)
 */
export function isLibreOfficeEnabledFor(format: string): boolean {
  const enabled = parseLibreOfficeEnablement(process.env.OFFICE_PREVIEW_LIBREOFFICE);
  if (enabled === null) {
    return false;
  }
  if (enabled === 'all') {
    return true;
  }
  return enabled.has(format.toLowerCase());
}

/**
 * Whether ANY format is enabled — kept for diagnostic / probe code that
 * wants to short-circuit binary checks when the feature is fully off.
 * Most production callers should use `isLibreOfficeEnabledFor(format)`.
 */
export function isLibreOfficeEnabled(): boolean {
  return parseLibreOfficeEnablement(process.env.OFFICE_PREVIEW_LIBREOFFICE) !== null;
}

interface BinaryProbe {
  available: boolean;
  binary: string | null;
  versionLine: string | null;
  reason?: string;
}

let cachedProbe: BinaryProbe | null = null;

/**
 * Probe `soffice` then `libreoffice` once per process and cache the result.
 * If the operator installs LibreOffice after server start, they need to
 * restart to pick it up — simpler than invalidating the cache on filesystem
 * events for a feature that's already opt-in.
 */
export async function probeLibreOfficeBinary(): Promise<BinaryProbe> {
  if (cachedProbe) {
    return cachedProbe;
  }
  for (const candidate of ['soffice', 'libreoffice']) {
    try {
      const versionLine = await runVersion(candidate);
      cachedProbe = { available: true, binary: candidate, versionLine };
      return cachedProbe;
    } catch {
      /* try next candidate */
    }
  }
  cachedProbe = {
    available: false,
    binary: null,
    versionLine: null,
    reason: 'neither `soffice` nor `libreoffice` found on $PATH',
  };
  return cachedProbe;
}

function runVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '', HOME: tmpdir() },
    });
    let stdout = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('--version timed out'));
    }, 5_000);
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.split('\n')[0]?.trim() ?? '');
      } else {
        reject(new Error(`exit ${code}`));
      }
    });
  });
}

/** Reset the cached probe — for tests; never called from production code. */
export function _resetLibreOfficeProbeCache(): void {
  cachedProbe = null;
}

/** Maximum subprocess wall-time. Tuned for cold-start on a small DOCX. */
export const LIBREOFFICE_TIMEOUT_MS = 30_000;

/** Maximum PDF output size; refuse anything larger so a runaway doc can't fill the disk. */
export const MAX_LIBREOFFICE_PDF_BYTES: number = 50 * 1024 * 1024;

/** Tag-distinct error so callers can distinguish "binary missing" from "conversion failed". */
export class LibreOfficeUnavailableError extends Error {
  override readonly name = 'LibreOfficeUnavailableError';
}

/** Tag-distinct error so callers can swallow conversion-side failures and fall through. */
export class LibreOfficeConversionError extends Error {
  override readonly name = 'LibreOfficeConversionError';
  constructor(
    message: string,
    readonly stderr?: string,
  ) {
    super(message);
  }
}

/**
 * Spawn a LibreOffice subprocess to convert `buffer` (in `extensionHint`
 * format — `docx`, `pptx`, `xlsx`, `odt`, `odp`, `ods`) to PDF. Returns
 * the PDF bytes.
 *
 * `extensionHint` is part of the temp filename so soffice infers the input
 * format correctly. We never trust the extension to gate format — the
 * caller (`html.ts` dispatcher) has already routed by MIME / magic bytes.
 *
 * Throws:
 *   - `LibreOfficeUnavailableError` when the binary isn't on $PATH
 *   - `LibreOfficeConversionError` for subprocess failures, timeout, or
 *     oversized output
 */
export async function convertOfficeToPdf(buffer: Buffer, extensionHint: string): Promise<Buffer> {
  if (IN_PROCESS_LIBREOFFICE_DISABLED) {
    throw new LibreOfficeUnavailableError(
      'In-process LibreOffice conversion is temporarily disabled',
    );
  }
  const probe = await probeLibreOfficeBinary();
  if (!probe.available || !probe.binary) {
    throw new LibreOfficeUnavailableError(probe.reason ?? 'LibreOffice binary unavailable');
  }
  const safeExt = extensionHint.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  const tempDir = await mkdtemp(join(tmpdir(), 'lc-libreoffice-'));
  try {
    const inputPath = join(tempDir, `input.${safeExt}`);
    await writeFile(inputPath, buffer);
    await runConversion(probe.binary, inputPath, tempDir);
    const outputPath = join(tempDir, 'input.pdf');
    const pdf = await readFile(outputPath);
    if (pdf.length > MAX_LIBREOFFICE_PDF_BYTES) {
      throw new LibreOfficeConversionError(
        `PDF output ${pdf.length} bytes exceeds cap ${MAX_LIBREOFFICE_PDF_BYTES}`,
      );
    }
    return pdf;
  } finally {
    /* Best-effort cleanup. If unlink fails (rare — Linux tmpfs, no
     * unmounts), the OS will reclaim the dir on next reboot. */
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runConversion(binary: string, inputPath: string, tempDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const userProfile = `file://${join(tempDir, 'userprof')}`;
    const proc = spawn(
      binary,
      [
        '--headless',
        '--norestore',
        '--invisible',
        '--nodefault',
        '--nofirststartwizard',
        '--nolockcheck',
        `-env:UserInstallation=${userProfile}`,
        '--convert-to',
        'pdf',
        '--outdir',
        tempDir,
        inputPath,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        /* Stripped env. PATH is required for soffice to find its own libs;
         * HOME/TMPDIR pinned to the isolated temp dir so the subprocess
         * can't read the operator's profile or scribble outside our tree. */
        env: {
          PATH: process.env.PATH ?? '',
          HOME: tempDir,
          TMPDIR: tempDir,
          /* Suppress LibreOffice's "Recovery" dialog state on macOS. */
          DBUS_SESSION_BUS_ADDRESS: 'disabled:',
        },
      },
    );
    let stderr = '';
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(
        new LibreOfficeConversionError(
          `LibreOffice timeout after ${LIBREOFFICE_TIMEOUT_MS}ms`,
          stderr,
        ),
      );
    }, LIBREOFFICE_TIMEOUT_MS);
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(new LibreOfficeConversionError(err.message, stderr));
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new LibreOfficeConversionError(`soffice exit ${code}`, stderr));
      }
    });
  });
}

/**
 * Build the iframe HTML that embeds the PDF for in-panel rendering. The
 * PDF is base64-encoded as a `data:` URI and pointed to by an inner
 * canvas via PDF.js (Mozilla's pdfjs-dist) loaded from CDN.
 *
 * Why PDF.js + canvas (vs. native browser PDF viewer):
 *   We tried `<iframe src="data:application/pdf;...">` first — Chrome
 *   blocks data: PDF navigation in sandboxed iframes since Chrome 76.
 *   We tried `<iframe src="blob:...">` next — Chrome ALSO blocks
 *   blob: PDFs in sandboxed iframes (the built-in PDF viewer requires
 *   a top-level browsing context). The Sandpack host iframe IS
 *   sandboxed, so neither works. Manual e2e on PR #12934 — both
 *   produced the "This page has been blocked by Chrome" interstitial.
 *
 *   PDF.js renders to `<canvas>` which works in ANY context (sandboxed,
 *   embedded, restricted CSP) because it's pure JS — no plugin, no
 *   privileged viewer. ~1 MB CDN load is acceptable for a feature
 *   that's already env-gated and opt-in.
 *
 * Worker handling:
 *   PDF.js wants a Web Worker for parsing (offloads CPU from main
 *   thread). The worker URL is loaded from the same jsdelivr origin;
 *   CSP `worker-src https://cdn.jsdelivr.net blob:` allows it. blob:
 *   covers the case where pdf.js wraps the worker source in a Blob
 *   to dodge cross-origin worker restrictions.
 */
const PDF_JS_CDN = {
  /* Pinned to v3.11.174 (last v3 release) — it's a single-file UMD
   * bundle that loads via a plain `<script>` tag. v4+ uses ES modules
   * (`pdf.min.mjs`) which complicates the load + SRI flow. v3 still
   * receives security backports per Mozilla's policy.
   *
   * SRI hashes intentionally OMITTED here (unlike docx-preview /
   * pptx-preview) because the LibreOffice preview path is opt-in and
   * the operator has already chosen to trust the LibreOffice render
   * pipeline. Adding SRI is a follow-up worth doing once this path
   * is proven in production. */
  pdf: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
} as const;

export function buildPdfEmbedDocument(pdfBase64: string): string {
  /* CSP scoping:
   *   - `default-src 'none'`: lock everything down.
   *   - `script-src https://cdn.jsdelivr.net 'unsafe-inline'`: load
   *     pdf.js from CDN + run our bootstrap inline.
   *   - `worker-src https://cdn.jsdelivr.net blob:`: pdf.js spawns a
   *     parser worker; jsdelivr is the origin we loaded the worker
   *     script from, blob: covers pdf.js's same-origin worker wrap.
   *   - `connect-src 'none'`: pdf.js doesn't fetch anything — the
   *     PDF bytes are inline, fonts are subset-embedded by LibreOffice.
   *   - `style-src 'unsafe-inline'`: page chrome.
   *   - `img-src 'self' data: blob:`: pdf.js may rasterize embedded
   *     bitmaps via canvas (data:/blob: covers internal handoffs). */
  const csp = [
    "default-src 'none'",
    "script-src https://cdn.jsdelivr.net 'unsafe-inline'",
    'worker-src https://cdn.jsdelivr.net blob:',
    "style-src 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Preview</title>
<style>
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2937; --muted: #6b7280; }
@media (prefers-color-scheme: dark) { :root { --bg: #1a1a2e; --fg: #e5e7eb; --muted: #9ca3af; } }
html, body { margin: 0; padding: 0; min-height: 100vh; background: var(--bg); color: var(--fg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
#lc-render { padding: 16px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; gap: 16px; }
#lc-render canvas { max-width: 100%; height: auto; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18); border-radius: 4px; background: #ffffff; }
#lc-loading { padding: 24px; color: var(--muted); font-size: 14px; text-align: center; }
#lc-fallback { display: none; padding: 24px; font-size: 14px; line-height: 1.5; color: var(--muted); text-align: center; }
#lc-fallback.visible { display: block; }
#lc-fallback-reason { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); margin-top: 6px; word-break: break-word; }
</style>
<script src="${PDF_JS_CDN.pdf}"></script>
</head>
<body>
<div id="lc-render"><div id="lc-loading">Loading preview…</div></div>
<div id="lc-fallback">
  <p>PDF preview unavailable. Please download the file to view it.</p>
  <details style="margin-top: 8px;">
    <summary style="cursor: pointer; font-size: 12px;">Diagnostic details</summary>
    <div id="lc-fallback-reason"></div>
  </details>
</div>
<script id="lc-pdf-data" type="application/octet-stream;base64">${pdfBase64}</script>
<script>
(function () {
  var container = document.getElementById('lc-render');
  var loading = document.getElementById('lc-loading');
  var fallback = document.getElementById('lc-fallback');
  var reasonEl = document.getElementById('lc-fallback-reason');
  var settled = false;

  function showFallback(reason) {
    if (settled) { return; }
    settled = true;
    if (loading) { loading.remove(); }
    if (container) { container.style.display = 'none'; }
    if (fallback) { fallback.classList.add('visible'); }
    var text = reason ? String(reason).slice(0, 500) : 'no reason reported';
    if (reasonEl) { reasonEl.textContent = text; }
    if (typeof console !== 'undefined' && console.error) {
      console.error('[libreoffice-pdf] fallback fired:', text);
    }
  }
  function markSuccess() { settled = true; }

  /* pdf.js wraps async errors as unhandled rejections; catch them at
   * the window level so we never silently fail. */
  window.addEventListener('unhandledrejection', function (e) {
    if (settled) { return; }
    showFallback((e.reason && e.reason.message) || 'unhandled-rejection');
  });
  window.addEventListener('error', function (e) {
    if (settled) { return; }
    showFallback((e.error && e.error.message) || e.message || 'script-error');
  });

  if (typeof pdfjsLib === 'undefined' || typeof pdfjsLib.getDocument !== 'function') {
    showFallback('renderer-not-loaded (pdf.js failed to load from jsdelivr)');
    return;
  }

  /* Point the worker at the same CDN version we loaded the main
   * script from. pdf.js fetches this URL and spawns a Worker; CSP
   * worker-src covers it. */
  pdfjsLib.GlobalWorkerOptions.workerSrc = '${PDF_JS_CDN.worker}';

  try {
    var b64 = document.getElementById('lc-pdf-data').textContent.trim();
    var bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });

    pdfjsLib.getDocument({ data: bytes }).promise.then(function (pdf) {
      if (loading) { loading.remove(); }

      /* Render each page sequentially. We pick a render scale based
       * on the panel width and the first pages native dimensions so
       * the canvas matches the panel — no upscaling required by CSS
       * (which would blur it). DPR-aware so retina screens get crisp
       * pixels. */
      var dpr = window.devicePixelRatio || 1;
      var panelWidth = (container.clientWidth || window.innerWidth) - 32;

      function renderPage(pageNum) {
        return pdf.getPage(pageNum).then(function (page) {
          var unscaledViewport = page.getViewport({ scale: 1 });
          var cssScale = Math.max(0.1, panelWidth / unscaledViewport.width);
          var viewport = page.getViewport({ scale: cssScale * dpr });
          var canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          /* CSS dimensions in logical pixels; canvas backing store at
           * DPR multiplier for crisp rendering. */
          canvas.style.width = (viewport.width / dpr) + 'px';
          canvas.style.height = (viewport.height / dpr) + 'px';
          container.appendChild(canvas);
          var ctx = canvas.getContext('2d');
          return page.render({ canvasContext: ctx, viewport: viewport }).promise;
        });
      }

      var chain = Promise.resolve();
      for (var i = 1; i <= pdf.numPages; i++) {
        (function (pageNum) {
          chain = chain.then(function () { return renderPage(pageNum); });
        })(i);
      }
      return chain.then(markSuccess);
    }).catch(function (err) {
      showFallback((err && err.message) || 'pdf-render-failed');
    });

    /* Safety net: if 15 seconds in pdf.js hasnt rendered anything
     * visible, accept whatever we have or fall through. PDF.js is
     * usually fast (<1s for typical chat decks), but big PDFs with
     * many slides + DPR=2 can take longer. */
    setTimeout(function () {
      if (settled) { return; }
      if (container && container.querySelectorAll('canvas').length > 0) {
        markSuccess();
        return;
      }
      showFallback('pdf-render-timeout');
    }, 15000);
  } catch (err) {
    showFallback((err && err.message) || 'bootstrap-error');
  }
})();
</script>
</body>
</html>`;
}

/**
 * Try the LibreOffice path. Returns the wrapped HTML on success, or `null`
 * if LibreOffice isn't enabled / available / converted successfully — the
 * caller falls through to the existing pipeline. Never throws.
 *
 * `extensionHint`: `docx` / `pptx` / `xlsx` / `odt` / `odp` / `ods` etc.
 *
 * Output-size guarantee: returns `null` if the embedded HTML would exceed
 * the 512 KB `attachment.text` cache cap. Base64 inflates by ~33% so the
 * effective PDF cap is ~380 KB; LibreOffice's PDF/A-1 default produces
 * compact output for typical chat-emitted documents.
 */
export async function tryLibreOfficePreview(
  buffer: Buffer,
  extensionHint: string,
  outputCap: number,
): Promise<string | null> {
  if (IN_PROCESS_LIBREOFFICE_DISABLED) {
    return null;
  }
  if (!isLibreOfficeEnabledFor(extensionHint)) {
    return null;
  }
  try {
    const pdf = await convertOfficeToPdf(buffer, extensionHint);
    const base64 = pdf.toString('base64');
    const html = buildPdfEmbedDocument(base64);
    if (Buffer.byteLength(html, 'utf-8') > outputCap) {
      return null;
    }
    return html;
  } catch (err) {
    /* Swallow both unavailable + conversion errors. The dispatcher
     * pipeline is the authoritative renderer; LibreOffice is opportunistic
     * augmentation. The caller's logger will surface the underlying
     * pipeline if they care to instrument it. */
    void err;
    return null;
  }
}
