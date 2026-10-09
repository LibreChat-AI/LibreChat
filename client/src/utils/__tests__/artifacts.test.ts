import { FileSources } from 'librechat-data-provider';
import type { ToolArtifactType } from '../artifacts';
import {
  artifactRowKind,
  buildSandpackOptions,
  getArtifactDownloadFilename,
  getArtifactFilename,
  getDependencies,
  getSvgFiles,
  getTemplate,
  detectArtifactTypeFromFile,
  fileToArtifact,
  isCodeOnlyArtifact,
  isPreviewOnlyArtifact,
  isSvgArtifactType,
  languageForFilename,
  TOOL_ARTIFACT_TYPES,
} from '../artifacts';

const TAILWIND_CDN = 'https://cdn.tailwindcss.com/3.4.17#tailwind.js';

describe('SVG artifact template mapping (#16087)', () => {
  /* Bare `<svg>` handed to the static template as `index.html` renders
   * blank. These types must map to a dedicated SVG file (and empty
   * Sandpack deps) instead of riding `artifactFilename.default`. */
  it.each(['image/svg+xml', 'image/svg'])(
    'maps %s to index.svg on the static template, not default index.html',
    (type) => {
      expect(getArtifactFilename(type)).toBe('index.svg');
      expect(getTemplate(type)).toBe('static');
      expect(getDependencies(type)).toEqual({});
    },
  );

  it('wraps a bare SVG in an HTML document for the static preview entry', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600" fill="#0f172a"/></svg>';
    const files = getSvgFiles(svg);
    expect(files['index.svg']).toBe(svg);
    expect(files['index.html']).toMatch(/<!DOCTYPE html>/i);
    expect(files['index.html']).toContain('<body');
    expect(files['index.html']).toContain(svg);
  });

  it('strips an XML declaration so the HTML shell stays a valid HTML document', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    const files = getSvgFiles(`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`);
    expect(files['index.html']).not.toMatch(/<\?xml/i);
    expect(files['index.html']).toContain(svg);
  });

  it('sizes only the root SVG so a nested viewport keeps its own geometry', () => {
    const originalHead = document.head.innerHTML;
    const originalBody = document.body.innerHTML;
    try {
      const html = getSvgFiles(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
          '<svg id="sprite" width="20" height="20" x="5" y="5"><rect width="20" height="20"/></svg>' +
          '</svg>',
      )['index.html'];
      /* Mount the shell's own generated style and body. CSS overrides SVG
       * presentation attributes, so an unscoped `svg` rule would stretch the
       * nested viewport to the panel and corrupt the drawing's layout. */
      const css = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? '';
      const markup = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';
      document.head.innerHTML = `<style>${css}</style>`;
      document.body.innerHTML = markup;

      const root = document.body.querySelector('svg');
      const nested = document.getElementById('sprite');
      if (root == null || nested == null) {
        throw new Error('expected the mounted shell to hold both SVG viewports');
      }
      expect(getComputedStyle(root).width).toBe('100%');
      expect(getComputedStyle(root).height).toBe('100%');
      expect(getComputedStyle(nested).width).not.toBe('100%');
      expect(getComputedStyle(nested).height).not.toBe('100%');
    } finally {
      document.head.innerHTML = originalHead;
      document.body.innerHTML = originalBody;
    }
  });

  it('recognizes both SVG artifact types and nothing else', () => {
    expect(isSvgArtifactType('image/svg+xml')).toBe(true);
    expect(isSvgArtifactType('image/svg')).toBe(true);
    expect(isSvgArtifactType('image/png')).toBe(false);
    expect(isSvgArtifactType('text/html')).toBe(false);
    expect(isSvgArtifactType('')).toBe(false);
  });

  it('rebuilds both entries so no original source survives an edit', () => {
    const edited = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>';
    const files = getSvgFiles(edited);
    expect(files['index.svg']).toBe(edited);
    expect(files['index.html']).toContain(edited);
    expect(files['index.html']).not.toContain('<rect');
  });
});

describe('buildSandpackOptions', () => {
  it('includes externalResources with .js fragment hint for static template', () => {
    const options = buildSandpackOptions('static');
    expect(options?.externalResources).toEqual([TAILWIND_CDN]);
  });

  it('includes externalResources for react-ts template', () => {
    const options = buildSandpackOptions('react-ts');
    expect(options?.externalResources).toEqual([TAILWIND_CDN]);
  });

  it('uses staticBundlerURL when template is static and config is provided', () => {
    const config = { staticBundlerURL: 'https://static.example.com' } as Parameters<
      typeof buildSandpackOptions
    >[1];
    const options = buildSandpackOptions('static', config);
    expect(options?.bundlerURL).toBe('https://static.example.com');
    expect(options?.externalResources).toEqual([TAILWIND_CDN]);
  });

  it('uses bundlerURL when template is react-ts and config is provided', () => {
    const config = { bundlerURL: 'https://bundler.example.com' } as Parameters<
      typeof buildSandpackOptions
    >[1];
    const options = buildSandpackOptions('react-ts', config);
    expect(options?.bundlerURL).toBe('https://bundler.example.com');
    expect(options?.externalResources).toEqual([TAILWIND_CDN]);
  });

  it('returns base options without bundlerURL when no config is provided', () => {
    const options = buildSandpackOptions('react-ts');
    expect(options?.bundlerURL).toBeUndefined();
  });
});

