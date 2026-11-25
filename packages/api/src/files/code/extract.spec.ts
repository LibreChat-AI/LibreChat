import * as os from 'os';
import * as path from 'path';
import { logger } from '@librechat/data-schemas';
import {
  extractCodeArtifactRawText,
  extractCodeArtifactInspectionText,
  extractCodeArtifactText,
  getExtractedTextFormat,
  resolveMaxTextExtractBytes,
  MAX_TEXT_CACHE_BYTES,
  MAX_TEXT_EXTRACT_BYTES,
} from './extract';
import { parseDocument } from '~/files/documents/crud';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const docxText = '__DOCX_PARSED__';
/* parseDocument throws on any originalname containing this token, so
 * tests can force a failure with whatever extension/MIME they need
 * (the legacy docx-named constant is preserved for backward-compat
 * with tests that still reference it). */
const docxFailureName = 'force-docx-failure.docx';
const parseDocumentCalls: Array<{ path: string; originalname: string }> = [];

jest.mock('~/files/documents/crud', () => ({
  parseDocument: jest.fn(async ({ file }: { file: { path: string; originalname: string } }) => {
    parseDocumentCalls.push({ path: file.path, originalname: file.originalname });
    if (file.originalname.includes('force-docx-failure')) {
      throw new Error('parse failed');
    }
    return { text: docxText, filename: file.originalname, bytes: docxText.length };
  }),
}));

/* The office HTML producer is mocked here so the existing fallback-path
 * assertions (parseDocument receives the canonical MIME) keep exercising
 * `extractDocument`. Tests that need real HTML output drive `bufferToOfficeHtml`
 * directly via its own spec file (`html.spec.ts`); a separate `office-html`
 * describe block below exercises the integration with this mock relaxed.
 *
 * `officeHtmlBucket` is the gate predicate the upstream uses to decide
 * whether to call the dispatcher at all. We pass through to the real
 * implementation so the gate routes the same files in tests as in prod. */
const mockOfficeHtml = jest.fn(
  async (_buffer: Buffer, _name: string, _mime: string) => null as string | null,
);
jest.mock('~/files/documents/html', () => {
  const actual =
    jest.requireActual<typeof import('~/files/documents/html')>('~/files/documents/html');
  return {
    bufferToOfficeHtml: (buffer: Buffer, name: string, mime: string) =>
      mockOfficeHtml(buffer, name, mime),
    officeHtmlBucket: actual.officeHtmlBucket,
  };
});

