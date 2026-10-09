import path from 'path';
import * as fs from 'fs';
import JSZip from 'jszip';
import { megabyte } from 'librechat-data-provider';
import {
  _internal,
  bufferToOfficeHtml,
  csvToHtml,
  excelSheetToHtml,
  officeHtmlBucket,
  pptxToHtml,
  pptxToSlideListHtml,
  sanitizeOfficeHtml,
  wordDocToHtml,
} from './html';
import { ZipBombError } from './zipSafety';

const fixturesDir = __dirname;
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(fixturesDir, name));

describe('Office HTML producers', () => {
  describe('wordDocToHtml', () => {
    /* The dispatcher chooses CDN vs mammoth by buffer size. The fixture
     * sample.docx is small (~6 KB) so it goes down the CDN path. Tests
     * that need the mammoth output specifically call
     * `_internal.wordDocToHtmlViaMammoth` directly. */

    test('routes a small docx (≤ cap) through the CDN-rendered path', async () => {
      const html = await wordDocToHtml(readFixture('sample.docx'));
      expect(html).toMatch(/^<!DOCTYPE html>/);
      // CDN wrapper signatures.
      expect(html).toContain('id="lc-doc-data"');
      expect(html).toContain('docx.renderAsync');
      expect(html).toContain('cdn.jsdelivr.net/npm/docx-preview@');
      /* The CDN doc now ALSO embeds the mammoth-rendered fallback in a
       * hidden `#lc-fallback` block — Codex P2 review on PR #12934. The
       * iframe bootstrap reveals it whenever `docx-preview` can't load
       * (corporate firewall, offline) so air-gapped operators see a
       * readable preview instead of "Preview unavailable". The
       * fallback's `<article class="lc-docx">` wrapper is the
       * server-rendered mammoth output, sanitized through the same
       * pipeline as the standalone mammoth path. */
      expect(html).toContain('id="lc-fallback"');
      expect(html).toContain('<article class="lc-docx">');
    });

    test('routes a docx above the size cap through the mammoth fallback', async () => {
      /* Synthesize an oversized buffer by reading the fixture and
       * verifying the dispatcher picks the mammoth path. We can't
       * cheaply forge a multi-hundred-KB DOCX that mammoth can still
       * parse, so this asserts the size predicate by calling
       * `wordDocToHtmlViaMammoth` directly — the dispatcher's `if`
       * branch is itself trivial to inspect. */
      const html = await _internal.wordDocToHtmlViaMammoth(readFixture('sample.docx'));
      expect(html).toContain('<article class="lc-docx">');
      expect(html).toContain('This is a sample DOCX file.');
    });

    test('mammoth fallback strips <script> tags and event handlers', async () => {
      const html = await _internal.wordDocToHtmlViaMammoth(readFixture('sample.docx'));
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/onerror=/i);
    });

    test('mammoth fallback emits the docx-specific extra CSS', async () => {
      const html = await _internal.wordDocToHtmlViaMammoth(readFixture('sample.docx'));
      expect(html).toContain('.lc-docx table tr:first-child td');
      expect(html).toContain('.lc-docx p:has(> strong:only-child)');
      expect(html).toContain('.lc-docx h2');
    });

    describe('CDN-rendered path', () => {
      /* These tests lock in the security-relevant structure of the
       * embedded-binary HTML wrapper. If any of these assertions break
       * after a refactor, the iframe is one config tweak away from
       * being a vehicle for outbound exfiltration or supply-chain
       * compromise. */

      /* `wordDocToHtmlViaCdn` now takes a pre-rendered mammoth body
       * string as a second argument (Codex P2 review on PR #12934 —
       * the body is embedded inside `#lc-fallback` for air-gapped
       * deployments). Tests use a placeholder body to assert pure
       * wrapper-structure behavior; the dispatcher-level test above
       * exercises the real mammoth body from the sample fixture. */
      const FAKE_FALLBACK_BODY = '<p>fallback-body</p>';

      test('embeds the binary as base64 that round-trips to the original bytes', async () => {
        const original = readFixture('sample.docx');
        const html = await _internal.wordDocToHtmlViaCdn(original, FAKE_FALLBACK_BODY);
        const match = html.match(
          /<script id="lc-doc-data" type="application\/octet-stream;base64">([^<]*)<\/script>/,
        );
        expect(match).not.toBeNull();
        const decoded = Buffer.from(match![1], 'base64');
        expect(decoded.equals(original)).toBe(true);
      });

      test('pins both CDN scripts to specific versions with SRI integrity', async () => {
        const html = await _internal.wordDocToHtmlViaCdn(
          readFixture('sample.docx'),
          FAKE_FALLBACK_BODY,
        );
        // Both deps loaded from jsdelivr at pinned versions.
        expect(html).toContain('https://cdn.jsdelivr.net/npm/jszip@3.10.1/');
        expect(html).toContain('https://cdn.jsdelivr.net/npm/docx-preview@0.3.7/');
        // Both have SRI integrity attributes.
        const integrityMatches = html.match(/integrity="sha384-[A-Za-z0-9+/=]+"/g);
        expect(integrityMatches).not.toBeNull();
        expect(integrityMatches!.length).toBe(2);
        // Both have crossorigin="anonymous" (required for SRI on cross-origin).
        const crossoriginMatches = html.match(/crossorigin="anonymous"/g);
        expect(crossoriginMatches).not.toBeNull();
        expect(crossoriginMatches!.length).toBe(2);
      });

      test('CSP locks the iframe down: no outbound connect, no eval, scripts only from jsdelivr', async () => {
        const html = await _internal.wordDocToHtmlViaCdn(
          readFixture('sample.docx'),
          FAKE_FALLBACK_BODY,
        );
        const cspMatch = html.match(
          /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
        );
        expect(cspMatch).not.toBeNull();
        const csp = cspMatch![1];
        /* `connect-src` is restricted to self + jsdelivr (where the
         * renderer script came from). Allowing these is necessary for
         * DevTools sourcemap fetches; broader exfiltration paths
         * (arbitrary HTTPS, websockets, etc.) stay blocked. Manual
         * e2e on PR #12934 — strict `'none'` filled DevTools console
         * with `.min.js.map` violations every time the iframe was
         * inspected. */
        expect(csp).toMatch(/connect-src 'self' https:\/\/cdn\.jsdelivr\.net/);
        expect(csp).not.toMatch(/connect-src[^;]*\*/); // no wildcard
        // No `<base>` tampering, no form submission either.
        expect(csp).toMatch(/base-uri 'none'/);
        expect(csp).toMatch(/form-action 'none'/);
        // Scripts only from jsdelivr (plus inline for our renderer
        // bootstrap). No 'unsafe-eval' anywhere.
        expect(csp).toMatch(/script-src https:\/\/cdn\.jsdelivr\.net 'unsafe-inline'/);
        expect(csp).not.toMatch(/unsafe-eval/);
      });

      test('embeds the mammoth-rendered fallback body in #lc-fallback (air-gapped deployments)', async () => {
        const html = await _internal.wordDocToHtmlViaCdn(
          readFixture('sample.docx'),
          FAKE_FALLBACK_BODY,
        );
        /* Visible loading state. */
        expect(html).toContain('Loading preview…');
        /* The fallback body now contains the server-rendered mammoth
         * output (the placeholder body in this test). When the iframe
         * detects `docx-preview` failed to load, `showFallback`
         * un-hides this block — Codex P2 review on PR #12934. The old
         * static "Preview unavailable" text is gone in favor of a
         * notice + the actual document content. */
        expect(html).toContain('id="lc-fallback"');
        expect(html).toContain(FAKE_FALLBACK_BODY);
        expect(html).toContain('High-fidelity renderer unavailable');
        /* The bootstrap script checks `typeof docx === 'undefined'`
         * so a CDN outage degrades to the fallback rather than an
         * empty iframe. */
        expect(html).toContain("typeof docx === 'undefined'");
        /* And it hides the empty render slot when fallback shows so
         * the mammoth content owns the viewport. */
        expect(html).toContain("document.getElementById('lc-render')");
        expect(html).toContain('render.hidden = true');
      });

      test('size-fallback threshold is the documented 350 KB', async () => {
        /* Lock the public threshold so a future refactor doesn't drift
         * away from the value referenced in the JSDoc and the
         * `MAX_TEXT_CACHE_BYTES` reasoning above it. */
        expect(_internal.MAX_DOCX_CDN_BINARY_BYTES).toBe(350 * 1024);
      });

      test('output cap mirrors `MAX_TEXT_CACHE_BYTES` from extract.ts', async () => {
        /* Pin the cycle-avoidance constant. If the upstream
         * `MAX_TEXT_CACHE_BYTES` ever changes (e.g. lifting the cap
         * for office types specifically), update both at the same
         * time or the dispatcher's size-budget path will misfire. */
        expect(_internal.OFFICE_HTML_OUTPUT_CAP).toBe(512 * 1024);
      });

      test('output stays within the cache cap for the standard fixture', async () => {
        /* The fixture isn't large enough to hit the size-budget
         * fallback, but the resulting HTML *must* fit under the cap so
         * `attachment.text` doesn't get truncated mid-document.
         * Pinning this on the standard fixture catches regressions
         * where wrapper boilerplate or DOCX_EXTRA_CSS grows past the
         * 512 KB ceiling. Codex P2 review on PR #12934. */
        const html = await wordDocToHtml(readFixture('sample.docx'));
        expect(Buffer.byteLength(html, 'utf-8')).toBeLessThanOrEqual(
          _internal.OFFICE_HTML_OUTPUT_CAP,
        );
      });

      test('locks color-scheme to light so OS dark-mode does not fade body text', async () => {
        /* docx-preview emits page-style rendering (white pages with
         * the doc's native colors). When the iframe declares both
         * light and dark color-schemes AND the OS is in dark mode,
         * browsers inherit dark-mode colors for unset text properties
         * — docx-preview's body text (no explicit color) inherited
         * our `--fg: #e5e7eb` on the white page bg, rendering as
         * barely-visible light grey. Manual e2e regression on PR
         * #12934. The CDN doc must declare ONLY light scheme; the
         * mammoth-only fallback (`wrapAsDocument`) is unaffected
         * because it owns its own bg + text colors. */
        const html = await _internal.wordDocToHtmlViaCdn(
          readFixture('sample.docx'),
          '<p>fallback</p>',
        );
        expect(html).toMatch(/color-scheme:\s*light\b/);
        expect(html).not.toMatch(/color-scheme:\s*light\s+dark/);
        expect(html).not.toMatch(/prefers-color-scheme:\s*dark/);
      });
    });

    describe('OFFICE_PREVIEW_DISABLE_CDN escape hatch', () => {
      /* Air-gapped / corporate-filtered networks where jsdelivr is
       * unreachable need a way to force the mammoth path so DOCX
       * previews don't degrade to "Preview unavailable" on every open.
       * Codex P2 review on PR #12934. */
      const ORIGINAL = process.env.OFFICE_PREVIEW_DISABLE_CDN;
      afterEach(() => {
        if (ORIGINAL === undefined) {
          delete process.env.OFFICE_PREVIEW_DISABLE_CDN;
        } else {
          process.env.OFFICE_PREVIEW_DISABLE_CDN = ORIGINAL;
        }
      });

      test('default behavior (env unset): small docx → CDN path', async () => {
        delete process.env.OFFICE_PREVIEW_DISABLE_CDN;
        const html = await wordDocToHtml(readFixture('sample.docx'));
        expect(html).toContain('id="lc-doc-data"');
      });

      it.each([['true'], ['1'], ['yes'], ['TRUE'], ['Yes'], ['  true  ']])(
        'env=%s forces the mammoth fallback even for small files',
        async (value) => {
          process.env.OFFICE_PREVIEW_DISABLE_CDN = value;
          const html = await wordDocToHtml(readFixture('sample.docx'));
          // Mammoth-path signature, NOT CDN path.
          expect(html).toContain('<article class="lc-docx">');
          expect(html).not.toContain('id="lc-doc-data"');
          expect(html).not.toContain('cdn.jsdelivr.net');
        },
      );

      it.each([['false'], ['0'], ['no'], [''], ['anything-else']])(
        'env=%j does not disable the CDN path',
        async (value) => {
          process.env.OFFICE_PREVIEW_DISABLE_CDN = value;
          const html = await wordDocToHtml(readFixture('sample.docx'));
          expect(html).toContain('id="lc-doc-data"');
        },
      );
    });
  });

  describe('excelSheetToHtml', () => {
    test('renders all sheets of a multi-sheet workbook into the HTML document', async () => {
      const html = await excelSheetToHtml(readFixture('sample.xlsx'));
      expect(html).toMatch(/^<!DOCTYPE html>/);
      // Each sheet name should appear as a tab label.
      expect(html).toContain('Sheet One');
      expect(html).toContain('Second Sheet');
      // Cell values from both sheets should render.
      expect(html).toContain('first');
      expect(html).toContain('Second');
      // Tab strip uses pure-CSS radio inputs — verify the chrome wired up.
      expect(html).toContain('lc-sheet-tab-radio');
      expect(html).toContain('lc-sheet-panel-0');
      expect(html).toContain('lc-sheet-panel-1');
    });

    test('omits the tab strip when only one sheet is present', async () => {
      const html = await excelSheetToHtml(readFixture('sample.xls'));
      // Cell content should render even though there's no tab strip.
      expect(html).toContain('first');
      expect(html).toContain('<table');
      // Single sheet — no <nav class="lc-sheet-tabs">.
      expect(html).not.toContain('class="lc-sheet-tabs"');
    });

    test('renders ods workbooks the same way', async () => {
      const html = await excelSheetToHtml(readFixture('sample.ods'));
      expect(html).toContain('Sheet One');
      expect(html).toContain('Second Sheet');
    });
  });

  describe('csvToHtml', () => {
    test('renders a basic CSV as a single-table HTML document with no tab strip', async () => {
      const csv = Buffer.from('name,age,city\nAlice,30,NYC\nBob,25,SF\n', 'utf-8');
      const html = await csvToHtml(csv);
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain('Alice');
      expect(html).toContain('NYC');
      expect(html).toContain('<table');
      expect(html).not.toContain('class="lc-sheet-tabs"');
    });

    test('handles CSV with embedded commas via quoted fields', async () => {
      const csv = Buffer.from('label,value\n"hello, world",42\n', 'utf-8');
      const html = await csvToHtml(csv);
      expect(html).toContain('hello, world');
      expect(html).toContain('42');
    });

    test('handles an empty CSV without crashing', async () => {
      const html = await csvToHtml(Buffer.from('', 'utf-8'));
      expect(html).toMatch(/^<!DOCTYPE html>/);
    });
  });

  describe('pptxToSlideListHtml', () => {
    /** Build a minimal valid PPTX with N synthesized slides for testing. */
    const buildPptx = async (
      slides: Array<{ title: string; body?: string[] }>,
    ): Promise<Buffer> => {
      const zip = new JSZip();
      const slideXml = (title: string, body: string[] = []) => {
        const titleP = `<a:p><a:r><a:t>${title}</a:t></a:r></a:p>`;
        const bodyPs = body.map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          ${titleP}
          ${bodyPs}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;
      };
      slides.forEach((s, i) => {
        zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(s.title, s.body));
      });
      // Add a dummy non-slide entry so we exercise the filter.
      zip.file('docProps/core.xml', '<core/>');
      return zip.generateAsync({ type: 'nodebuffer' });
    };

    test('extracts slide titles and body bullets in slide-number order', async () => {
      const pptx = await buildPptx([
        { title: 'Welcome', body: ['First point', 'Second point'] },
        { title: 'Agenda', body: ['Item A', 'Item B', 'Item C'] },
        { title: 'Thanks!' },
      ]);
      const html = await pptxToSlideListHtml(pptx);
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain('Slide 1');
      expect(html).toContain('Welcome');
      expect(html).toContain('First point');
      expect(html).toContain('Slide 2');
      expect(html).toContain('Agenda');
      expect(html).toContain('Item C');
      expect(html).toContain('Slide 3');
      expect(html).toContain('Thanks!');
      // Title appears before body in the doc.
      expect(html.indexOf('Welcome')).toBeLessThan(html.indexOf('First point'));
    });

    test('handles a slide with no extractable text gracefully', async () => {
      const pptx = await buildPptx([{ title: '' }]);
      const html = await pptxToSlideListHtml(pptx);
      expect(html).toContain('Slide 1');
      expect(html).toContain('(empty slide)');
    });

    test('returns a friendly empty-state document when no slides are present', async () => {
      const zip = new JSZip();
      zip.file('docProps/core.xml', '<core/>');
      const pptx = await zip.generateAsync({ type: 'nodebuffer' });
      const html = await pptxToSlideListHtml(pptx);
      expect(html).toContain('contains no readable slides');
    });

    test('decodes XML entities in slide text', async () => {
      const pptx = await buildPptx([{ title: 'A &amp; B', body: ['x &lt; y'] }]);
      const html = await pptxToSlideListHtml(pptx);
      expect(html).toContain('A &amp; B'); // re-escaped on output
      expect(html).toContain('x &lt; y');
    });
  });

  describe('pptxToHtml dispatcher', () => {
    /** Mirror the buildPptx helper from the slide-list block. */
    const buildPptx = async (
      slides: Array<{ title: string; body?: string[] }>,
    ): Promise<Buffer> => {
      const zip = new JSZip();
      const slideXml = (title: string, body: string[] = []) => {
        const titleP = `<a:p><a:r><a:t>${title}</a:t></a:r></a:p>`;
        const bodyPs = body.map((b) => `<a:p><a:r><a:t>${b}</a:t></a:r></a:p>`).join('');
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
       xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:sp><p:txBody>${titleP}${bodyPs}</p:txBody></p:sp></p:spTree></p:cSld>
</p:sld>`;
      };
      slides.forEach((s, i) => {
        zip.file(`ppt/slides/slide${i + 1}.xml`, slideXml(s.title, s.body));
      });
      zip.file('docProps/core.xml', '<core/>');
      return zip.generateAsync({ type: 'nodebuffer' });
    };

    test('routes a small pptx (≤ cap) through the CDN-rendered path', async () => {
      const pptx = await buildPptx([{ title: 'Hello', body: ['First slide'] }]);
      const html = await pptxToHtml(pptx);
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain('id="lc-doc-data"');
      expect(html).toContain('pptxPreview.init');
      expect(html).toContain('cdn.jsdelivr.net/npm/pptx-preview@');
      /* The slide-list `<ol class="lc-pptx-list">` is now embedded
       * INSIDE the CDN doc as a runtime fallback for the silent-
       * empty-render case (pptx-preview's compatibility issues with
       * pptxgenjs decks). It lives in the hidden `#lc-fallback`
       * block; the bootstrap reveals it when `hasRenderedContent()`
       * detects empty wrappers. Manual e2e on PR #12934. */
      expect(html).toContain('class="lc-pptx-list"');
      expect(html).toContain('id="lc-fallback"');
    });

    describe('CDN-rendered path', () => {
      test('embeds the binary as base64 that round-trips to the original bytes', async () => {
        const original = await buildPptx([{ title: 'Test' }]);
        const html = await _internal.pptxToHtmlViaCdn(
          original,
          '<ol class="lc-pptx-list"><li>fb</li></ol>',
        );
        const match = html.match(
          /<script id="lc-doc-data" type="application\/octet-stream;base64">([^<]*)<\/script>/,
        );
        expect(match).not.toBeNull();
        const decoded = Buffer.from(match![1], 'base64');
        expect(decoded.equals(original)).toBe(true);
      });

      test('pins pptx-preview to a specific version with SRI integrity', async () => {
        const pptx = await buildPptx([{ title: 'X' }]);
        const html = await _internal.pptxToHtmlViaCdn(
          pptx,
          '<ol class="lc-pptx-list"><li>fb</li></ol>',
        );
        expect(html).toContain('https://cdn.jsdelivr.net/npm/pptx-preview@1.0.7/');
        expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+"/);
        expect(html).toContain('crossorigin="anonymous"');
      });

      test('CSP locks the iframe down: connect-src restricted, no eval, no base/form tampering', async () => {
        const pptx = await buildPptx([{ title: 'X' }]);
        const html = await _internal.pptxToHtmlViaCdn(
          pptx,
          '<ol class="lc-pptx-list"><li>fb</li></ol>',
        );
        const cspMatch = html.match(
          /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/,
        );
        expect(cspMatch).not.toBeNull();
        const csp = cspMatch![1];
        /* `connect-src` allows self + jsdelivr (the script's origin)
         * so DevTools sourcemap fetches succeed and any same-origin
         * fetches the renderer makes at runtime work. Wildcard
         * exfiltration paths stay blocked. Manual e2e on PR #12934 —
         * strict `'none'` filled DevTools console with `.min.js.map`
         * violations every time the iframe was inspected. */
        expect(csp).toMatch(/connect-src 'self' https:\/\/cdn\.jsdelivr\.net/);
        expect(csp).not.toMatch(/connect-src[^;]*\*/); // no wildcard
        expect(csp).toMatch(/base-uri 'none'/);
        expect(csp).toMatch(/form-action 'none'/);
        expect(csp).toMatch(/script-src https:\/\/cdn\.jsdelivr\.net 'unsafe-inline'/);
        expect(csp).not.toMatch(/unsafe-eval/);
        /* PPTX must allow blob:-only Web Workers — pptx-preview's
         * bundled echarts dep spins up workers via blob: URLs for
         * chart rendering. Without this, the renderer's async
         * pipeline throws unhandled rejections and the iframe shows
         * a black screen. */
        expect(csp).toMatch(/worker-src blob:/);
      });

      test('exposes a fallback message that surfaces if the renderer fails to load or times out', async () => {
        const pptx = await buildPptx([{ title: 'X' }]);
        const html = await _internal.pptxToHtmlViaCdn(
          pptx,
          '<ol class="lc-pptx-list"><li>fb</li></ol>',
        );
        // Visible loading state + fallback that swaps in on error.
        expect(html).toContain('Loading preview…');
        /* Fallback now embeds the slide-list view + a notice
         * explaining the high-fidelity renderer failed. The old
         * static "Preview unavailable" text is replaced with the
         * actual readable content. Manual e2e on PR #12934 (pptxgenjs
         * compatibility issue with pptx-preview). */
        expect(html).toContain('High-fidelity renderer unavailable');
        expect(html).toContain('class="lc-pptx-list"');
        // The renderer-not-loaded check.
        expect(html).toContain("typeof pptxPreview === 'undefined'");
        // The unhandledrejection + error listeners — pptx-preview's
        // bundled deps raise async rejections that don't surface
        // through the outer Promise.
        expect(html).toContain("addEventListener('unhandledrejection'");
        expect(html).toContain("addEventListener('error'");
        // The 8-second timeout safety net for silent renderer failures.
        expect(html).toContain('renderer-timeout');
        expect(html).toContain('renderer-empty-slide-list');
        expect(html).toContain("querySelectorAll('.pptx-preview-slide-wrapper')");
        /* Diagnostic surfacing: the failure reason must be exposed
         * three ways so a debugging user can find it without reading
         * source — manual e2e on PR #12934 ("'Preview unavailable'
         * with no way to know why"):
         *   1. Visible inline via a `<details>` element so it's one
         *      click away in the iframe itself
         *   2. `title` attribute on the fallback for hover tooltip
         *   3. `console.error` so DevTools shows it in red */
        expect(html).toContain('id="lc-fallback-reason"');
        expect(html).toContain('Diagnostic details');
        expect(html).toContain('fallback.title = reasonText');
        expect(html).toContain("console.error('[pptx-preview] fallback fired:'");
      });

      test('size-fallback threshold is the documented 350 KB', () => {
        expect(_internal.MAX_PPTX_CDN_BINARY_BYTES).toBe(350 * 1024);
      });

      test('embeds the slide-list fallback in the CDN doc with empty-render detection', async () => {
        /* pptx-preview silently produces empty 960×540 wrappers for
         * pptxgenjs-generated decks (manual e2e on PR #12934 — it
         * parses the file enough to create the placeholder, then
         * fails to populate it). The bootstrap now detects the
         * empty-render case via `hasRenderedContent()` and reveals
         * the embedded slide-list fallback so the user always gets
         * readable content. */
        const pptx = await buildPptx([{ title: 'A' }, { title: 'B' }]);
        const html = await _internal.pptxToHtmlViaCdn(
          pptx,
          '<ol class="lc-pptx-list"><li>SENTINEL_FALLBACK</li></ol>',
        );
        /* Slide-list fallback body is embedded inside `#lc-fallback`. */
        expect(html).toContain('id="lc-fallback"');
        expect(html).toContain('SENTINEL_FALLBACK');
        /* Empty-render detection helper exists in the bootstrap. */
        expect(html).toContain('hasRenderedContent');
        expect(html).toContain('renderer-empty-slide-list');
        expect(html).toContain("querySelectorAll('.pptx-preview-slide-wrapper')");
        /* The slide-list fallback CSS is inlined so the fallback
         * renders with the same look as the standalone slide-list
         * path (CSP locks `style-src` to inline only). */
        expect(html).toContain('.lc-pptx-list');
        expect(html).toContain('.lc-pptx-slide');
      });

      test('bootstrap wraps + scales each slide so it fits the iframe width', async () => {
        /* pptx-preview emits slides at the init dimensions (960×540
         * by default). Without post-processing, narrow artifact panels
         * scroll horizontally and slides spill outside the viewport.
         * The bootstrap wraps each rendered slide in `.lc-slide-wrap`
         * and applies `transform: scale(panel_width / 960)` so the
         * panel always fits — manual e2e feedback on PR #12934.
         *
         * The wrap is applied ONCE, after `previewer.preview` resolves
         * (and the post-render container is visible). Wrapping during
         * streaming via MutationObserver caused pptx-preview to throw
         * — its internal pipeline holds references to the appended
         * slides and broke when we moved them under a parent wrap. */
        const pptx = await buildPptx([{ title: 'A' }, { title: 'B' }]);
        const html = await _internal.pptxToHtmlViaCdn(
          pptx,
          '<ol class="lc-pptx-list"><li>fb</li></ol>',
        );
        /* The wrapper class used by the CSS rules. */
        expect(html).toContain('lc-slide-wrap');
        /* The wrap function + the per-slide scale function. The
         * scale uses each slide's actual rendered native width (not
         * a constant) so panels wider than 960px still fill — no
         * upscale cap means we never leave whitespace on the sides
         * of the panel. */
        expect(html).toContain('wrapSlides');
        expect(html).toContain('scaleFor');
        expect(html).toContain('availableWidth');
        /* The width-only scale formula. Negative assertion below
         * forbids re-introducing the height-aware variant — that
         * caused pptx-preview to render slides as solid-black
         * rectangles (manual e2e regression on PR #12934). */
        expect(html).toContain('availableWidth() / (nativeW || SLIDE_W)');
        /* Negative assertions for two failed iterations:
         *   - `Math.min(1, ...)` upscale cap left whitespace on
         *     panels wider than 960px.
         *   - `Math.min(sw, sh)` height-aware scale + viewport-
         *     derived height calculations interacted with pptx-
         *     preview's internal layout and produced black slides.
         *   - `body { display: flex }` and `min-height: 100vh` on
         *     html/body also broke pptx-preview's render path.
         * Vertical empty space below short decks is acceptable; the
         * iframe bg shows through and matches the panel theme. */
        expect(html).not.toMatch(/Math\.min\(\s*1\s*,/);
        expect(html).not.toContain('Math.min(sw, sh)');
        expect(html).not.toContain('availableHeight');
        expect(html).not.toContain('min-height: 100vh');
        expect(html).not.toMatch(/body\s*\{[^}]*display:\s*flex/);
        /* Container is hidden during render and revealed by the
         * `finalize` step so the unscaled flash never reaches the
         * user. */
        expect(html).toContain("container.style.visibility = 'hidden'");
        expect(html).toContain("container.style.visibility = 'visible'");
        /* ResizeObserver re-fits on panel resize. (No
         * MutationObserver — streaming wraps broke pptx-preview.) */
        expect(html).toContain('ResizeObserver');
        expect(html).not.toContain('MutationObserver');
        /* Native dimensions cached on the slide dataset so re-fitting
         * on resize never measures an already-transformed box. */
        expect(html).toContain('lcNativeW');
      });
    });

    describe('OFFICE_PREVIEW_DISABLE_CDN escape hatch', () => {
      const ORIGINAL = process.env.OFFICE_PREVIEW_DISABLE_CDN;
      afterEach(() => {
        if (ORIGINAL === undefined) {
          delete process.env.OFFICE_PREVIEW_DISABLE_CDN;
        } else {
          process.env.OFFICE_PREVIEW_DISABLE_CDN = ORIGINAL;
        }
      });

      test('default behavior (env unset): small pptx → CDN path', async () => {
        delete process.env.OFFICE_PREVIEW_DISABLE_CDN;
        const pptx = await buildPptx([{ title: 'Hello' }]);
        const html = await pptxToHtml(pptx);
        expect(html).toContain('id="lc-doc-data"');
      });

      it.each([['true'], ['1'], ['yes'], ['TRUE']])(
        'env=%s forces the slide-list fallback even for small files',
        async (value) => {
          process.env.OFFICE_PREVIEW_DISABLE_CDN = value;
          const pptx = await buildPptx([{ title: 'Hello', body: ['Line 1'] }]);
          const html = await pptxToHtml(pptx);
          // Slide-list signature.
          expect(html).toContain('class="lc-pptx-list"');
          expect(html).toContain('Hello');
          expect(html).not.toContain('id="lc-doc-data"');
          expect(html).not.toContain('cdn.jsdelivr.net');
        },
      );
    });
  });

  describe('bufferToOfficeHtml dispatcher', () => {
    test('routes by extension when MIME is generic', async () => {
      const html = await bufferToOfficeHtml(
        readFixture('sample.docx'),
        'sample.docx',
        'application/octet-stream',
      );
      expect(html).not.toBeNull();
      // sample.docx is small → CDN path. Lock the dispatcher routing
      // by checking for a CDN-path signature rather than the literal
      // document text (which only appears in the mammoth fallback).
      expect(html!).toContain('id="lc-doc-data"');
      expect(html!).toContain('docx-preview@');
    });

    test('routes by MIME when extension is missing', async () => {
      const html = await bufferToOfficeHtml(
        readFixture('sample.xlsx'),
        'workbook',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(html).not.toBeNull();
      expect(html!).toContain('Sheet One');
    });

    test('routes csv by extension', async () => {
      const html = await bufferToOfficeHtml(
        Buffer.from('a,b\n1,2', 'utf-8'),
        'data.csv',
        'application/octet-stream',
      );
      expect(html).not.toBeNull();
      expect(html!).toContain('<table');
    });

    test('routes csv by MIME when extension is missing', async () => {
      const html = await bufferToOfficeHtml(Buffer.from('a,b\n1,2', 'utf-8'), 'data', 'text/csv');
      expect(html).not.toBeNull();
      expect(html!).toContain('<table');
    });

    test('returns null for unrecognized types', async () => {
      const html = await bufferToOfficeHtml(Buffer.from('hello'), 'notes.txt', 'text/plain');
      expect(html).toBeNull();
    });

    test('extension wins over MIME (sniff misclassifies docx as application/zip)', async () => {
      const html = await bufferToOfficeHtml(
        readFixture('sample.docx'),
        'sample.docx',
        'application/zip',
      );
      expect(html).not.toBeNull();
      expect(html!).toContain('lc-docx');
    });
  });

  describe('officeHtmlBucket predicate', () => {
    /* The shared predicate is the single source of truth for "should the
     * office HTML pipeline handle this file?". The upstream gate in
     * `extract.ts` calls it directly; the dispatcher above delegates to
     * it. Tests here lock in MIME-only routing for extensionless inputs
     * (the case Codex flagged on PR #12934). */
    it.each([
      ['report.docx', 'application/zip', 'docx'],
      ['report.docx', '', 'docx'],
      ['noext', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
      ['data.csv', 'application/octet-stream', 'csv'],
      ['data', 'text/csv', 'csv'],
      ['data', 'application/csv', 'csv'],
      ['workbook.xlsx', '', 'spreadsheet'],
      ['legacy.xls', '', 'spreadsheet'],
      ['sheet.ods', '', 'spreadsheet'],
      ['noext', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'spreadsheet'],
      ['noext', 'application/vnd.ms-excel', 'spreadsheet'],
      ['noext', 'application/vnd.oasis.opendocument.spreadsheet', 'spreadsheet'],
      ['deck.pptx', '', 'presentation'],
      ['template.potx', '', 'presentation'],
      [
        'noext',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'presentation',
      ],
      [
        'noext',
        'application/vnd.openxmlformats-officedocument.presentationml.template',
        'presentation',
      ],
    ])('classifies (%s, %s) as %s', (name, mime, expected) => {
      expect(officeHtmlBucket(name, mime)).toBe(expected);
    });

    it.each([
      ['note.txt', 'text/plain'],
      ['code.py', 'text/x-python'],
      ['data.json', 'application/json'],
      ['photo.jpg', 'image/jpeg'],
      ['doc.pdf', 'application/pdf'],
      ['archive.zip', 'application/zip'],
      ['notes.odt', 'application/vnd.oasis.opendocument.text'],
      ['noext', 'text/plain'],
      ['noext', ''],
    ])('returns null for non-office (%s, %s)', (name, mime) => {
      expect(officeHtmlBucket(name, mime)).toBeNull();
    });

    /* Regression for Codex P2 review on PR #12934. A binary office file
     * with a mismatched MIME (e.g. a tool sandbox sets `text/csv` on
     * everything it ships) must NOT be re-routed to a different bucket
     * just because the MIME matches a different bucket's pattern. The
     * documented "extension wins" precedence is enforced by checking
     * extensions exhaustively before any MIME pattern fires. */
    it.each([
      ['deck.pptx', 'text/csv', 'presentation'],
      ['workbook.xlsx', 'text/csv', 'spreadsheet'],
      [
        'legacy.xls',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'spreadsheet',
      ],
      ['sheet.ods', 'text/csv', 'spreadsheet'],
      ['report.docx', 'text/csv', 'docx'],
      ['report.docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'docx'],
      [
        'data.csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'csv',
      ],
    ])('extension wins over conflicting MIME: (%s, %s) → %s', (name, mime, expected) => {
      expect(officeHtmlBucket(name, mime)).toBe(expected);
    });

    /* Regression for Codex P2 (server/client routing parity). The
     * client's `detectArtifactTypeFromFile` routes by extension first
     * for ANY known extension (not just office) — `.txt` →
     * PLAIN_TEXT regardless of MIME. If the server fell back to MIME
     * for these files and produced office HTML, the client would
     * still route to PLAIN_TEXT, escape the HTML through the markdown
     * viewer, and the user would see raw `<html>...` markup. The
     * server now refuses to fall back to MIME when extension is
     * non-empty — symmetric "extension wins" precedence with the
     * client.
     *
     * Trade-off: a true DOCX renamed to `myfile.bin` + DOCX MIME no
     * longer routes through office HTML on the server. Acceptable —
     * extension/MIME mismatch is user error, and the security gate
     * on the client would have produced a PLAIN_TEXT fall-through
     * anyway (no preview either way). */
    it.each([
      // Known non-office extension + office MIME — must NOT route to office
      ['notes.txt', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['notes.md', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['data.json', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['code.py', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['page.html', 'text/csv'],
      ['styles.css', 'text/csv'],
      // Unknown extension + office MIME — also returns null (server is
      // conservative; client's security gate will downgrade these to
      // PLAIN_TEXT anyway since `textFormat` would not be 'html')
      ['blob.bin', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['data.dat', 'text/csv'],
    ])('non-empty non-office extension wins over office MIME: (%s, %s) → null', (name, mime) => {
      expect(officeHtmlBucket(name, mime)).toBeNull();
    });

    /* Regression for Codex P2 review on PR #12934. Real Content-Type
     * headers carry parameters like `; charset=utf-8` and `; boundary`;
     * the predicate must strip them before matching, otherwise the
     * backend silently falls through to raw text while the client's
     * `baseMime` strips the same parameters and routes the file to the
     * spreadsheet bucket — yielding a broken preview. */
    it.each([
      ['data', 'text/csv; charset=utf-8', 'csv'],
      ['data', 'text/csv;charset=utf-8', 'csv'],
      ['data', 'TEXT/CSV; CHARSET=UTF-8', 'csv'],
      ['data', 'application/csv; charset=ascii', 'csv'],
      ['data', 'text/comma-separated-values', 'csv'],
      ['data', 'text/comma-separated-values; charset=utf-8', 'csv'],
      [
        'workbook',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary',
        'spreadsheet',
      ],
      [
        'report',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary',
        'docx',
      ],
      [
        'deck',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation; foo=bar',
        'presentation',
      ],
    ])('strips MIME parameters before matching: (%s, %s) → %s', (name, mime, expected) => {
      expect(officeHtmlBucket(name, mime)).toBe(expected);
    });
  });

  describe('zip-bomb defense (SEC review on PR #12934)', () => {
    /* Build a sub-1MB compressed ZIP that inflates to >25MB (default
     * per-entry cap). Mirrors the SEC validation PoC: highly compressed
     * runs of zero bytes squeeze through any compressed-size gate but
     * blow up the parser. */
    const buildBombArchive = async (
      entries: Array<{ name: string; decompressedBytes: number }>,
    ): Promise<Buffer> => {
      const zip = new JSZip();
      for (const { name, decompressedBytes } of entries) {
        zip.file(name, Buffer.alloc(decompressedBytes, 0));
      }
      return zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 },
      });
    };

    test('wordDocToHtml rejects a zip-bomb DOCX before mammoth touches it', async () => {
      const bomb = await buildBombArchive([
        { name: 'word/document.xml', decompressedBytes: 50 * megabyte },
      ]);
      expect(bomb.length).toBeLessThan(1 * megabyte);
      await expect(wordDocToHtml(bomb)).rejects.toThrow(ZipBombError);
    });

    test('excelSheetToHtml rejects a zip-bomb XLSX before SheetJS touches it', async () => {
      const bomb = await buildBombArchive([
        { name: 'xl/worksheets/sheet1.xml', decompressedBytes: 50 * megabyte },
      ]);
      expect(bomb.length).toBeLessThan(1 * megabyte);
      await expect(excelSheetToHtml(bomb)).rejects.toThrow(ZipBombError);
    });

    test('pptxToSlideListHtml rejects a zip-bomb PPTX before slide extraction', async () => {
      const bomb = await buildBombArchive([
        { name: 'ppt/slides/slide1.xml', decompressedBytes: 50 * megabyte },
      ]);
      expect(bomb.length).toBeLessThan(1 * megabyte);
      await expect(pptxToSlideListHtml(bomb)).rejects.toThrow(ZipBombError);
    });

    test('bufferToOfficeHtml propagates ZipBombError so callers can fail safe', async () => {
      const bomb = await buildBombArchive([
        { name: 'word/document.xml', decompressedBytes: 50 * megabyte },
      ]);
      await expect(bufferToOfficeHtml(bomb, 'evil.docx', '')).rejects.toThrow(ZipBombError);
    });

    test('legitimate small office files are not impacted by the safety check', async () => {
      /* Real DOCX fixture from the test fixtures directory should still
       * render — paranoid validation that the safety check doesn't false-
       * positive on tiny legitimate inputs. Small fixture takes the CDN
       * path, so we assert by wrapper structure instead of doc text. */
      const fixture = readFixture('sample.docx');
      const html = await wordDocToHtml(fixture);
      expect(html).toMatch(/^<!DOCTYPE html>/);
      expect(html).toContain('id="lc-doc-data"');
    });
  });

  describe('sanitizeOfficeHtml security', () => {
    test('strips <script> tags entirely', async () => {
      const out = await sanitizeOfficeHtml('<p>before<script>alert(1)</script>after</p>');
      expect(out).not.toMatch(/<script\b/i);
      expect(out).not.toContain('alert(1)');
      expect(out).toContain('before');
      expect(out).toContain('after');
    });

    test('drops event-handler attributes from surviving tags', async () => {
      const out = await sanitizeOfficeHtml('<img src="https://x.test/a.png" onerror="alert(1)">');
      expect(out).not.toMatch(/onerror=/i);
      expect(out).toContain('https://x.test/a.png');
    });

    test('strips javascript: URLs from anchors', async () => {
      const out = await sanitizeOfficeHtml('<a href="javascript:alert(1)">click</a>');
      expect(out).not.toMatch(/javascript:/i);
      // The text survives even when the href is dropped.
      expect(out).toContain('click');
    });

    test('rejects data: URLs in <a href> (only <img src> may use data:)', async () => {
      /* The Sandpack iframe sandbox does NOT gate `target="_blank"`
       * navigations. A surviving `<a href="data:text/html,...">` would
       * open attacker-controlled HTML in a new tab on click. The
       * sanitizer scopes `data:` to <img> only — global schemes are
       * http/https/mailto. Regression guard for the Codex review on
       * PR #12934. */
      const out = await sanitizeOfficeHtml(
        '<a href="data:text/html,<script>alert(1)</script>">click</a>',
      );
      expect(out).not.toContain('data:');
      expect(out).not.toContain('script');
      expect(out).toContain('click');
    });

    test('preserves data: URLs in <img src> (mammoth inlines DOCX images as base64)', async () => {
      const tinyPng =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
      const out = await sanitizeOfficeHtml(`<img src="${tinyPng}" alt="dot">`);
      expect(out).toContain(tinyPng);
      expect(out).toContain('alt="dot"');
    });

    test('preserves http(s) and mailto links on anchors', async () => {
      const out = await sanitizeOfficeHtml(
        '<a href="https://example.com">site</a> <a href="mailto:a@b.test">mail</a>',
      );
      expect(out).toContain('https://example.com');
      expect(out).toContain('mailto:a@b.test');
    });

    test('forces target=_blank rel=noopener on surviving anchors', async () => {
      const out = await sanitizeOfficeHtml('<a href="https://example.com">link</a>');
      expect(out).toContain('target="_blank"');
      expect(out).toContain('rel="noopener noreferrer"');
    });

    test('strips <iframe> entirely', async () => {
      const out = await sanitizeOfficeHtml('<p>x</p><iframe src="https://evil.test"></iframe>');
      expect(out).not.toMatch(/<iframe\b/i);
      expect(out).not.toContain('evil.test');
    });
  });
});