describe('detectArtifactTypeFromFile', () => {
  it.each([
    ['index.html', TOOL_ARTIFACT_TYPES.HTML],
    ['index.HTM', TOOL_ARTIFACT_TYPES.HTML],
    ['App.jsx', TOOL_ARTIFACT_TYPES.REACT],
    ['App.tsx', TOOL_ARTIFACT_TYPES.REACT],
    ['notes.md', TOOL_ARTIFACT_TYPES.MARKDOWN],
    ['notes.markdown', TOOL_ARTIFACT_TYPES.MARKDOWN],
    ['notes.mdx', TOOL_ARTIFACT_TYPES.MARKDOWN],
    ['flow.mmd', TOOL_ARTIFACT_TYPES.MERMAID],
    ['flow.mermaid', TOOL_ARTIFACT_TYPES.MERMAID],
    ['readme.txt', TOOL_ARTIFACT_TYPES.PLAIN_TEXT],
    ['notes.odt', TOOL_ARTIFACT_TYPES.PLAIN_TEXT],
    ['report.docx', TOOL_ARTIFACT_TYPES.DOCX],
    ['data.csv', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['workbook.xlsx', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['legacy.xls', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['sheet.ods', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['slides.pptx', TOOL_ARTIFACT_TYPES.PRESENTATION],
    ['template.potx', TOOL_ARTIFACT_TYPES.PRESENTATION],
  ])('classifies %s by extension', (filename, expected) => {
    /* Office types require `textFormat: 'html'` to route to their HTML
     * preview buckets — the security gate added for Codex P1 review on
     * PR #12934. Plain-text/markdown/code/etc. don't take that path so
     * they pass through unchanged. */
    const isOfficeBucket = (
      [
        TOOL_ARTIFACT_TYPES.DOCX,
        TOOL_ARTIFACT_TYPES.SPREADSHEET,
        TOOL_ARTIFACT_TYPES.PRESENTATION,
      ] as ToolArtifactType[]
    ).includes(expected);
    const textFormat = isOfficeBucket ? ('html' as const) : undefined;
    expect(detectArtifactTypeFromFile({ filename, type: '', text: 'content', textFormat })).toBe(
      expected,
    );
  });

  it.each([
    ['index.html', TOOL_ARTIFACT_TYPES.HTML, undefined],
    ['App.tsx', TOOL_ARTIFACT_TYPES.REACT, undefined],
    ['flow.mmd', TOOL_ARTIFACT_TYPES.MERMAID, undefined],
    /* Office preview buckets need server-rendered HTML in `text` to render
     * — the empty-text gate keeps the artifact off the panel until the
     * backend's `bufferToOfficeHtml` finishes. The `textFormat: 'html'`
     * trust flag is required for the routing to even land on the office
     * bucket; without it, the security gate downgrades to PLAIN_TEXT
     * (Codex P1 review). The strict empty-text gate then returns null. */
    ['report.docx', TOOL_ARTIFACT_TYPES.DOCX, 'html' as const],
    ['data.csv', TOOL_ARTIFACT_TYPES.SPREADSHEET, 'html' as const],
    ['workbook.xlsx', TOOL_ARTIFACT_TYPES.SPREADSHEET, 'html' as const],
    ['slides.pptx', TOOL_ARTIFACT_TYPES.PRESENTATION, 'html' as const],
  ])(
    'returns null when %s has no text (renderer needs real content)',
    (filename, _expected, textFormat) => {
      expect(detectArtifactTypeFromFile({ filename, type: '', text: '', textFormat })).toBeNull();
      expect(
        detectArtifactTypeFromFile({ filename, type: '', text: undefined, textFormat }),
      ).toBeNull();
    },
  );

  it.each([
    ['readme.txt', TOOL_ARTIFACT_TYPES.PLAIN_TEXT],
    ['notes.md', TOOL_ARTIFACT_TYPES.MARKDOWN],
    ['notes.odt', TOOL_ARTIFACT_TYPES.PLAIN_TEXT],
  ])(
    'still routes %s through the panel without text (deferred-extraction case for plain-text/markdown)',
    (filename, expected) => {
      expect(detectArtifactTypeFromFile({ filename, type: '', text: '' })).toBe(expected);
      expect(detectArtifactTypeFromFile({ filename, type: '', text: undefined })).toBe(expected);
    },
  );

  it.each([
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      TOOL_ARTIFACT_TYPES.DOCX,
    ],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      TOOL_ARTIFACT_TYPES.SPREADSHEET,
    ],
    ['application/vnd.ms-excel', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/vnd.oasis.opendocument.spreadsheet', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['text/csv', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/csv', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    /* Legacy CSV MIME variant — backend's `CSV_MIME_PATTERN` accepts
     * it, so the client must too or extensionless CSVs with this MIME
     * would be skipped despite the backend producing valid HTML.
     * Regression for Codex P3 review on PR #12934. */
    ['text/comma-separated-values', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    /* Legacy XLS MIME aliases — backend's `excelMimeTypes` regex
     * accepts the full set used by older browsers/servers; the client
     * mirrors via the same regex so an extensionless XLS with any of
     * these legacy MIMEs gets routed to the spreadsheet bucket and
     * the artifact actually shows up on the panel. Regression for
     * Codex P1 review on PR #12934. */
    ['application/x-ms-excel', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/x-msexcel', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/msexcel', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/x-excel', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/x-dos_ms_excel', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/xls', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    ['application/x-xls', TOOL_ARTIFACT_TYPES.SPREADSHEET],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      TOOL_ARTIFACT_TYPES.PRESENTATION,
    ],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.template',
      TOOL_ARTIFACT_TYPES.PRESENTATION,
    ],
  ])('routes office MIME %s to its preview bucket when extension is missing', (mime, expected) => {
    /* `textFormat: 'html'` is required so the security gate (Codex P1 on
     * PR #12934) lets routing proceed to the office HTML bucket — without
     * it, the gate would downgrade to PLAIN_TEXT to keep RAG-extracted
     * plain-text from being injected as HTML. */
    expect(
      detectArtifactTypeFromFile({
        filename: 'noext',
        type: mime,
        text: '<html>x</html>',
        textFormat: 'html',
      }),
    ).toBe(expected);
  });

  /* Codex P1 SECURITY: office HTML routing requires the backend's explicit
   * `textFormat: 'html'` trust flag. Without it (e.g. RAG-uploaded `.docx`
   * with mammoth.extractRawText plain text in `attachment.text`, or any
   * legacy attachment from before this flag existed), routing falls back
   * to PLAIN_TEXT so the markdown viewer escapes content rather than
   * letting useArtifactProps inject the text as `index.html`. */
  it('downgrades office types to PLAIN_TEXT when textFormat is missing (legacy attachments)', () => {
    expect(
      detectArtifactTypeFromFile({
        filename: 'report.docx',
        type: '',
        text: 'Plain text mammoth extracted from a docx — must NOT render as HTML.',
      }),
    ).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
    expect(
      detectArtifactTypeFromFile({
        filename: 'data.csv',
        type: 'text/csv',
        text: 'col1,col2\n1,2',
      }),
    ).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
    expect(
      detectArtifactTypeFromFile({
        filename: 'slides.pptx',
        type: '',
        text: 'Slide 1: Intro\nSlide 2: Outro',
      }),
    ).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
  });

  it('downgrades office types to PLAIN_TEXT when textFormat is "text" (explicit non-HTML)', () => {
    /* The backend marks RAG/text-extraction output as `textFormat: 'text'`
     * to make the trust contract explicit. Either no flag or 'text' both
     * route to PLAIN_TEXT — only 'html' unlocks the office HTML bucket. */
    expect(
      detectArtifactTypeFromFile({
        filename: 'report.docx',
        type: '',
        text: '<script>alert(1)</script>',
        textFormat: 'text',
      }),
    ).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
  });

  it('downgrades office types to PLAIN_TEXT when textFormat is null (DB legacy)', () => {
    /* Mongoose returns `null` for fields the document was saved without
     * — covers attachments persisted before the textFormat field existed. */
    expect(
      detectArtifactTypeFromFile({
        filename: 'workbook.xlsx',
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        text: '<table><tr><td>1</td></tr></table>',
        textFormat: null,
      }),
    ).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
  });

  /* Regression: an office attachment with no `text` AND no `textFormat`
   * must NOT downgrade to PLAIN_TEXT (which has the lenient empty-text
   * gate and would render as a half-empty panel card). The historical
   * contract for office types with missing extraction is "fall through
   * to the legacy download UI"; the security gate's empty-text exception
   * preserves that. CI regression on PR #12934 — `LogContent.test.tsx`
   * "falls back to the legacy download branch for an office file with
   * no extracted text" was the canary. */
  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['data.csv', 'text/csv'],
    ['workbook.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ])(
    '%s with no text and no textFormat returns null (preserves legacy download path)',
    (filename, type) => {
      expect(detectArtifactTypeFromFile({ filename, type, text: '' })).toBeNull();
      expect(detectArtifactTypeFromFile({ filename, type, text: undefined })).toBeNull();
    },
  );

  it('falls back to MIME when the extension is unknown', () => {
    expect(detectArtifactTypeFromFile({ filename: 'noext', type: 'text/html', text: 'x' })).toBe(
      TOOL_ARTIFACT_TYPES.HTML,
    );
    expect(
      detectArtifactTypeFromFile({ filename: 'noext', type: 'text/markdown', text: 'x' }),
    ).toBe(TOOL_ARTIFACT_TYPES.MARKDOWN);
  });

  it.each([
    ['text/html; charset=utf-8', TOOL_ARTIFACT_TYPES.HTML],
    ['text/html;charset=utf-8', TOOL_ARTIFACT_TYPES.HTML],
    ['TEXT/HTML; CHARSET=UTF-8', TOOL_ARTIFACT_TYPES.HTML],
    ['text/markdown; charset=utf-8', TOOL_ARTIFACT_TYPES.MARKDOWN],
    ['application/vnd.react; foo=bar', TOOL_ARTIFACT_TYPES.REACT],
  ])('strips MIME parameters before lookup (%s)', (mime, expected) => {
    expect(detectArtifactTypeFromFile({ filename: 'noext', type: mime, text: 'x' })).toBe(expected);
  });

  it.each([
    ['application/vnd.react'],
    ['application/vnd.ant.react'],
    ['application/vnd.mermaid'],
    ['application/vnd.code-html'],
  ])('routes %s by MIME alone', (mime) => {
    const result = detectArtifactTypeFromFile({ filename: 'noext', type: mime, text: 'x' });
    expect(result).not.toBeNull();
  });

  it('returns null for unsupported types', () => {
    /* PDFs have no rich preview path on the client (the artifact panel
     * doesn't host a PDF viewer); they fall back to the download UI. */
    expect(
      detectArtifactTypeFromFile({ filename: 'doc.pdf', type: 'application/pdf', text: 'x' }),
    ).toBeNull();
    expect(
      detectArtifactTypeFromFile({ filename: 'photo.jpg', type: 'image/jpeg', text: 'binary' }),
    ).toBeNull();
  });

  it('does not route bare text/plain MIME without a recognized extension', () => {
    // Files with text/plain MIME and an unrecognized name (extensionless
    // scripts, .env, etc.) should keep the inline <pre> rendering, not
    // hijack the artifact panel.
    expect(
      detectArtifactTypeFromFile({ filename: 'unknown', type: 'text/plain', text: 'x' }),
    ).toBeNull();
    expect(
      detectArtifactTypeFromFile({ filename: '.env', type: 'text/plain', text: 'KEY=value' }),
    ).toBeNull();
  });

  describe('CODE bucket (programming-language source files)', () => {
    /* `.py` and other code files were previously inline-only — PR #12832
     * intentionally left them out of the side-panel pipeline. This bucket
     * routes them through the markdown template with the source pre-
     * wrapped as a fenced code block (`useArtifactProps`). */
    it.each([
      ['simple_graph.py', 'text/x-python'],
      ['app.js', 'text/javascript'],
      ['main.go', 'text/x-go'],
      ['lib.rs', 'text/x-rust'],
      ['style.css', 'text/css'],
      ['build.sh', 'application/x-sh'],
      ['query.sql', 'application/sql'],
      ['Module.kt', 'text/x-kotlin'],
    ])('routes %s (mime: %s) to the CODE bucket', (filename, type) => {
      expect(detectArtifactTypeFromFile({ filename, type, text: 'x = 1' })).toBe(
        TOOL_ARTIFACT_TYPES.CODE,
      );
    });

    it('routes by extension even when MIME is generic octet-stream', () => {
      /* file-type / inferMimeType sometimes can't classify code files
       * (Python has no magic bytes); the extension map still wins. */
      expect(
        detectArtifactTypeFromFile({
          filename: 'data.py',
          type: 'application/octet-stream',
          text: 'print(1)',
        }),
      ).toBe(TOOL_ARTIFACT_TYPES.CODE);
    });

    it('keeps jsx/tsx on the React (sandpack) bucket, not CODE', () => {
      /* `.jsx` and `.tsx` are React component sources — the existing
       * sandpack live-preview should win over the static CODE bucket. */
      expect(detectArtifactTypeFromFile({ filename: 'App.jsx', type: '', text: 'x' })).toBe(
        TOOL_ARTIFACT_TYPES.REACT,
      );
      expect(detectArtifactTypeFromFile({ filename: 'App.tsx', type: '', text: 'x' })).toBe(
        TOOL_ARTIFACT_TYPES.REACT,
      );
    });

    it('does NOT route data formats to CODE (JSON / YAML / TOML / XML)', () => {
      /* These get dedicated viewers in follow-ups; for now they fall
       * through to inline rendering (return null). CSV is the exception:
       * it routes to the SPREADSHEET preview bucket — covered separately
       * in the "classifies %s by extension" suite above. */
      expect(
        detectArtifactTypeFromFile({ filename: 'data.json', type: 'application/json', text: '{}' }),
      ).toBeNull();
      expect(
        detectArtifactTypeFromFile({
          filename: 'config.yaml',
          type: 'application/yaml',
          text: 'a: 1',
        }),
      ).toBeNull();
      expect(
        detectArtifactTypeFromFile({
          filename: 'pyproject.toml',
          type: 'application/toml',
          text: '',
        }),
      ).toBeNull();
    });

    it('does NOT route config dotfiles to CODE (.env / .ini)', () => {
      expect(
        detectArtifactTypeFromFile({ filename: 'app.env', type: 'text/plain', text: 'KEY=val' }),
      ).toBeNull();
      expect(
        detectArtifactTypeFromFile({
          filename: 'config.ini',
          type: 'text/plain',
          text: '[section]',
        }),
      ).toBeNull();
    });

    it('allows empty text for CODE files (an empty Python file is still a Python file)', () => {
      expect(
        detectArtifactTypeFromFile({ filename: 'empty.py', type: 'text/x-python', text: '' }),
      ).toBe(TOOL_ARTIFACT_TYPES.CODE);
    });

    /* Codex review P2: extensionless build files like `Dockerfile` and
     * `Makefile` have no `.` in their basename, so `extensionOf` returns
     * `''` and the extension map can't match. Bare-name fallback
     * recognizes the lowercased basename for these cases. */
    it.each([
      'Dockerfile',
      'dockerfile',
      'Makefile',
      'makefile',
      'Gemfile',
      'Rakefile',
      'Vagrantfile',
      'Brewfile',
    ])('routes extensionless build file %s to CODE via bare-name fallback', (filename) => {
      expect(detectArtifactTypeFromFile({ filename, type: '', text: 'FROM alpine' })).toBe(
        TOOL_ARTIFACT_TYPES.CODE,
      );
    });

    it('still recognizes nested-path Dockerfile (path-preserving sanitizer output)', () => {
      /* The path-preserving artifact sanitizer can ship `proj/Dockerfile`.
       * Bare-name lookup must use the basename, not the full string. */
      expect(
        detectArtifactTypeFromFile({ filename: 'proj/Dockerfile', type: '', text: 'FROM alpine' }),
      ).toBe(TOOL_ARTIFACT_TYPES.CODE);
    });

    it('does not bare-name match files that DO have an extension (no double-match)', () => {
      /* `dockerfile.dev` has extension `dev` (not in the routing map),
       * so it returns null. Bare-name lookup must skip files with a
       * `.` so the extension path stays the source of truth for them. */
      expect(
        detectArtifactTypeFromFile({ filename: 'dockerfile.dev', type: '', text: 'x' }),
      ).toBeNull();
    });

    it('does not bare-name match unknown extensionless filenames', () => {
      expect(detectArtifactTypeFromFile({ filename: 'README', type: '', text: 'hi' })).toBeNull();
      expect(detectArtifactTypeFromFile({ filename: 'LICENSE', type: '', text: 'MIT' })).toBeNull();
    });

    it.each(['constructor', '__proto__'])(
      'does not classify inherited Object property "%s" from filename or MIME lookups',
      (key) => {
        expect(
          detectArtifactTypeFromFile({ filename: key, type: '', text: '<script>x</script>' }),
        ).toBeNull();
        expect(
          detectArtifactTypeFromFile({
            filename: `payload.${key}`,
            type: '',
            text: '<script>x</script>',
          }),
        ).toBeNull();
        expect(
          detectArtifactTypeFromFile({
            filename: 'payload.bin',
            type: key,
            text: '<script>x</script>',
          }),
        ).toBeNull();
      },
    );

    /* Codex review P3 companion: `extensionOf` used to consider the
     * whole path string, so `pkg.v1/Dockerfile` yielded a path-laden
     * "extension" that masked the bare-name fallback. The basename-
     * first fix makes routing for these files work correctly. */
    it('routes nested-path Dockerfile under dotted directory to CODE', () => {
      expect(
        detectArtifactTypeFromFile({ filename: 'pkg.v1/Dockerfile', type: '', text: 'FROM x' }),
      ).toBe(TOOL_ARTIFACT_TYPES.CODE);
    });

    it('still routes file extensions correctly under dotted directory', () => {
      expect(
        detectArtifactTypeFromFile({ filename: 'pkg.v1/main.go', type: '', text: 'package main' }),
      ).toBe(TOOL_ARTIFACT_TYPES.CODE);
      expect(
        detectArtifactTypeFromFile({
          filename: 'a.b.c/script.py',
          type: 'text/x-python',
          text: 'x = 1',
        }),
      ).toBe(TOOL_ARTIFACT_TYPES.CODE);
    });
  });
});

describe('languageForFilename', () => {
  it('returns the canonical language identifier for known extensions', () => {
    expect(languageForFilename('foo.py')).toBe('python');
    expect(languageForFilename('foo.ts')).toBe('typescript');
    expect(languageForFilename('foo.go')).toBe('go');
    expect(languageForFilename('foo.rs')).toBe('rust');
    expect(languageForFilename('foo.kt')).toBe('kotlin');
  });

  it('falls back to the raw extension for unknown ones (renders monospace)', () => {
    expect(languageForFilename('foo.qwerty')).toBe('qwerty');
  });

  it('returns the canonical language for extensionless build files (bare-name fallback)', () => {
    /* Codex review P2 companion: language hint must follow the same
     * bare-name fallback as the routing decision so the fenced block
     * gets `language-dockerfile` / `language-makefile` etc. */
    expect(languageForFilename('Dockerfile')).toBe('dockerfile');
    expect(languageForFilename('Makefile')).toBe('makefile');
    expect(languageForFilename('Gemfile')).toBe('ruby');
    expect(languageForFilename('Rakefile')).toBe('ruby');
  });

  it('handles nested-path filenames (uses basename)', () => {
    expect(languageForFilename('proj/Dockerfile')).toBe('dockerfile');
    expect(languageForFilename('a/b/c.py')).toBe('python');
  });

  it('returns empty string for filenames with no extension and no recognized bare name', () => {
    expect(languageForFilename('README')).toBe('');
    expect(languageForFilename('')).toBe('');
    expect(languageForFilename(undefined)).toBe('');
  });

  /* Codex review P3: `extensionOf` previously took `lastIndexOf('.')`
   * across the FULL path, so `pkg.v1/Dockerfile` yielded the
   * nonsensical "extension" `v1/dockerfile`. Since that's non-empty,
   * `languageForFilename` returned it as the language hint instead of
   * falling back to `bareNameOf`. The basename-first fix makes both
   * helpers operate on the basename only. */
  it('correctly falls back to bare-name when path has dotted directory components', () => {
    expect(languageForFilename('pkg.v1/Dockerfile')).toBe('dockerfile');
    expect(languageForFilename('a.b.c/Makefile')).toBe('makefile');
    expect(languageForFilename('proj.beta/Gemfile')).toBe('ruby');
  });

  it('correctly identifies extension when path has dotted directory components', () => {
    /* Dotted dir + dotted file: extension parsing should still find
     * the file's extension, not concatenate dir+file fragments. */
    expect(languageForFilename('pkg.v1/main.go')).toBe('go');
    expect(languageForFilename('a.b.c/script.py')).toBe('python');
  });

  /* Codex review P3: when a file routes to CODE via MIME-only (e.g.
   * `noext` filename + `text/x-python` MIME), we still want a language
   * hint on the fenced block so the future highlighter swap-in can
   * apply syntax colors. Without the MIME fallback, `language-` is
   * empty and the highlighter can't engage. */
  it('falls back to MIME when filename has no extension and no recognized bare name', () => {
    expect(languageForFilename('noext', 'text/x-python')).toBe('python');
    expect(languageForFilename('noext', 'text/x-go')).toBe('go');
    expect(languageForFilename('noext', 'application/x-sh')).toBe('bash');
    expect(languageForFilename(undefined, 'text/x-rust')).toBe('rust');
  });

  it('strips MIME parameters before lookup (charset, etc.)', () => {
    expect(languageForFilename('noext', 'text/x-python; charset=utf-8')).toBe('python');
    expect(languageForFilename('noext', 'TEXT/X-PYTHON;charset=utf-8')).toBe('python');
  });

  it('prefers extension over MIME when both are present (extension is more reliable)', () => {
    /* `simple_graph.py` + a wrong/generic MIME → extension wins. */
    expect(languageForFilename('simple_graph.py', 'application/octet-stream')).toBe('python');
    expect(languageForFilename('main.go', 'text/x-python')).toBe('go');
  });

  it('prefers bare-name over MIME for build files', () => {
    /* `Dockerfile` + a generic MIME → bare-name wins. */
    expect(languageForFilename('Dockerfile', 'text/plain')).toBe('dockerfile');
  });

  it('returns empty string when no signal yields a hint (extensionless + unknown MIME)', () => {
    expect(languageForFilename('noext', 'application/octet-stream')).toBe('');
    expect(languageForFilename('noext', undefined)).toBe('');
    expect(languageForFilename('noext')).toBe('');
  });
});

describe('fileToArtifact', () => {
  const baseFile = {
    file_id: 'fid-1',
    filename: 'index.html',
    type: 'text/html',
    text: '<h1>hi</h1>',
    messageId: 'msg-1',
    updatedAt: '2026-04-26T10:00:00.000Z',
  };

  it('builds an Artifact for supported files, with stable id derived from file_id', () => {
    const artifact = fileToArtifact(baseFile);
    expect(artifact).not.toBeNull();
    expect(artifact!.id).toBe('tool-artifact-fid-1');
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.HTML);
    expect(artifact!.title).toBe('index.html');
    expect(artifact!.content).toBe('<h1>hi</h1>');
    expect(artifact!.messageId).toBe('msg-1');
    expect(artifact!.lastUpdateTime).toBe(new Date(baseFile.updatedAt).getTime());
  });

  it('returns null for unsupported types so callers can fall through', () => {
    expect(fileToArtifact({ ...baseFile, filename: 'photo.jpg', type: 'image/jpeg' })).toBeNull();
    expect(
      fileToArtifact({ ...baseFile, filename: 'doc.pdf', type: 'application/pdf' }),
    ).toBeNull();
  });

  /* End-to-end test for the CODE bucket. The classification path is
   * covered separately in `detectArtifactTypeFromFile`'s describe block;
   * this asserts that the full `Artifact` object (id / type / title /
   * content / messageId / lastUpdateTime) is constructed correctly for
   * a typical Python file. Locks in the empty-text gate exception for
   * CODE and the title pass-through that `useArtifactProps` reads to
   * derive the language hint. */
  it('builds a CODE-typed Artifact for a .py file with text', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'simple_graph.py',
      type: 'text/x-python',
      text: 'import matplotlib.pyplot as plt\nplt.savefig("foo.png")',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.CODE);
    expect(artifact!.title).toBe('simple_graph.py');
    expect(artifact!.content).toBe('import matplotlib.pyplot as plt\nplt.savefig("foo.png")');
    expect(artifact!.id).toBe('tool-artifact-fid-1');
    expect(artifact!.messageId).toBe('msg-1');
  });

  it('builds a CODE-typed Artifact for an empty .py file (empty-text exception applies)', () => {
    /* CODE joins MARKDOWN/PLAIN_TEXT in the empty-text exception so an
     * empty Python file still surfaces in the side panel rather than
     * silently disappearing. */
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'empty.py',
      type: 'text/x-python',
      text: '',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.CODE);
    expect(artifact!.content).toBe('');
  });

  it('builds a CODE-typed Artifact for an extensionless build file (Dockerfile)', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'Dockerfile',
      type: '',
      text: 'FROM alpine\nRUN apk add curl',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.CODE);
    expect(artifact!.title).toBe('Dockerfile');
    /* Bare-name resolved → `dockerfile` language hint stored on the
     * artifact so `useArtifactProps` doesn't have to re-derive it. */
    expect(artifact!.language).toBe('dockerfile');
  });

  /* Codex review P3: language is resolved AT CONSTRUCTION TIME so the
   * MIME fallback fires for extensionless filenames. Without storing
   * the language on the artifact, `useArtifactProps` would re-derive
   * from `artifact.title` alone (which has no MIME context) and emit
   * an empty `language-` class. */
  it('stores the language hint on CODE artifacts (filename-derived)', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'app.py',
      type: 'text/x-python',
      text: 'print(1)',
    });
    expect(artifact!.language).toBe('python');
  });

  it('stores the MIME-derived language on CODE artifacts when filename has no extension', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'noext',
      type: 'text/x-python',
      text: 'print(1)',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.CODE);
    expect(artifact!.language).toBe('python');
  });

  it('does not set language on non-CODE artifacts', () => {
    /* Markdown / HTML / etc. don't need a language hint — `useArtifactProps`
     * uses different rendering paths for those. Keeping `language`
     * undefined for them avoids confusing `getKey` which does include
     * `language` in its cache key. */
    const html = fileToArtifact(baseFile);
    expect(html!.language).toBeUndefined();
    const md = fileToArtifact({
      ...baseFile,
      filename: 'README.md',
      type: 'text/markdown',
      text: '# hi',
    });
    expect(md!.language).toBeUndefined();
  });

  it('returns null when an HTML/React/Mermaid file has no text', () => {
    expect(fileToArtifact({ ...baseFile, text: '' })).toBeNull();
    expect(fileToArtifact({ ...baseFile, filename: 'App.tsx', type: '', text: '' })).toBeNull();
    expect(fileToArtifact({ ...baseFile, filename: 'flow.mmd', type: '', text: '' })).toBeNull();
  });

  it('threads original-file download metadata onto the artifact', () => {
    /* The panel download button needs the original-file coordinates to
     * fetch the real binary (e.g. a pptx) instead of serializing the
     * server-rendered HTML preview. `fileToArtifact` must carry them
     * through from the attachment. */
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'deck.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      text: '<html><body>slides</body></html>',
      textFormat: 'html',
      filepath: '/api/files/code/output/deck.pptx',
      source: FileSources.execute_code,
      user: 'user-1',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.PRESENTATION);
    expect(artifact!.download).toEqual({
      filename: 'deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filepath: '/api/files/code/output/deck.pptx',
      file_id: 'fid-1',
      source: FileSources.execute_code,
      user: 'user-1',
    });
  });

  it('uses the caller-provided placeholder when a deferred-extraction file has no text', () => {
    /* Plain-text and markdown remain on the lenient empty-text gate so the
     * artifact card can render a "preparing preview…" placeholder while
     * extraction is in flight. (Office preview buckets — DOCX, SPREADSHEET,
     * PRESENTATION — use the strict gate instead: their renderers need
     * server-rendered HTML, so the artifact stays unregistered until the
     * `text` field arrives. See the strict-gate test in the
     * `detectArtifactTypeFromFile` suite.) */
    const artifact = fileToArtifact(
      {
        ...baseFile,
        filename: 'notes.txt',
        type: 'text/plain',
        text: null as unknown as string,
      },
      { placeholder: '_Coming soon_' },
    );
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
    expect(artifact!.content).toBe('_Coming soon_');
  });

  it('falls back to empty content when no placeholder is supplied and text is missing', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'notes.txt',
      type: 'text/plain',
      text: undefined,
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.content).toBe('');
  });

  it('returns null for office preview buckets without text (strict gate)', () => {
    /* `textFormat: 'html'` is required for routing to land on the office
     * bucket in the first place; without it the security gate downgrades
     * to PLAIN_TEXT (which has the lenient empty-text gate). The strict
     * empty-text gate then fires and the artifact stays unregistered. */
    expect(
      fileToArtifact({
        ...baseFile,
        filename: 'slides.pptx',
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        text: undefined,
        textFormat: 'html',
      }),
    ).toBeNull();
    expect(
      fileToArtifact({
        ...baseFile,
        filename: 'report.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        text: '',
        textFormat: 'html',
      }),
    ).toBeNull();
    expect(
      fileToArtifact({
        ...baseFile,
        filename: 'data.csv',
        type: 'text/csv',
        text: undefined,
        textFormat: 'html',
      }),
    ).toBeNull();
  });

  it('builds a SPREADSHEET artifact for csv/xlsx with backend-rendered HTML in text', () => {
    const csv = fileToArtifact({
      ...baseFile,
      filename: 'data.csv',
      type: 'text/csv',
      text: '<!DOCTYPE html><table><tr><td>1</td></tr></table>',
      textFormat: 'html',
    });
    expect(csv).not.toBeNull();
    expect(csv!.type).toBe(TOOL_ARTIFACT_TYPES.SPREADSHEET);
    expect(csv!.title).toBe('data.csv');
    expect(csv!.content).toContain('<table>');

    const xlsx = fileToArtifact({
      ...baseFile,
      filename: 'workbook.xlsx',
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      text: '<!DOCTYPE html><body>sheet</body>',
      textFormat: 'html',
    });
    expect(xlsx).not.toBeNull();
    expect(xlsx!.type).toBe(TOOL_ARTIFACT_TYPES.SPREADSHEET);
  });

  it('builds a DOCX artifact for .docx with backend-rendered HTML in text', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'report.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      text: '<!DOCTYPE html><body><p>hello</p></body>',
      textFormat: 'html',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.DOCX);
  });

  it('builds a PRESENTATION artifact for .pptx with backend-rendered HTML in text', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'deck.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      text: '<!DOCTYPE html><body><ol><li>Slide 1</li></ol></body>',
      textFormat: 'html',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.PRESENTATION);
  });

  /* Codex P1 SECURITY companion: legacy/RAG path where `textFormat` is
   * missing — the security gate downgrades to PLAIN_TEXT, which has the
   * lenient empty-text gate. The text round-trips into the markdown
   * viewer as escaped content rather than being injected as HTML. */
  it('downgrades to a PLAIN_TEXT artifact when an office file has text but no textFormat flag', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'report.docx',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      /* This is what mammoth.extractRawText returns for a RAG upload —
       * not sanitized HTML, just the document's flowed text. The
       * security gate ensures it's never injected as HTML. */
      text: 'Document body text from extractRawText. <script>alert(1)</script>',
    });
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
    expect(artifact!.content).toContain('<script>');
  });

  it('preserves an empty string as legitimate content (does not fall through to placeholder)', () => {
    // A user can write a 0-byte `.md` or `.txt`; that's a valid artifact
    // with empty content, not "extraction unavailable."
    const artifact = fileToArtifact(
      { ...baseFile, filename: 'empty.md', type: 'text/markdown', text: '' },
      { placeholder: '_should not appear_' },
    );
    expect(artifact!.content).toBe('');
  });

  it('uses real text when present for deferred-extraction file types', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      filename: 'slides.pptx',
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      text: 'Slide 1: Intro\nSlide 2: Outro',
    });
    expect(artifact!.content).toBe('Slide 1: Intro\nSlide 2: Outro');
  });

  it('skips re-classification when preClassifiedType is provided', () => {
    // Filename would normally classify as html, but caller forces plain-text.
    const artifact = fileToArtifact(
      { ...baseFile, filename: 'index.html', type: 'text/html', text: 'x' },
      { preClassifiedType: TOOL_ARTIFACT_TYPES.PLAIN_TEXT },
    );
    expect(artifact!.type).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
  });

  it('rejects a runtime bogus preClassifiedType before constructing an artifact', () => {
    const artifact = fileToArtifact(
      { ...baseFile, filename: 'constructor', type: '', text: '<script>x</script>' },
      { preClassifiedType: Object as unknown as ToolArtifactType },
    );
    expect(artifact).toBeNull();
  });

  it.each([[TOOL_ARTIFACT_TYPES.HTML], [TOOL_ARTIFACT_TYPES.REACT], [TOOL_ARTIFACT_TYPES.MERMAID]])(
    'returns null when preClassifiedType=%s is paired with empty text (defense in depth)',
    (preClassifiedType) => {
      // Bypassing classification with a strict-viewer type but no text
      // would otherwise hand sandpack/mermaid.js an empty buffer that
      // throws. Internal guard catches it before construction.
      const artifact = fileToArtifact(
        { ...baseFile, filename: 'whatever', type: '', text: '' },
        { preClassifiedType },
      );
      expect(artifact).toBeNull();
    },
  );

  it('falls back to createdAt when updatedAt is missing', () => {
    const artifact = fileToArtifact({
      ...baseFile,
      updatedAt: undefined,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(artifact!.lastUpdateTime).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
  });

  it('falls back to filename when file_id is missing', () => {
    const artifact = fileToArtifact({ ...baseFile, file_id: undefined as unknown as string });
    expect(artifact!.id).toBe('tool-artifact-index.html');
  });
});