describe('extractCodeArtifactText', () => {
  describe('utf8-text', () => {
    it('decodes a UTF-8 buffer', async () => {
      const buffer = Buffer.from('hello world\n', 'utf-8');
      const text = await extractCodeArtifactText(buffer, 'note.txt', 'text/plain', 'utf8-text');
      expect(text).toBe('hello world\n');
    });

    it('returns null for binary content (null byte)', async () => {
      const buffer = Buffer.from([0x68, 0x69, 0x00, 0x6f]);
      const text = await extractCodeArtifactText(buffer, 'fake.txt', 'text/plain', 'utf8-text');
      expect(text).toBeNull();
    });

    it('returns null for buffers larger than the extract cap', async () => {
      const buffer = Buffer.alloc(MAX_TEXT_EXTRACT_BYTES + 1, 'a');
      const text = await extractCodeArtifactText(buffer, 'big.txt', 'text/plain', 'utf8-text');
      expect(text).toBeNull();
    });

    it('truncates content larger than the cache cap with a marker', async () => {
      const cacheCapPlus = MAX_TEXT_CACHE_BYTES + 1024;
      const buffer = Buffer.alloc(cacheCapPlus, 'a');
      const text = await extractCodeArtifactText(buffer, 'big.txt', 'text/plain', 'utf8-text');
      expect(text).not.toBeNull();
      expect(text!.endsWith('…[truncated]')).toBe(true);
      expect(Buffer.byteLength(text!, 'utf-8')).toBeLessThanOrEqual(MAX_TEXT_CACHE_BYTES);
    });

    it('does not split a multi-byte UTF-8 character at the truncation boundary', async () => {
      // 你 is U+4F60, which encodes as 3 bytes in UTF-8 (E4 BD A0).
      // Build a buffer where the cut would otherwise land mid-character.
      const filler = 'a'.repeat(MAX_TEXT_CACHE_BYTES - 30);
      const tail = '你'.repeat(50);
      const buffer = Buffer.from(filler + tail, 'utf-8');
      const text = await extractCodeArtifactText(buffer, 'cjk.txt', 'text/plain', 'utf8-text');
      expect(text).not.toBeNull();
      expect(text!.endsWith('…[truncated]')).toBe(true);
      // U+FFFD (replacement) signals a corrupted boundary — must not appear.
      expect(text).not.toContain('�');
    });

    it('returns the empty string for an empty buffer', async () => {
      const text = await extractCodeArtifactText(
        Buffer.alloc(0),
        'empty.txt',
        'text/plain',
        'utf8-text',
      );
      expect(text).toBe('');
    });
  });

  describe('document', () => {
    /* These tests exercise the legacy `extractDocument` path, which now
     * only fires for `category === 'document'` files that the office HTML
     * dispatcher does NOT claim — i.e. PDF and ODT. All ZIP-backed office
     * formats (DOCX/XLSX/XLS/ODS) bypass `extractDocument` entirely
     * because they're HTML-or-null per the SEC fix in PR #12934
     * (Codex P1 review: text-fallback under `index.html` was XSS). */
    beforeEach(() => {
      parseDocumentCalls.length = 0;
    });

    it('routes through parseDocument and returns its text (ODT)', async () => {
      const buffer = Buffer.from('PKfake-odt');
      const text = await extractCodeArtifactText(
        buffer,
        'notes.odt',
        'application/vnd.oasis.opendocument.text',
        'document',
      );
      expect(text).toBe(docxText);
    });

    it('returns null when parseDocument throws', async () => {
      const buffer = Buffer.from('PKfake-odt');
      const text = await extractCodeArtifactText(
        buffer,
        docxFailureName.replace('.docx', '.odt'),
        'application/vnd.oasis.opendocument.text',
        'document',
      );
      expect(text).toBeNull();
    });

    it('rewrites a generic sniffed MIME to the canonical document MIME by extension (ODT)', async () => {
      // Code-output buffers for office docs are commonly sniffed as
      // application/zip — without canonicalization, parseDocument would
      // reject these and inline previews would silently disappear.
      const buffer = Buffer.from('PKfake-odt');
      await extractCodeArtifactText(buffer, 'notes.odt', 'application/zip', 'document');
      expect(parseDocumentCalls[0]?.originalname).toBe('notes.odt');
    });

    it.each([
      ['notes.odt', 'application/zip', 'application/vnd.oasis.opendocument.text'],
      ['report.pdf', 'application/octet-stream', 'application/pdf'],
    ])(
      'passes canonical mimetype for %s when sniff returns %s (legacy parseDocument path)',
      async (name, sniffed, _canon) => {
        const parseDocumentMock = (
          jest.requireMock('~/files/documents/crud') as {
            parseDocument: jest.Mock;
          }
        ).parseDocument;
        parseDocumentMock.mockClear();
        await extractCodeArtifactText(Buffer.from('PK'), name, sniffed, 'document');
        const call = parseDocumentMock.mock.calls[0]?.[0];
        /* PDF doesn't have an entry in `documentMimeFromExtension` so the
         * sniffed MIME passes through unchanged. ODT does — gets
         * canonicalized to ODT_MIME. */
        expect(call?.file?.mimetype).toBe(_canon === 'application/pdf' ? sniffed : _canon);
      },
    );

    it('writes the temp file inside os.tmpdir() regardless of artifact name', async () => {
      /* Path traversal defense — even a malicious filename like
       * `../../../etc/passwd.odt` must end up inside os.tmpdir() with a
       * sanitized basename. Uses ODT since the office HTML path now
       * short-circuits all ZIP-backed office formats. */
      const buffer = Buffer.from('PKfake-odt');
      await extractCodeArtifactText(
        buffer,
        '../../../etc/passwd.odt',
        'application/vnd.oasis.opendocument.text',
        'document',
      );
      const call = parseDocumentCalls[0];
      expect(call).toBeDefined();
      const tmpRoot = path.resolve(os.tmpdir());
      expect(path.resolve(call.path).startsWith(tmpRoot)).toBe(true);
      expect(call.path).not.toContain('..');
      expect(call.originalname).toBe('passwd.odt');
    });

    it('does NOT call parseDocument for office HTML types (DOCX/XLSX/XLS/ODS)', async () => {
      /* Lock in the SEC contract: the four office HTML buckets are
       * HTML-or-null and never fall back to `extractDocument`. */
      mockOfficeHtml.mockResolvedValue(null);
      const cases: Array<[string, string]> = [
        ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
        ['data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
        ['legacy.xls', 'application/vnd.ms-excel'],
        ['sheet.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
      ];
      for (const [name, mime] of cases) {
        const text = await extractCodeArtifactText(Buffer.from('PK'), name, mime, 'document');
        expect(text).toBeNull();
      }
      expect(parseDocumentCalls.length).toBe(0);
    });
  });

  describe('skipped categories', () => {
    it('returns null for presentations when HTML rendering also fails', async () => {
      mockOfficeHtml.mockResolvedValueOnce(null);
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'slides.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'presentation',
      );
      expect(text).toBeNull();
    });

    it('returns null for other (binary)', async () => {
      const text = await extractCodeArtifactText(
        Buffer.from([0xff, 0xd8, 0xff]),
        'photo.jpg',
        'image/jpeg',
        'other',
      );
      expect(text).toBeNull();
    });
  });

  describe('office-html', () => {
    beforeEach(() => {
      mockOfficeHtml.mockReset();
      parseDocumentCalls.length = 0;
    });

    it('returns the HTML rendering for a docx when the producer succeeds', async () => {
      mockOfficeHtml.mockResolvedValueOnce('<!DOCTYPE html><html><body>docx html</body></html>');
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document',
      );
      expect(text).toBe('<!DOCTYPE html><html><body>docx html</body></html>');
      expect(parseDocumentCalls.length).toBe(0);
    });

    it('returns the HTML rendering for a pptx when the producer succeeds', async () => {
      mockOfficeHtml.mockResolvedValueOnce('<!DOCTYPE html><html><body>slides</body></html>');
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'deck.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'presentation',
      );
      expect(text).toContain('slides');
    });

    it('returns the HTML rendering for a potx when the producer succeeds', async () => {
      const html = '<!DOCTYPE html><html><body>template</body></html>';
      mockOfficeHtml.mockResolvedValueOnce(html);
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'template.potx',
        'application/vnd.openxmlformats-officedocument.presentationml.template',
        'presentation',
      );
      expect(text).toBe(html);
    });

    it('returns the HTML rendering for csv (overriding utf8-text raw output)', async () => {
      mockOfficeHtml.mockResolvedValueOnce('<!DOCTYPE html><table><tr><td>a</td></tr></table>');
      const text = await extractCodeArtifactText(
        Buffer.from('a,b\n1,2', 'utf-8'),
        'data.csv',
        'text/csv',
        'utf8-text',
      );
      expect(text).toContain('<table>');
    });

    /* SECURITY: office types are HTML-or-null, with NO text fallback.
     * Codex P1 review on PR #12934 caught that the previous fallback
     * shipped raw text under an `index.html` slot on the client — a
     * literal `<script>` in document body would have been rendered as
     * executable markup. The tests below lock in the safe contract:
     * failed HTML rendering → null → file becomes download-only. */
    it('returns null (does not fall back to raw text) when CSV HTML rendering fails', async () => {
      mockOfficeHtml.mockResolvedValueOnce(null);
      const text = await extractCodeArtifactText(
        Buffer.from('a,b\n1,2\n', 'utf-8'),
        'data.csv',
        'text/csv',
        'utf8-text',
      );
      expect(text).toBeNull();
    });

    it('returns null (does not fall back to parseDocument) when DOCX HTML rendering returns null', async () => {
      mockOfficeHtml.mockResolvedValueOnce(null);
      const text = await extractCodeArtifactText(
        Buffer.from('PKfake-docx'),
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document',
      );
      expect(text).toBeNull();
      /* parseDocument MUST NOT be called — its plain-text output would
       * be injected into the iframe as HTML. */
      expect(parseDocumentCalls.length).toBe(0);
    });

    it('returns null (does not fall back to parseDocument) when DOCX HTML rendering throws', async () => {
      mockOfficeHtml.mockRejectedValueOnce(new Error('mammoth blew up'));
      const text = await extractCodeArtifactText(
        Buffer.from('PKfake-docx'),
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document',
      );
      expect(text).toBeNull();
      expect(parseDocumentCalls.length).toBe(0);
    });

    it('XSS regression: failed XLSX HTML render does not ship raw text containing <script>', async () => {
      /* If an attacker-controlled .xlsx makes mammoth/SheetJS time out
       * or throw, the previous fallback would call extractDocument and
       * ship its plain-text output verbatim in `attachment.text`. The
       * client routes by extension to SPREADSHEET and feeds that text
       * into `index.html`. A spreadsheet cell containing the literal
       * string `<script>alert(1)</script>` would then execute inside
       * the Sandpack iframe. The fix returns null instead, and the
       * client's empty-text gate keeps the artifact off the panel. */
      mockOfficeHtml.mockResolvedValueOnce(null);
      const text = await extractCodeArtifactText(
        Buffer.from('PKfake-xlsx'),
        'attack.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'document',
      );
      expect(text).toBeNull();
      expect(parseDocumentCalls.length).toBe(0);
    });

    it('substitutes a "preview too large" banner when HTML exceeds the cache cap', async () => {
      /* Regression for review finding #2 on PR #12934. The earlier
       * implementation byte-truncated the producer's HTML at the
       * UTF-8 boundary, which would land mid-tag and ship malformed
       * markup like `<table><tr><td>con\n…[truncated]` to the iframe.
       * The new behavior swaps the entire payload for a small valid
       * HTML banner — under the cap by construction. */
      const huge = 'X'.repeat(MAX_TEXT_CACHE_BYTES + 5_000);
      mockOfficeHtml.mockResolvedValueOnce(huge);
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'big.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document',
      );
      expect(text).not.toBeNull();
      // Always under the cap.
      expect(Buffer.byteLength(text!, 'utf-8')).toBeLessThanOrEqual(MAX_TEXT_CACHE_BYTES);
      // Valid HTML doc, not byte-truncated markup.
      expect(text!).toMatch(/^<!DOCTYPE html>/);
      expect(text!).toContain('</html>');
      // No truncation marker (which would only appear on the legacy path).
      expect(text!).not.toContain('…[truncated]');
      // User-facing banner content.
      expect(text!).toContain('Preview exceeds the size limit');
    });

    it('passes through HTML output unchanged when within the cache cap', async () => {
      const small = '<!DOCTYPE html><html><body><p>hello</p></body></html>';
      mockOfficeHtml.mockResolvedValueOnce(small);
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'small.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document',
      );
      expect(text).toBe(small);
    });

    it('falls back to parseDocument for pdf (HTML producer returns null for unsupported types)', async () => {
      // Default mock returns null — the producer's own dispatcher would do the
      // same for PDF since pdf has no HTML rendering. Whether we call it or
      // skip it is an implementation detail; what matters is that PDF still
      // routes to parseDocument and yields the docx-mock text.
      const text = await extractCodeArtifactText(
        Buffer.from('%PDF-1.4'),
        'doc.pdf',
        'application/pdf',
        'document',
      );
      expect(text).toBe(docxText);
      expect(parseDocumentCalls[0]?.originalname).toBe('doc.pdf');
    });

    it('does not call the office HTML producer for plain .txt utf8-text', async () => {
      const text = await extractCodeArtifactText(
        Buffer.from('hello world\n', 'utf-8'),
        'note.txt',
        'text/plain',
        'utf8-text',
      );
      expect(mockOfficeHtml).not.toHaveBeenCalled();
      expect(text).toBe('hello world\n');
    });

    it('routes extensionless CSV-by-MIME (utf8-text category) through the office HTML path', async () => {
      /* Regression for the Codex review on PR #12934. A tool emitting
       * `data` with `text/csv` classifies as `utf8-text` (csv has no
       * extension here, MIME is text/* which the classifier treats as
       * utf8-text). The previous gate skipped the office-render branch
       * because the extension wasn't in OFFICE_HTML_EXTENSIONS — so the
       * raw CSV text shipped to the client, which routes by MIME to the
       * SPREADSHEET bucket and expects a full HTML document. The fix
       * shares the dispatcher's MIME-aware predicate so the gate fires
       * here too. */
      mockOfficeHtml.mockResolvedValueOnce('<!DOCTYPE html><table><tr><td>1</td></tr></table>');
      const text = await extractCodeArtifactText(
        Buffer.from('a,b\n1,2', 'utf-8'),
        'data',
        'text/csv',
        'utf8-text',
      );
      expect(mockOfficeHtml).toHaveBeenCalledWith(expect.any(Buffer), 'data', 'text/csv');
      expect(text).toContain('<table>');
    });

    it.each([
      ['workbook', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['workbook', 'application/vnd.ms-excel'],
      ['workbook', 'application/vnd.oasis.opendocument.spreadsheet'],
      ['report', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['deck', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ])('routes extensionless office files by MIME alone (%s, %s)', async (name, mime) => {
      mockOfficeHtml.mockResolvedValueOnce('<!DOCTYPE html><body>x</body></html>');
      let category: 'presentation' | 'utf8-text' | 'document' = 'document';
      if (mime.includes('presentation')) {
        category = 'presentation';
      } else if (mime.startsWith('text/')) {
        category = 'utf8-text';
      }
      const text = await extractCodeArtifactText(Buffer.from('PK'), name, mime, category);
      expect(mockOfficeHtml).toHaveBeenCalledWith(expect.any(Buffer), name, mime);
      expect(text).toContain('<body>');
    });

    it('returns null (and falls back to download UI) when the producer rejects a zip bomb', async () => {
      /* Defense-in-depth check for SEC review on PR #12934. When
       * `bufferToOfficeHtml` throws `ZipBombError` (because a zip-bomb
       * DOCX/XLSX/PPTX got through the compressed-size gate), the outer
       * extractor must swallow it and return null — that signals to the
       * code-output controller to register the file as a regular
       * download instead of a panel artifact. Crucially, it must NOT
       * fall back to `extractDocument` text either: the client would
       * inject that text into `index.html` and a literal `<script>`
       * tag in the document body would execute (Codex P1 review). */
      const bombError = Object.assign(new Error('zip bomb suspected'), {
        name: 'ZipBombError',
        code: 'ZIP_BOMB',
      });
      mockOfficeHtml.mockRejectedValueOnce(bombError);
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'evil.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document',
      );
      expect(text).toBeNull();
      expect(parseDocumentCalls.length).toBe(0);
    });

    /* Regression for Codex P2 review on PR #12934. The classifier returns
     * 'other' for a small but real set of inputs that the new dispatcher
     * can still route — extensionless `application/csv`, extensionless
     * office MIMEs with parameters, etc. The early `category === 'other'`
     * return must NOT short-circuit before `hasOfficeHtmlPath` is checked,
     * or those inputs silently lose the rich preview. */
    it('routes extensionless application/csv through office HTML even when category=other', async () => {
      mockOfficeHtml.mockResolvedValueOnce('<!DOCTYPE html><table><tr><td>1</td></tr></table>');
      const text = await extractCodeArtifactText(
        Buffer.from('a,b\n1,2', 'utf-8'),
        'data',
        'application/csv',
        'other',
      );
      expect(mockOfficeHtml).toHaveBeenCalledWith(expect.any(Buffer), 'data', 'application/csv');
      expect(text).toContain('<table>');
    });

    it('routes extensionless office MIME with parameters through office HTML even when category=other', async () => {
      mockOfficeHtml.mockResolvedValueOnce('<!DOCTYPE html><body>x</body></html>');
      const text = await extractCodeArtifactText(
        Buffer.from('PK'),
        'workbook',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; charset=binary',
        'other',
      );
      expect(mockOfficeHtml).toHaveBeenCalled();
      expect(text).toContain('<body>');
    });

    it('still returns null for true binary "other" files (no MIME match)', async () => {
      /* Defense check: the category=other early return is preserved when
       * `hasOfficeHtmlPath` returns false. A JPEG should not be handed to
       * the office producer. */
      const text = await extractCodeArtifactText(
        Buffer.from([0xff, 0xd8, 0xff]),
        'photo.jpg',
        'image/jpeg',
        'other',
      );
      expect(mockOfficeHtml).not.toHaveBeenCalled();
      expect(text).toBeNull();
    });
  });
});

