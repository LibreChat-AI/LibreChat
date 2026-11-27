import { isSafeUrl, getMarkdownFiles, EMBEDDED_IS_SAFE_URL } from '../markdown';

describe('isSafeUrl', () => {
  it('allows https URLs', () => {
    expect(isSafeUrl('https://example.com')).toBe(true);
  });

  it('allows http URLs', () => {
    expect(isSafeUrl('http://example.com/path')).toBe(true);
  });

  it('allows mailto links', () => {
    expect(isSafeUrl('mailto:user@example.com')).toBe(true);
  });

  it('allows tel links', () => {
    expect(isSafeUrl('tel:+1234567890')).toBe(true);
  });

  it('allows relative paths', () => {
    expect(isSafeUrl('/path/to/page')).toBe(true);
    expect(isSafeUrl('./relative')).toBe(true);
    expect(isSafeUrl('../parent')).toBe(true);
  });

  it('allows anchor links', () => {
    expect(isSafeUrl('#section')).toBe(true);
  });

  it('blocks javascript: protocol', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('blocks javascript: with leading whitespace', () => {
    expect(isSafeUrl('  javascript:alert(1)')).toBe(false);
  });

  it('blocks javascript: with mixed case', () => {
    expect(isSafeUrl('JavaScript:alert(1)')).toBe(false);
  });

  it('blocks data: protocol', () => {
    expect(isSafeUrl('data:text/html,<b>x</b>')).toBe(false);
  });

  it('blocks blob: protocol', () => {
    expect(isSafeUrl('blob:http://example.com/uuid')).toBe(false);
  });

  it('blocks vbscript: protocol', () => {
    expect(isSafeUrl('vbscript:MsgBox("xss")')).toBe(false);
  });

  it('blocks file: protocol', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
  });

  it('blocks empty strings', () => {
    expect(isSafeUrl('')).toBe(false);
  });

  it('blocks whitespace-only strings', () => {
    expect(isSafeUrl('   ')).toBe(false);
  });

  it('blocks unknown/custom protocols', () => {
    expect(isSafeUrl('custom:payload')).toBe(false);
  });
});

describe('isSafeUrl sync verification', () => {
  const embeddedFn = new Function('url', EMBEDDED_IS_SAFE_URL + '\nreturn isSafeUrl(url);') as (
    url: string,
  ) => boolean;

  const cases: [string, boolean][] = [
    ['https://example.com', true],
    ['http://example.com', true],
    ['mailto:a@b.com', true],
    ['tel:+1234567890', true],
    ['/relative', true],
    ['./relative', true],
    ['../up', true],
    ['#anchor', true],
    ['javascript:alert(1)', false],
    ['  javascript:void(0)', false],
    ['data:text/html,<b>x</b>', false],
    ['blob:http://x.com/uuid', false],
    ['vbscript:run', false],
    ['file:///etc/passwd', false],
    ['custom:payload', false],
    ['', false],
    ['   ', false],
  ];

  it.each(cases)('embedded copy matches exported isSafeUrl for %j → %s', (url, expected) => {
    expect(embeddedFn(url)).toBe(expected);
    expect(isSafeUrl(url)).toBe(expected);
  });
});

