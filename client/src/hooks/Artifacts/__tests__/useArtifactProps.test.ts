import { renderHook } from '@testing-library/react';
import type { Artifact } from '~/common';
import { TOOL_ARTIFACT_TYPES, wrapAsFencedCodeBlock } from '~/utils/artifacts';
import useArtifactProps from '../useArtifactProps';

describe('useArtifactProps', () => {
  const createArtifact = (partial: Partial<Artifact>): Artifact => ({
    id: 'test-id',
    lastUpdateTime: Date.now(),
    ...partial,
  });

  describe('markdown artifacts', () => {
    it('should handle text/markdown type with content.md as fileKey', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        content: '# Hello World\n\nThis is markdown.',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.fileKey).toBe('content.md');
      expect(result.current.template).toBe('static');
    });

    it('should handle text/plain type with content.md as fileKey', () => {
      const artifact = createArtifact({
        type: 'text/plain',
        content: '# Plain text as markdown',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.fileKey).toBe('content.md');
      expect(result.current.template).toBe('static');
    });

    it('should include content.md in files with original markdown', () => {
      const markdownContent = '# Test\n\n- Item 1\n- Item 2';
      const artifact = createArtifact({
        type: 'text/markdown',
        content: markdownContent,
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.files['content.md']).toBe(markdownContent);
    });

    it('should include index.html with static markdown rendering', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        content: '# Test',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.files['index.html']).toContain('<!DOCTYPE html>');
      expect(result.current.files['index.html']).toContain('marked.parse');
    });

    it('should include all required markdown files', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        content: '# Test',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.files['content.md']).toBeDefined();
      expect(result.current.files['index.html']).toBeDefined();
    });

    it('should escape special characters in markdown content', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        content: 'Code: `const x = 1;`\nPath: C:\\Users',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.files['content.md']).toContain('`const x = 1;`');
      expect(result.current.files['content.md']).toContain('C:\\Users');

      expect(result.current.files['index.html']).toContain('\\`');
      expect(result.current.files['index.html']).toContain('\\\\');
    });

    it('should handle empty markdown content', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        content: '',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.files['content.md']).toBe('# No content provided');
    });

    it('should handle undefined markdown content', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.files['content.md']).toBe('# No content provided');
    });

    it('should have no custom dependencies for markdown (uses CDN)', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        content: '# Test',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      const deps = result.current.sharedProps.customSetup?.dependencies ?? {};
      expect(deps).toEqual({});
    });

    it('should update files when content changes', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        content: '# Original',
      });

      const { result, rerender } = renderHook(({ artifact }) => useArtifactProps({ artifact }), {
        initialProps: { artifact },
      });

      expect(result.current.files['content.md']).toBe('# Original');

      const updatedArtifact = createArtifact({
        ...artifact,
        content: '# Updated',
      });

      rerender({ artifact: updatedArtifact });

      expect(result.current.files['content.md']).toBe('# Updated');
    });
  });

  describe('mermaid artifacts', () => {
    it('should handle mermaid type with content.md as fileKey', () => {
      const artifact = createArtifact({
        type: 'application/vnd.mermaid',
        content: 'graph TD\n  A-->B',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.fileKey).toBe('diagram.mmd');
      expect(result.current.template).toBe('react-ts');
    });
  });

  describe('react artifacts', () => {
    it('should handle react type with App.tsx as fileKey', () => {
      const artifact = createArtifact({
        type: 'application/vnd.react',
        content: 'export default () => <div>Test</div>',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.fileKey).toBe('App.tsx');
      expect(result.current.template).toBe('react-ts');
    });
  });

  describe('html artifacts', () => {
    it('should handle html type with index.html as fileKey', () => {
      const artifact = createArtifact({
        type: 'text/html',
        content: '<html><body>Test</body></html>',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.fileKey).toBe('index.html');
      expect(result.current.template).toBe('static');
    });
  });

  describe('svg artifacts', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600"><rect width="800" height="600" fill="#0f172a"/></svg>';

    it('uses index.svg as the editor fileKey on the static template', () => {
      const artifact = createArtifact({ type: 'image/svg+xml', content: svg });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      expect(result.current.fileKey).toBe('index.svg');
      expect(result.current.template).toBe('static');
    });

    it('keeps the source on index.svg and wraps it in index.html for preview', () => {
      const artifact = createArtifact({ type: 'image/svg+xml', content: svg });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      expect(result.current.files['index.svg']).toBe(svg);
      expect(result.current.files['index.html']).toMatch(/<!DOCTYPE html>/i);
      expect(result.current.files['index.html']).toContain(svg);
    });

    it('accepts the image/svg alias', () => {
      const artifact = createArtifact({ type: 'image/svg', content: '<svg></svg>' });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      expect(result.current.fileKey).toBe('index.svg');
      expect(result.current.files['index.html']).toContain('<svg></svg>');
    });

    it('exposes deriveFiles so edited source can rebuild the derived preview entry', () => {
      const artifact = createArtifact({ type: 'image/svg+xml', content: svg });
      const { result } = renderHook(() => useArtifactProps({ artifact }));

      const edited = '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4"/></svg>';
      const rebuilt = result.current.deriveFiles?.(edited) ?? {};

      expect(rebuilt['index.svg']).toBe(edited);
      expect(rebuilt['index.html']).toContain(edited);
      expect(rebuilt['index.html']).not.toContain('<rect');
    });

    it('leaves deriveFiles unset when the edited file is the preview entry', () => {
      const artifact = createArtifact({ type: 'text/html', content: '<p>hi</p>' });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      expect(result.current.deriveFiles).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle artifact with language parameter', () => {
      const artifact = createArtifact({
        type: 'text/markdown',
        language: 'en',
        content: '# Test',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.fileKey).toBe('content.md');
      expect(result.current.files['content.md']).toBe('# Test');
    });

    it('should handle artifact with undefined type', () => {
      const artifact = createArtifact({
        content: '# Test',
      });

      const { result } = renderHook(() => useArtifactProps({ artifact }));

      expect(result.current.template).toBe('static');
    });
  });

  describe('CODE artifacts', () => {
    /* The CODE bucket reuses the static markdown pipeline — `marked`
     * renders the wrapped fenced block as `<pre><code class="language-X">…`.
     * These tests pin the wrap-then-render shape end-to-end so a future
     * highlighter swap-in or CDN bump can't silently break the panel
     * for code files. */
    it('routes CODE artifacts to content.md / static template (markdown pipeline)', () => {
      const artifact = createArtifact({
        type: TOOL_ARTIFACT_TYPES.CODE,
        title: 'simple_graph.py',
        content: 'import matplotlib\nplt.savefig("foo.png")',
      });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      expect(result.current.fileKey).toBe('content.md');
      expect(result.current.template).toBe('static');
    });

    it('wraps the source as a fenced block with the language hint from the filename', () => {
      const artifact = createArtifact({
        type: TOOL_ARTIFACT_TYPES.CODE,
        title: 'simple_graph.py',
        content: 'x = 1\nprint(x)',
      });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      const md = result.current.files['content.md'] as string;
      /* Marked outputs `<pre><code class="language-python">` from this fence. */
      expect(md.startsWith('```python\n')).toBe(true);
      expect(md.endsWith('\n```')).toBe(true);
      expect(md).toContain('x = 1');
      expect(md).toContain('print(x)');
    });

    it('falls back to the raw extension as language hint for unknown extensions', () => {
      const artifact = createArtifact({
        type: TOOL_ARTIFACT_TYPES.CODE,
        title: 'thing.qwerty',
        content: 'data',
      });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      const md = result.current.files['content.md'] as string;
      expect(md.startsWith('```qwerty\n')).toBe(true);
    });

    it('uses an empty language hint when the title has no extension', () => {
      const artifact = createArtifact({
        type: TOOL_ARTIFACT_TYPES.CODE,
        title: 'Makefile-style',
        content: 'all: build',
      });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      const md = result.current.files['content.md'] as string;
      /* Empty hint = bare ` ``` ` opener (no language token). */
      expect(md.startsWith('```\n')).toBe(true);
    });

    it('renders an index.html via the markdown template (visual parity with .md artifacts)', () => {
      const artifact = createArtifact({
        type: TOOL_ARTIFACT_TYPES.CODE,
        title: 'app.js',
        content: 'console.log("hi");',
      });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      const html = result.current.files['index.html'] as string;
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('marked.parse');
    });

    /* Codex review P3: when `fileToArtifact` resolved a language via
     * MIME fallback (extensionless title, useful MIME), the resolved
     * value is stored on `artifact.language`. The hook reads it
     * directly so the fence still gets the right `language-<x>` class. */
    it('uses pre-resolved artifact.language (covers MIME fallback for extensionless titles)', () => {
      const artifact = createArtifact({
        type: TOOL_ARTIFACT_TYPES.CODE,
        title: 'noext',
        language: 'python',
        content: 'print(1)',
      });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      const md = result.current.files['content.md'] as string;
      expect(md.startsWith('```python\n')).toBe(true);
    });

    it('falls back to title-derived language when artifact.language is unset', () => {
      /* Older callers that don't populate `language` still get a
       * sensible fence via title-based lookup. */
      const artifact = createArtifact({
        type: TOOL_ARTIFACT_TYPES.CODE,
        title: 'app.js',
        content: 'console.log("hi");',
      });
      const { result } = renderHook(() => useArtifactProps({ artifact }));
      const md = result.current.files['content.md'] as string;
      expect(md.startsWith('```javascript\n')).toBe(true);
    });
  });
});

describe('wrapAsFencedCodeBlock', () => {
  it('wraps source with the supplied language hint', () => {
    expect(wrapAsFencedCodeBlock('print(1)', 'python')).toBe('```python\nprint(1)\n```');
  });

  it('emits a bare ``` opener when language is empty', () => {
    expect(wrapAsFencedCodeBlock('hello', '')).toBe('```\nhello\n```');
  });

  it('trims a single trailing newline so the closing fence stays flush', () => {
    /* Extractor output often ends with a newline; without trimming, the
     * closing ``` would appear on its own line after a blank gap and
     * marked would render an extra <br>. */
    expect(wrapAsFencedCodeBlock('a\nb\n', 'go')).toBe('```go\na\nb\n```');
    /* Only ONE trailing newline gets trimmed — preserves explicit blank
     * lines at end-of-file in the output. */
    expect(wrapAsFencedCodeBlock('a\nb\n\n', 'go')).toBe('```go\na\nb\n\n```');
  });

  it('handles empty source cleanly (renders an empty fenced block)', () => {
    expect(wrapAsFencedCodeBlock('', 'python')).toBe('```python\n\n```');
  });

  /* Codex review P2: a hardcoded triple-backtick fence breaks when the
   * source itself contains a line starting with ``` (e.g. a JS template
   * literal embedding markdown). CommonMark closes the outer fence on
   * a line whose backtick run matches-or-exceeds the opener, so we have
   * to emit STRICTLY MORE backticks than any leading-backtick run in
   * the payload. */
  it('uses a 4-backtick fence when source has a triple-backtick line at column 0', () => {
    const src = 'const md = `\n```\nhello\n```\n`;';
    const wrapped = wrapAsFencedCodeBlock(src, 'js');
    expect(wrapped.startsWith('````js\n')).toBe(true);
    expect(wrapped.endsWith('\n````')).toBe(true);
    /* The payload's ``` lines are preserved verbatim — no escaping. */
    expect(wrapped).toContain('\n```\nhello\n```\n');
  });

  it('uses a 5-backtick fence when source has a quadruple-backtick line', () => {
    const src = 'before\n````\ninside\n````\nafter';
    const wrapped = wrapAsFencedCodeBlock(src, 'md');
    expect(wrapped.startsWith('`````md\n')).toBe(true);
    expect(wrapped.endsWith('\n`````')).toBe(true);
  });

  it('keeps the 3-backtick fence when source has no leading-backtick lines', () => {
    /* Ordinary code (no markdown-style fences) gets the conventional
     * triple-backtick fence — readable and matches `marked`'s default
     * expectations. */
    const wrapped = wrapAsFencedCodeBlock('x = 1\nprint(x)', 'python');
    expect(wrapped.startsWith('```python\n')).toBe(true);
    expect(wrapped.endsWith('\n```')).toBe(true);
  });

  it('does not escalate the fence for backticks that are NOT at start-of-line', () => {
    /* Inline backticks within a line don't count against the closing-
     * fence rule, so they don't need escalation. Keeps the fence
     * minimal for the common case (e.g. a Python file that uses
     * markdown ` `code` ` in a docstring). */
    const src = 'x = `inline backticks ``` here`';
    const wrapped = wrapAsFencedCodeBlock(src, 'python');
    expect(wrapped.startsWith('```python\n')).toBe(true);
    expect(wrapped.endsWith('\n```')).toBe(true);
  });

  it('escalates correctly when the source itself starts with a backtick run', () => {
    /* Edge: backticks at column 0 of the very first line. The leading-
     * run scan must catch this position (regex anchor allows
     * start-of-string match too). */
    const src = '```already-fenced\nbody\n```';
    const wrapped = wrapAsFencedCodeBlock(src, 'md');
    expect(wrapped.startsWith('````md\n')).toBe(true);
  });

  /* Codex review P2 follow-up: CommonMark allows fence closers indented
   * up to 3 spaces. The fence-length scan must catch backtick runs at
   * columns 0–3, not just column 0 — otherwise an indented `\`\`\``
   * inside a JS/Python source still terminates our outer fence. */
  it.each([
    [' ```', 4],
    ['  ```', 4],
    ['   ```', 4],
    [' ````', 5],
    ['   `````', 6],
  ])('escalates fence to %s+1 backticks for indented closer "%s"', (line, expectedFenceLen) => {
    const src = 'before\n' + line + '\nafter';
    const wrapped = wrapAsFencedCodeBlock(src, 'js');
    /* Fence prefix is `expectedFenceLen` backticks (one more than the
     * indented run inside the source). */
    expect(wrapped.startsWith('`'.repeat(expectedFenceLen) + 'js\n')).toBe(true);
    expect(wrapped.endsWith('\n' + '`'.repeat(expectedFenceLen))).toBe(true);
  });

  it('does NOT escalate for backticks indented 4+ spaces (CommonMark indented-code-block territory)', () => {
    /* 4-space indentation makes the line an indented code block, not a
     * fence closer. The CommonMark spec caps fence-closer indentation
     * at 3 spaces, so backticks at column 4+ can't terminate an
     * unindented opener. */
    const src = 'before\n    ```\nafter';
    const wrapped = wrapAsFencedCodeBlock(src, 'js');
    /* No escalation — keeps the default 3-backtick fence. */
    expect(wrapped.startsWith('```js\n')).toBe(true);
  });
});