describe('extractCodeArtifactRawText', () => {
  it('returns the full inspectable text beyond the preview cache limit', () => {
    const suffix = 'BLOCK-LATE';
    const buffer = Buffer.from(`${'a'.repeat(MAX_TEXT_CACHE_BYTES + 1024)}${suffix}`);

    const text = extractCodeArtifactRawText(buffer, 'utf8-text');

    expect(text).toHaveLength(buffer.length);
    expect(text?.endsWith(suffix)).toBe(true);
    expect(text).not.toContain('…[truncated]');
  });

  it('rejects binary, unsupported, and oversized raw content', () => {
    expect(extractCodeArtifactRawText(Buffer.from([0x00, 0x01]), 'utf8-text')).toBeNull();
    expect(extractCodeArtifactRawText(Buffer.from('text'), 'document')).toBeNull();
    expect(
      extractCodeArtifactRawText(Buffer.alloc(MAX_TEXT_EXTRACT_BYTES + 1, 'a'), 'utf8-text'),
    ).toBeNull();
  });
});

describe('extractCodeArtifactInspectionText', () => {
  beforeEach(() => {
    mockOfficeHtml.mockReset();
    parseDocumentCalls.length = 0;
  });

  it('returns complete plain text beyond the persisted preview cache limit', async () => {
    const suffix = 'BLOCK-LATE';
    const buffer = Buffer.from(`${'a'.repeat(MAX_TEXT_CACHE_BYTES + 1024)}${suffix}`);

    const result = await extractCodeArtifactInspectionText(
      buffer,
      'output.txt',
      'text/plain',
      'utf8-text',
    );

    expect(result.complete).toBe(true);
    expect(result.text?.endsWith(suffix)).toBe(true);
    expect(result.text).not.toContain('…[truncated]');
  });

  it('returns complete parsed document text when the derived output fits the inspection limit', async () => {
    const result = await extractCodeArtifactInspectionText(
      Buffer.from('%PDF'),
      'report.pdf',
      'application/pdf',
      'document',
    );

    expect(result).toEqual({
      text: docxText,
      complete: true,
    });
  });

  it('marks parsed document text incomplete when the derived output exceeds the inspection limit', async () => {
    const suffix = 'BLOCK-DOCUMENT-SUFFIX';
    const text = `${'a'.repeat(MAX_TEXT_EXTRACT_BYTES + 1)}${suffix}`;
    jest.mocked(parseDocument).mockResolvedValueOnce({
      filename: 'large.pdf',
      bytes: Buffer.byteLength(text),
      filepath: 'document_parser',
      text,
      images: [],
    });

    const result = await extractCodeArtifactInspectionText(
      Buffer.from('%PDF'),
      'large.pdf',
      'application/pdf',
      'document',
    );

    expect(result.complete).toBe(false);
    expect(result.text).toContain('…[truncated]');
    expect(result.text).not.toContain(suffix);
  });

  it('marks an oversized office preview banner as incomplete', async () => {
    mockOfficeHtml.mockResolvedValueOnce('x'.repeat(MAX_TEXT_CACHE_BYTES + 1));

    const result = await extractCodeArtifactInspectionText(
      Buffer.from('PK'),
      'slides.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'presentation',
    );

    expect(result.complete).toBe(false);
    expect(result.text).toContain('Preview exceeds the size limit');
  });

  it('keeps parser diagnostics free of generated filenames and parser errors', async () => {
    jest.mocked(parseDocument).mockRejectedValueOnce(new Error('PRIVATE-PARSER-ERROR'));

    await expect(
      extractCodeArtifactInspectionText(
        Buffer.from('%PDF'),
        'PRIVATE-FILENAME.pdf',
        'application/pdf',
        'document',
      ),
    ).resolves.toEqual({ text: null, complete: false });

    expect(logger.debug).toHaveBeenCalledWith(
      '[extractCodeArtifactInspectionText] Artifact inspection failed',
    );
    expect(JSON.stringify(jest.mocked(logger.debug).mock.calls)).not.toContain('PRIVATE-');
  });
});