describe('markdown artifacts', () => {
  describe('getMarkdownFiles', () => {
    it('should return content.md with the original markdown content', () => {
      const markdown = '# Hello World\n\nThis is a test.';
      const files = getMarkdownFiles(markdown);

      expect(files['content.md']).toBe(markdown);
    });

    it('should return default content when markdown is empty', () => {
      const files = getMarkdownFiles('');

      expect(files['content.md']).toBe('# No content provided');
    });

    it('should include index.html with static markdown rendering', () => {
      const markdown = '# Test';
      const files = getMarkdownFiles(markdown);

      expect(files['index.html']).toContain('<!DOCTYPE html>');
      expect(files['index.html']).toContain('marked.min.js');
      expect(files['index.html']).toContain('marked.parse');
      expect(files['index.html']).toContain('# Test');
    });

    it('should only produce content.md and index.html', () => {
      const files = getMarkdownFiles('# Test');
      expect(Object.keys(files).sort()).toEqual(['content.md', 'index.html']);
    });

    it('should include markdown CSS in index.html', () => {
      const files = getMarkdownFiles('# Test');
      expect(files['index.html']).toContain('.markdown-body');
      expect(files['index.html']).toContain('list-style-type: disc');
      expect(files['index.html']).toContain('prefers-color-scheme: dark');
    });

    /** The base sheet picks its palette from the iframe's own
     *  `prefers-color-scheme`, so the contrast block is appended unconditionally
     *  and therefore also overrides that media query. */
    it('appends a contrast override that outranks the media query', () => {
      const standard = getMarkdownFiles('# Test')['index.html'];
      expect(standard).toContain('prefers-color-scheme: dark');
      expect(standard).not.toContain('background-color: #000000');

      const contrastDark = getMarkdownFiles('# Test', true, true)['index.html'];
      const overrideIndex = contrastDark.lastIndexOf('.markdown-body { color: #ffffff');
      expect(overrideIndex).toBeGreaterThan(contrastDark.indexOf('prefers-color-scheme: dark'));
      expect(contrastDark).toContain('background-color: #000000');
      expect(contrastDark).toContain('color: #8cc8ff');

      const contrastLight = getMarkdownFiles('# Test', false, true)['index.html'];
      expect(contrastLight).toContain('.markdown-body { color: #000000');
      expect(contrastLight).toContain('color: #0000cc');
    });

    /** Anything the base sheet colours inside the media query has to be answered
     *  by the appended block, or an explicit contrast choice keeps a GitHub
     *  palette value wherever the override forgot to reach. */
    it('answers every media-query colour in the contrast block', () => {
      const styleOf = (html: string) =>
        html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'));
      const baseStyle = styleOf(getMarkdownFiles('# Test')['index.html']);
      const override = styleOf(getMarkdownFiles('# Test', true, true)['index.html']).slice(
        baseStyle.length,
      );

      /** `selector -> property` pairs, one per selector in a comma-separated list. */
      const declarations = (css: string): string[] =>
        [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) =>
          selectors.split(',').flatMap((selector) =>
            body
              .split(';')
              .map((declaration) => declaration.split(':')[0].trim())
              .filter(Boolean)
              .map((property) => `${selector.trim()} -> ${property}`),
          ),
        );

      const answered = new Set(declarations(override));
      const mediaBlocks = [
        ...baseStyle.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/g),
      ];
      expect(mediaBlocks.length).toBeGreaterThan(0);

      const unanswered = mediaBlocks
        .flatMap(([, block]) => declarations(block))
        .filter((declaration) => !answered.has(declaration));
      expect(unanswered).toEqual([]);
    });

    /** A CDN outage inside a contrast mode is exactly when the message matters,
     *  and an inline style would be the one colour the override cannot reach. */
    it('themes the renderer failure message', () => {
      const standard = getMarkdownFiles('# Test')['index.html'];
      expect(standard).toContain('class="markdown-error"');
      expect(standard).not.toMatch(/style="color:/);
      expect(standard).toContain('color: #e53e3e');

      expect(getMarkdownFiles('# Test', true, true)['index.html']).toContain(
        '.markdown-error { color: #ff8f8f; }',
      );
      expect(getMarkdownFiles('# Test', false, true)['index.html']).toContain(
        '.markdown-error { color: #a10000; }',
      );
    });

    describe('content escaping', () => {
      it('should escape backticks in markdown content', () => {
        const markdown = 'Here is some `inline code`';
        const files = getMarkdownFiles(markdown);

        expect(files['index.html']).toContain('\\`');
      });

      it('should escape backslashes in markdown content', () => {
        const markdown = 'Path: C:\\Users\\Test';
        const files = getMarkdownFiles(markdown);

        expect(files['index.html']).toContain('\\\\');
      });

      it('should escape dollar signs in markdown content', () => {
        const markdown = 'Price: $100';
        const files = getMarkdownFiles(markdown);

        expect(files['index.html']).toContain('\\$');
      });

      it('should handle code blocks with backticks', () => {
        const markdown = '```js\nconsole.log("test");\n```';
        const files = getMarkdownFiles(markdown);

        expect(files['index.html']).toContain('\\`\\`\\`');
      });

      it('should prevent </script> in content from breaking out of the script block', () => {
        const markdown = 'Some content with </script><script>alert(1)</script>';
        const files = getMarkdownFiles(markdown);

        expect(files['index.html']).not.toContain('</script><script>alert(1)');
        expect(files['index.html']).toContain('<\\/script');
      });
    });

    describe('list indentation normalization', () => {
      it('should normalize 2-space indented lists to 4-space', () => {
        const markdown = '- Item 1\n  - Subitem 1\n  - Subitem 2';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
        expect(files['index.html']).toContain('- Item 1');
        expect(files['index.html']).toContain('Subitem 1');
      });

      it('should handle numbered lists with 2-space indents', () => {
        const markdown = '1. First\n  2. Second nested';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
        expect(files['index.html']).toContain('1. First');
        expect(files['index.html']).toContain('2. Second nested');
      });

      it('should not affect already 4-space indented lists', () => {
        const markdown = '- Item 1\n    - Subitem 1';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
        expect(files['index.html']).toContain('- Item 1');
        expect(files['index.html']).toContain('Subitem 1');
      });
    });

    describe('edge cases', () => {
      it('should handle very long markdown content', () => {
        const longMarkdown = '# Test\n\n' + 'Lorem ipsum '.repeat(1000);
        const files = getMarkdownFiles(longMarkdown);

        expect(files['content.md']).toBe(longMarkdown);
        expect(files['index.html']).toContain('Lorem ipsum');
      });

      it('should handle markdown with special characters', () => {
        const markdown = '# Test & < > " \'';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });

      it('should handle markdown with unicode characters', () => {
        const markdown = '# 你好 世界 🌍';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });

      it('should handle markdown with only whitespace', () => {
        const markdown = '   \n\n   ';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });

      it('should handle markdown with mixed line endings', () => {
        const markdown = '# Line 1\r\n## Line 2\n### Line 3';
        const files = getMarkdownFiles(markdown);

        expect(files['content.md']).toBe(markdown);
      });
    });
  });

  describe('static HTML structure', () => {
    it('should generate a complete HTML document with marked.js', () => {
      const files = getMarkdownFiles('# Test');
      const html = files['index.html'];

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('<title>Markdown Preview</title>');
      expect(html).toContain('marked.min.js');
      expect(html).toContain('marked.use(');
      expect(html).toContain('marked.parse(');
    });

    it('should pin the CDN script to an exact version with SRI', () => {
      const files = getMarkdownFiles('# Test');
      const html = files['index.html'];

      expect(html).toMatch(/marked@\d+\.\d+\.\d+/);
      expect(html).toContain('integrity="sha384-');
      expect(html).toContain('crossorigin="anonymous"');
    });

    it('should show an error message when marked fails to load', () => {
      const files = getMarkdownFiles('# Test');
      const html = files['index.html'];

      expect(html).toContain("typeof marked === 'undefined'");
      expect(html).toContain('failed to load');
      expect(html).toContain('class="markdown-error"');
    });

    it('should strip raw HTML blocks via renderer override', () => {
      const files = getMarkdownFiles('# Test');
      const html = files['index.html'];

      expect(html).toContain("html() { return ''; }");
    });

    it('should embed isSafeUrl logic in the HTML for link sanitization', () => {
      const files = getMarkdownFiles('# Test');
      const html = files['index.html'];

      expect(html).toContain("new Set(['http:', 'https:', 'mailto:', 'tel:'])");
      expect(html).toContain('isSafeUrl');
      expect(html).toContain("trimmed.startsWith('/')");
      expect(html).toContain("trimmed.startsWith('#')");
      expect(html).toContain("trimmed.startsWith('.')");
    });

    it('should configure marked with GFM and line-break support', () => {
      const files = getMarkdownFiles('# Test');
      const html = files['index.html'];

      expect(html).toContain('gfm: true');
      expect(html).toContain('breaks: true');
    });

    it('should configure a custom renderer for link/image sanitization', () => {
      const files = getMarkdownFiles('# Test');
      const html = files['index.html'];

      expect(html).toContain('renderer:');
      expect(html).toContain('link(token)');
      expect(html).toContain('image(token)');
    });

    it('should embed the markdown content in the HTML', () => {
      const testContent = '# Heading\n- List item';
      const files = getMarkdownFiles(testContent);
      const html = files['index.html'];

      expect(html).toContain('# Heading');
      expect(html).toContain('- List item');
    });
  });
});