describe('isPreviewOnlyArtifact', () => {
  /* The Artifacts panel hides the "code" tab and snaps `activeTab` to
   * 'preview' when the current artifact is preview-only — i.e. the
   * underlying file is binary and the generated HTML blob isn't a
   * useful "code" view. Regression for review finding #6 on PR #12934.
   * Without this test, removing a type from the predicate (or adding a
   * non-office type) would silently leave users seeing the raw HTML
   * blob in the code tab. */
  it.each([
    [TOOL_ARTIFACT_TYPES.DOCX, true],
    [TOOL_ARTIFACT_TYPES.SPREADSHEET, true],
    [TOOL_ARTIFACT_TYPES.PRESENTATION, true],
    [TOOL_ARTIFACT_TYPES.HTML, false],
    [TOOL_ARTIFACT_TYPES.REACT, false],
    [TOOL_ARTIFACT_TYPES.MARKDOWN, false],
    [TOOL_ARTIFACT_TYPES.MERMAID, false],
    [TOOL_ARTIFACT_TYPES.CODE, false],
    [TOOL_ARTIFACT_TYPES.PLAIN_TEXT, false],
  ])('type %s returns %s', (type, expected) => {
    expect(isPreviewOnlyArtifact(type)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['application/pdf'], ['text/plain'], ['some/random-type']])(
    'returns false for non-artifact type %s',
    (type) => {
      expect(isPreviewOnlyArtifact(type)).toBe(false);
    },
  );
});

describe('isCodeOnlyArtifact', () => {
  it.each([
    [TOOL_ARTIFACT_TYPES.CODE, true],
    [TOOL_ARTIFACT_TYPES.HTML, false],
    [TOOL_ARTIFACT_TYPES.REACT, false],
    [TOOL_ARTIFACT_TYPES.MARKDOWN, false],
    [TOOL_ARTIFACT_TYPES.MERMAID, false],
    [TOOL_ARTIFACT_TYPES.PLAIN_TEXT, false],
    [TOOL_ARTIFACT_TYPES.DOCX, false],
    [TOOL_ARTIFACT_TYPES.SPREADSHEET, false],
    [TOOL_ARTIFACT_TYPES.PRESENTATION, false],
  ])('type %s returns %s', (type, expected) => {
    expect(isCodeOnlyArtifact(type)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['application/pdf'], ['text/plain'], ['some/random-type']])(
    'returns false for non-code-only type %s',
    (type) => {
      expect(isCodeOnlyArtifact(type)).toBe(false);
    },
  );
});

describe('getArtifactDownloadFilename', () => {
  it.each([
    ['# Migration Plan', 'Migration Plan.md'],
    ['# ~~Deprecated~~ Plan', 'Deprecated Plan.md'],
    ['# migrate_users.py', 'migrate_users.py.md'],
    ['# The **Q3** [report](https://example.com)', 'The Q3 report.md'],
    ['# Hello &amp; goodbye', 'Hello & goodbye.md'],
    ['```bash\n# comment\n```\n# Actual heading', 'Actual heading.md'],
    ['````\n```bash\n# Still code\n```\n````\n# Actual heading', 'Actual heading.md'],
    ['~~~\n```\n# Still code\n~~~\n# Actual heading', 'Actual heading.md'],
    ['---\n# Metadata comment\n---\n# Actual heading', 'Actual heading.md'],
    ['<div>\n# Hidden heading\n</div>\n\n# Actual heading', 'Actual heading.md'],
    ['A real setext heading\n===', 'A real setext heading.md'],
    ['No heading', 'content.md'],
  ])('derives a Markdown filename from %s', (content, expected) => {
    expect(
      getArtifactDownloadFilename(
        { id: 'a', lastUpdateTime: 0, type: 'text/markdown', content },
        'content.md',
      ),
    ).toBe(expected);
  });

  it.each([
    ['Component.jsx', 'App.tsx'],
    ['Component.tsx', 'App.tsx'],
    ['index.htm', 'index.html'],
    ['index.html', 'index.html'],
    ['README.markdown', 'content.md'],
    ['README.mdx', 'content.md'],
    ['README.md', 'content.md'],
    ['script.pyi', 'content.md'],
    ['Dockerfile', 'content.md'],
    ['Makefile', 'content.md'],
    ['notes.TXT', 'content.md'],
  ])('preserves raw file extensions in preview exports: %s', (filename, fileKey) => {
    const artifact = fileToArtifact({ file_id: 'file', filename, text: 'Raw content' });
    expect(artifact).not.toBeNull();
    const dot = filename.lastIndexOf('.');
    const expected =
      dot > 0 ? `${filename.slice(0, dot)}.preview${filename.slice(dot)}` : `${filename}.preview`;
    expect(getArtifactDownloadFilename(artifact!, fileKey)).toBe(expected);
  });

  it.each(['flow.mermaid', 'flow.mmd'])(
    'marks a file-backed mermaid blob as a preview of its stored file: %s',
    (filename) => {
      /* The blob is the cached extraction, which the backend truncates past
       * 512 KB — only the original-file route delivers the stored `.mmd`,
       * so these bytes must not take the stored file's name. */
      const artifact = fileToArtifact({ file_id: 'file', filename, text: 'graph TD\nA-->B' });
      expect(artifact?.type).toBe(TOOL_ARTIFACT_TYPES.MERMAID);
      const dot = filename.lastIndexOf('.');
      expect(getArtifactDownloadFilename(artifact!, 'diagram.mmd')).toBe(
        `${filename.slice(0, dot)}.preview${filename.slice(dot)}`,
      );
    },
  );

  it('keeps a model-authored mermaid diagram under its own name', () => {
    /* No stored file exists for an authored diagram, so its content is the
     * only artifact there is and nothing is being previewed. */
    expect(
      getArtifactDownloadFilename(
        {
          id: 'artifact-1',
          lastUpdateTime: 0,
          type: TOOL_ARTIFACT_TYPES.MERMAID,
          title: 'Flow',
          content: 'graph TD\nA-->B',
        },
        'diagram.mmd',
      ),
    ).toBe('Flow.mmd');
  });

  it.each(['untitled', 'Generated artifact'])(
    'preserves the real attachment filename %s',
    (filename) => {
      const artifact = fileToArtifact({
        file_id: 'file',
        filename,
        type: 'text/markdown',
        text: '# Heading',
      });
      expect(getArtifactDownloadFilename(artifact!, 'content.md')).toBe(`${filename}.preview`);
    },
  );

  it('uses the heading when an attachment supplied no filename', () => {
    const artifact = fileToArtifact({ file_id: 'file', type: 'text/markdown', text: '# Heading' });
    expect(getArtifactDownloadFilename(artifact!, 'content.md')).toBe('Heading.preview.md');
  });

  it('preserves sentinel filenames in older artifact metadata', () => {
    expect(
      getArtifactDownloadFilename(
        {
          id: 'a',
          lastUpdateTime: 0,
          type: 'text/markdown',
          title: 'untitled',
          content: '# Heading',
          download: { file_id: 'file' },
        },
        'content.md',
      ),
    ).toBe('untitled.preview');
  });

  it.each(['script.py', 'notes.txt', 'README.md', 'Dockerfile'])(
    'distinguishes cached preview exports of %s',
    (filename) => {
      const artifact = fileToArtifact({
        file_id: 'file',
        filename,
        text: 'Prefix\n\n…[truncated]',
      });
      const expected = filename.includes('.')
        ? filename.replace(/(\.[^.]+)$/, '.preview$1')
        : `${filename}.preview`;
      expect(getArtifactDownloadFilename(artifact!, 'content.md')).toBe(expected);
      expect(getArtifactDownloadFilename(artifact!, 'content.md', 'Edited prefix')).toBe(expected);
    },
  );

  it.each(['odt', 'docx', 'pptx'])('names extracted %s bytes as text after file routing', (ext) => {
    const artifact = fileToArtifact({
      file_id: 'file',
      filename: `report.${ext}`,
      text: 'Extracted text',
    });
    expect(artifact?.type).toBe(TOOL_ARTIFACT_TYPES.PLAIN_TEXT);
    expect(getArtifactDownloadFilename(artifact!, 'content.md')).toBe(`report.${ext}.preview.txt`);
  });

  it.each(['Complete file', 'Complete file\n\n…[truncated]'])(
    'does not infer truncation from cached file text: %s',
    (content) => {
      const artifact = fileToArtifact({ file_id: 'file', filename: 'notes.txt', text: content });
      expect(getArtifactDownloadFilename(artifact!, 'content.md')).toBe('notes.preview.txt');
    },
  );

  it('does not read source comments as document headings', () => {
    expect(
      getArtifactDownloadFilename(
        {
          id: 'a',
          lastUpdateTime: 0,
          type: TOOL_ARTIFACT_TYPES.CODE,
          language: 'python',
          content: '# Copyright',
        },
        'content.md',
      ),
    ).toBe('code.py');
  });

  it('preserves a long file-backed source extension during sanitization', () => {
    const filename = `${'a'.repeat(200)}.py`;
    expect(
      getArtifactDownloadFilename(
        {
          id: 'a',
          lastUpdateTime: 0,
          type: TOOL_ARTIFACT_TYPES.CODE,
          title: filename,
          download: { file_id: 'file' },
        },
        'content.md',
      ),
    ).toBe(`${'a'.repeat(97)}.preview.py`);
  });
});

describe('artifactRowKind', () => {
  it('marks the rendered buckets as previews and code as source', () => {
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.HTML }).rendersPreview).toBe(true);
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.REACT }).rendersPreview).toBe(true);
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.MARKDOWN }).rendersPreview).toBe(true);
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.SPREADSHEET }).rendersPreview).toBe(true);
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.CODE, title: 'a.py' }).rendersPreview).toBe(
      false,
    );
    /* Plain text opens on the panel's rendered markdown preview
     * (`useArtifactProps` -> `getMarkdownFiles`), so the row announces a
     * preview rather than source. */
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.PLAIN_TEXT }).rendersPreview).toBe(true);
  });

  it('names each rendered format with its own label', () => {
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.HTML }).label).toEqual({
      key: 'com_ui_artifact_format_html',
    });
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.PRESENTATION }).label).toEqual({
      key: 'com_ui_artifact_format_presentation',
    });
  });

  it('resolves the model-authored type spellings to the same buckets', () => {
    /* The markdown `:::artifact` path passes the authored attribute
     * through verbatim, so these aliases reach the row alongside the
     * canonical MIMEs. */
    expect(artifactRowKind({ type: 'application/vnd.ant.react' })).toEqual(
      artifactRowKind({ type: TOOL_ARTIFACT_TYPES.REACT }),
    );
    expect(artifactRowKind({ type: 'application/vnd.code-html' })).toEqual(
      artifactRowKind({ type: TOOL_ARTIFACT_TYPES.HTML }),
    );
    expect(artifactRowKind({ type: 'text/md' })).toEqual(
      artifactRowKind({ type: TOOL_ARTIFACT_TYPES.MARKDOWN }),
    );
  });

  it('labels a code artifact with its language, preferring the stored hint', () => {
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.CODE, language: 'python' })).toMatchObject({
      lang: 'python',
      label: { text: 'python' },
    });
    /* No stored hint (older records, markdown path) — derive it from the
     * title the way the panel derives its fence hint. */
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.CODE, title: 'main.rs' })).toMatchObject({
      lang: 'rust',
      label: { text: 'rust' },
    });
    /* Neither: an extensionless, unrecognized name still needs a label. */
    expect(artifactRowKind({ type: TOOL_ARTIFACT_TYPES.CODE, title: 'script' })).toMatchObject({
      lang: '',
      label: { key: 'com_ui_code' },
    });
  });

  it('treats an unknown type as a rendered artifact, matching the static template fallback', () => {
    expect(artifactRowKind({ type: 'application/x-unheard-of' })).toMatchObject({
      rendersPreview: true,
      fallbackGlyph: 'preview',
    });
    expect(artifactRowKind({})).toMatchObject({ rendersPreview: true });
  });
});