/* `getExtractedTextFormat` is the trust-flag classifier consumed by
 * `processCodeOutput` (api/server/services/Files/Code/process.js) to
 * persist `textFormat` on the file record. The client's security gate
 * in `detectArtifactTypeFromFile` reads that flag to decide whether
 * routing an office attachment to the HTML preview bucket is safe.
 * These tests pin the contract: HTML for office paths, 'text' for
 * everything else, null for missing input. Codex P1 review on PR #12934. */
describe('getExtractedTextFormat', () => {
  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['data.csv', 'text/csv'],
    ['workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['legacy.xls', 'application/vnd.ms-excel'],
    ['sheet.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])('returns "html" for office path %s (%s)', (name, mime) => {
    expect(getExtractedTextFormat(name, mime, '<table>...</table>')).toBe('html');
  });

  it.each([
    ['noext', 'application/x-ms-excel', '<table></table>'],
    ['noext', 'application/x-msexcel', '<table></table>'],
    ['noext', 'application/msexcel', '<table></table>'],
    ['noext', 'application/x-excel', '<table></table>'],
    ['noext', 'application/x-dos_ms_excel', '<table></table>'],
    ['noext', 'application/xls', '<table></table>'],
    ['noext', 'application/x-xls', '<table></table>'],
  ])('returns "html" for legacy XLS MIME alias %s (%s)', (name, mime, text) => {
    /* Mirrors the client's `excelMimeTypes` regex acceptance — keeping
     * the trust flag aligned across boundaries means no extensionless
     * XLS upload with a legacy MIME ever lands on the HTML bucket
     * without `textFormat: 'html'`. */
    expect(getExtractedTextFormat(name, mime, text)).toBe('html');
  });

  it('returns "text" for plain UTF-8 outputs (notes, source code, JSON)', () => {
    expect(getExtractedTextFormat('note.txt', 'text/plain', 'hello world')).toBe('text');
    expect(getExtractedTextFormat('script.py', 'text/x-python', 'print(1)')).toBe('text');
    expect(getExtractedTextFormat('data.json', 'application/json', '{"a":1}')).toBe('text');
  });

  it('returns "text" for parseDocument paths that are NOT office HTML buckets', () => {
    /* PDF/ODT/HTML go through `parseDocument` and produce plain text;
     * mark them as such so the client never injects them as HTML. */
    expect(getExtractedTextFormat('doc.pdf', 'application/pdf', 'extracted text')).toBe('text');
    expect(
      getExtractedTextFormat('notes.odt', 'application/vnd.oasis.opendocument.text', 'odt text'),
    ).toBe('text');
    expect(getExtractedTextFormat('page.html', 'text/html', '<p>raw</p>')).toBe('text');
  });

  it('returns null when the extractor produced nothing', () => {
    /* `text == null` (extraction skipped, parser failed, binary unsupported)
     * → no `textFormat` to persist. The downstream caller short-circuits
     * the field so the DB doesn't carry a half-truth. */
    expect(
      getExtractedTextFormat(
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        null,
      ),
    ).toBeNull();
    expect(getExtractedTextFormat('photo.jpg', 'image/jpeg', null)).toBeNull();
  });

  it('returns "html" even when text is empty (the path is what counts, not content length)', () => {
    /* An office producer that returns "" is still an office path — the
     * trust flag follows the dispatch decision, not the byte count. The
     * client's empty-text gate keeps the artifact off the panel anyway. */
    expect(
      getExtractedTextFormat(
        'report.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '',
      ),
    ).toBe('html');
  });

  it('classifies by MIME alone when the filename has no recognized extension', () => {
    /* extensionless office files (e.g. tool-emitted blobs with a generic
     * name) still get the right trust flag if the MIME is canonical. */
    expect(
      getExtractedTextFormat(
        'noext',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '<table></table>',
      ),
    ).toBe('html');
  });

  it('returns "text" when neither extension nor MIME marks the file as office', () => {
    expect(getExtractedTextFormat('noext', 'application/octet-stream', 'whatever')).toBe('text');
    expect(getExtractedTextFormat('', '', 'whatever')).toBe('text');
  });
});

describe('extractCodeArtifactText office-html concurrency', () => {
  beforeEach(() => {
    mockOfficeHtml.mockReset();
    parseDocumentCalls.length = 0;
  });

  /* The limiter inside extract.ts caps simultaneous office-HTML renders so
   * a tool result with many office artifacts can't fan out N parallel
   * mammoth/SheetJS invocations and starve the still-running agent loop.
   * The cap is a module-private constant; this test asserts the observable
   * contract without coupling to the literal value. */
  it('caps concurrent office-HTML renders so a burst of 10 files does not all run at once', async () => {
    let active = 0;
    let peak = 0;

    mockOfficeHtml.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return '<!DOCTYPE html><html><body>ok</body></html>';
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        extractCodeArtifactText(
          Buffer.from('PK'),
          `report-${i}.docx`,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'document',
        ),
      ),
    );

    expect(results).toHaveLength(10);
    results.forEach((text) => {
      expect(text).toContain('<!DOCTYPE html>');
    });
    /* Hard upper bound from the module's OFFICE_HTML_CONCURRENCY=2.
     * We assert <= a small constant rather than the exact value to avoid
     * coupling, but it MUST be well below the request count. */
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeLessThan(10);
  });

  it('continues processing the queue when an earlier render rejects', async () => {
    /* A failing render must release its slot — otherwise a single bad
     * file in a burst would permanently shrink the limiter and stall
     * subsequent extractions. */
    let call = 0;
    mockOfficeHtml.mockImplementation(async () => {
      call++;
      if (call === 1) {
        throw new Error('mammoth blew up');
      }
      return '<!DOCTYPE html><html><body>ok</body></html>';
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        extractCodeArtifactText(
          Buffer.from('PK'),
          `report-${i}.docx`,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'document',
        ),
      ),
    );

    /* First call's failure surfaces as null per the HTML-or-null contract;
     * the remaining four must still produce HTML. */
    const nullCount = results.filter((t) => t === null).length;
    const htmlCount = results.filter((t) => t != null && t.includes('<!DOCTYPE html>')).length;
    expect(nullCount).toBe(1);
    expect(htmlCount).toBe(4);
  });
});

describe('resolveMaxTextExtractBytes', () => {
  const TWO_MB = 2 * 1024 * 1024;

  it('defaults to 2 MB when unset or blank', () => {
    expect(resolveMaxTextExtractBytes(undefined)).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('   ')).toBe(TWO_MB);
  });

  it('honors a valid positive byte override', () => {
    expect(resolveMaxTextExtractBytes('1048576')).toBe(1048576);
    expect(resolveMaxTextExtractBytes('5242880')).toBe(5242880);
  });

  it('floors fractional values', () => {
    expect(resolveMaxTextExtractBytes('1048576.9')).toBe(1048576);
  });

  it('falls back to the default on non-numeric or non-positive input', () => {
    expect(resolveMaxTextExtractBytes('nope')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('0')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('-100')).toBe(TWO_MB);
  });

  it('falls back to the default for sub-byte values that floor to zero', () => {
    expect(resolveMaxTextExtractBytes('0.5')).toBe(TWO_MB);
    expect(resolveMaxTextExtractBytes('0.999')).toBe(TWO_MB);
  });

  it('wires the exported ceiling through the resolver for the current env', () => {
    /* Asserting a literal 2 MB here would falsely fail when the suite runs
     * with FILE_PREVIEW_MAX_EXTRACT_BYTES set (the export is initialized
     * from the env at module load). Verify the export tracks the resolver
     * instead; the `undefined` case above pins the 2 MB default. */
    expect(MAX_TEXT_EXTRACT_BYTES).toBe(
      resolveMaxTextExtractBytes(process.env.FILE_PREVIEW_MAX_EXTRACT_BYTES),
    );
  });
});
