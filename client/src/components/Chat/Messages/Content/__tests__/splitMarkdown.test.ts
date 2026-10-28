import {
  createMarkdownSplitter,
  splitMarkdownIntoBlocks,
  splitMarkdownIntoBlocksUncached,
} from '../splitMarkdown';

const raws = (content: string) => splitMarkdownIntoBlocks(content).map((block) => block.raw);

describe('splitMarkdownIntoBlocks', () => {
  describe('incremental append-only streaming', () => {
    /** Splits every prefix in order (incremental) and from scratch (reference). */
    const streamed = (content: string) => {
      splitMarkdownIntoBlocks('unrelated content to reset the cache');
      const prefixes = Array.from({ length: content.length }, (_, i) => content.slice(0, i + 1));
      return {
        incremental: prefixes.map((prefix) => splitMarkdownIntoBlocks(prefix)),
        reference: prefixes.map((prefix) => splitMarkdownIntoBlocksUncached(prefix)),
      };
    };

    it('matches a full parse at every prefix of a mixed document', () => {
      const { incremental, reference } = streamed(
        [
          '# Title',
          '',
          'Para one with `code` and **bold**.',
          '',
          '```js',
          'const a = 1;',
          '',
          'const b = 2;',
          '```',
          '',
          '| a | b |',
          '| - | - |',
          '| 1 | 2 |',
          '',
          '- one',
          '- two',
          '',
          '  nested para',
          '',
          '$$',
          'E = mc^2',
          '$$',
          '',
          ':::artifact{title="t"}',
          'inner',
          '',
          '```mermaid',
          'graph TD; A-->B;',
          '```',
          ':::',
          '',
          'Setext',
          '===',
          '',
          '> quote',
          'lazy continuation',
          '',
          '    indented',
          '',
          '    code continues',
          '',
          'Final.',
        ].join('\n'),
      );
      expect(incremental).toEqual(reference);
    });

    it.each([
      'Intro\n***important***.',
      'Intro\n#hashtag',
      'Intro\n```inline```',
      '- item\n***important***.',
      '> quote\n***important***.',
      'Intro\n$$inline$$',
      'Intro\n:::artifact{title="t"}\nbody\n:::',
    ])('reconsiders provisional boundaries at every prefix of %j', (content) => {
      const document = `# Stable heading\n\nEarlier paragraph.\n\n${content}\n\nFinal.`;
      const { incremental, reference } = streamed(document);
      expect(incremental).toEqual(reference);
    });

    it('reuses blocks before the two-block tail', () => {
      const split = createMarkdownSplitter();
      const content = '# Stable heading\n\nEarlier paragraph.\n\nIntro\n***';
      const before = split(content);
      const after = split(`${content}important***.`);
      expect(after).toEqual(splitMarkdownIntoBlocksUncached(`${content}important***.`));
      expect(after[0]).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
    });

    it('matches a full parse when a streamed definition forces whole-message rendering', () => {
      const { incremental, reference } = streamed(
        'See [docs][d] for details.\n\nMore text.\n\n[d]: https://example.com/docs\n\nEnd.',
      );
      expect(incremental).toEqual(reference);
    });

    it('matches a full parse when a streamed footnote definition nests in a list item', () => {
      const { incremental, reference } = streamed('Claim.[^1]\n\n- item\n\n  [^1]: note\n\nEnd.');
      expect(incremental).toEqual(reference);
    });

    it('matches a full parse when a streamed HTML block forces whole-message rendering', () => {
      const { incremental, reference } = streamed(
        'Intro.\n\n<div>a</div>\n\n<div>b</div>\n\nOutro.',
      );
      expect(incremental).toEqual(reference);
    });

    it('matches a full parse after non-append edits', () => {
      splitMarkdownIntoBlocks('First.\n\nSecond.');
      const edited = 'First.\n\nChanged.\n\nThird.';
      expect(splitMarkdownIntoBlocks(edited)).toEqual(splitMarkdownIntoBlocksUncached(edited));
      const shorter = 'First.';
      expect(splitMarkdownIntoBlocks(shorter)).toEqual(splitMarkdownIntoBlocksUncached(shorter));
    });

    it('keeps independent stream caches isolated', () => {
      const first = createMarkdownSplitter();
      const second = createMarkdownSplitter();
      const firstPrefix = 'First stream.\n\nActive block';
      const secondPrefix = 'Second stream.\n\nActive block';

      first(firstPrefix);
      second(secondPrefix);

      expect(first(`${firstPrefix} continued.`)).toEqual(
        splitMarkdownIntoBlocksUncached(`${firstPrefix} continued.`),
      );
      expect(second(`${secondPrefix} continued.`)).toEqual(
        splitMarkdownIntoBlocksUncached(`${secondPrefix} continued.`),
      );
    });
  });

  it('returns [] for empty content', () => {
    expect(splitMarkdownIntoBlocks('')).toEqual([]);
  });

  it('returns a single block for one paragraph', () => {
    expect(raws('Hello world.')).toEqual(['Hello world.']);
  });

  it('splits consecutive paragraphs into separate blocks', () => {
    expect(raws('First.\n\nSecond.')).toEqual(['First.', 'Second.']);
  });

  it('keeps a GFM table as one atomic block', () => {
    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    const content = `Intro.\n\n${table}\n\nOutro.`;
    expect(raws(content)).toEqual(['Intro.', table, 'Outro.']);
  });

  it('keeps a fenced code block (with internal blank lines) as one block', () => {
    const code = '```js\nconst x = 1;\n\nconst y = 2;\n```';
    const content = `Before.\n\n${code}\n\nAfter.`;
    expect(raws(content)).toEqual(['Before.', code, 'After.']);
  });

  it('keeps a $$ math block as one block', () => {
    const mathBlock = '$$\nE = mc^2\n$$';
    const content = `Text.\n\n${mathBlock}\n\nMore.`;
    expect(raws(content)).toEqual(['Text.', mathBlock, 'More.']);
  });

  it('keeps a :::artifact::: container (with inner blank lines) intact', () => {
    const artifact = ':::artifact{title="t"}\nline one\n\nline two\n:::';
    const content = `Lead.\n\n${artifact}\n\nTail.`;
    expect(raws(content)).toEqual(['Lead.', artifact, 'Tail.']);
  });

  it("keeps a top-level block's indentation, which decides how it parses", () => {
    const fence = ['   ```python', '   def test():', '       assert True', '   ```'].join('\n');
    const content = ['9. Build:', '', '   make', '', '10. Run the tests:', '', fence].join('\n');
    expect(raws(content)).toEqual([content.slice(0, content.indexOf('\n\n   ```')), fence]);
  });

  it('keeps a list as one block (does not split items)', () => {
    const list = '- one\n- two\n- three';
    expect(raws(list)).toEqual([list]);
  });

  it('does not split inline constructs across blocks (inline code/markers stay in their paragraph)', () => {
    const para = 'Use `inline` code and \\ui{abc} markers here.';
    expect(raws(para)).toEqual([para]);
  });

  it('each block re-parses to the same single block (idempotent boundaries)', () => {
    const content = ['# Heading', '', 'A paragraph.', '', '```py\nprint(1)\n```'].join('\n');
    const blocks = raws(content);
    expect(blocks).toHaveLength(3);
    for (const block of blocks) {
      expect(raws(block)).toEqual([block]);
    }
  });

  describe('index counts (mirror the code/artifact render decision)', () => {
    it('counts a multi-line fenced code block as executable', () => {
      const [block] = splitMarkdownIntoBlocks('```js\nconst x = 1;\nconst y = 2;\n```');
      expect(block.codeBlockCount).toBe(1);
    });

    it('counts a single-line block with a known language as executable', () => {
      const [block] = splitMarkdownIntoBlocks('```bash\necho hi\n```');
      expect(block.codeBlockCount).toBe(1);
    });

    it('counts a no-language single-line block as executable', () => {
      const [block] = splitMarkdownIntoBlocks('```\necho hi\n```');
      expect(block.codeBlockCount).toBe(1);
    });

    it('counts a single-line block with an unsupported language (renderer still renders a CodeBlock)', () => {
      const [block] = splitMarkdownIntoBlocks('```madeuplang\nhi\n```');
      expect(block.codeBlockCount).toBe(1);
    });

    it('does NOT count math or mermaid fences', () => {
      expect(splitMarkdownIntoBlocks('```math\nE=mc^2\n```')[0].codeBlockCount).toBe(0);
      expect(splitMarkdownIntoBlocks('```mermaid\ngraph TD; A-->B;\n```')[0].codeBlockCount).toBe(
        0,
      );
    });

    it('does NOT count hyphenated math/mermaid languages (renderer normalizes them)', () => {
      expect(
        splitMarkdownIntoBlocks('```mermaid-js\ngraph TD; A-->B;\n```')[0].codeBlockCount,
      ).toBe(0);
      expect(splitMarkdownIntoBlocks('```math-tex\nE=mc^2\n```')[0].codeBlockCount).toBe(0);
    });

    it('does count a fence that merely starts with math/mermaid letters', () => {
      expect(splitMarkdownIntoBlocks('```mathematica\nx\n```')[0].codeBlockCount).toBe(1);
    });

    it('counts an artifact container once and does not count code inside it', () => {
      const artifact = ':::artifact{title="t"}\n```js\nconst x = 1;\nconst y = 2;\n```\n:::';
      const [block] = splitMarkdownIntoBlocks(artifact);
      expect(block.artifactCount).toBe(1);
      expect(block.codeBlockCount).toBe(0);
    });

    it('counts leaf artifact directives, not just containers', () => {
      expect(splitMarkdownIntoBlocks('::artifact{identifier="a" type="x"}')[0].artifactCount).toBe(
        1,
      );
    });

    it('does NOT count inline text artifact directives (the plugin rewrites them to text)', () => {
      expect(splitMarkdownIntoBlocks('see :artifact{identifier="b"} inline')[0].artifactCount).toBe(
        0,
      );
    });
  });

  describe('document-level definitions force single-block rendering', () => {
    it('keeps a reference-style link and its definition in one block', () => {
      const content = 'See [docs][d] for details.\n\n[d]: https://example.com/docs';
      const blocks = splitMarkdownIntoBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].raw).toBe(content);
    });

    it('keeps a footnote reference and its definition in one block', () => {
      const content = 'Claim with a note.[^1]\n\n[^1]: the footnote text';
      const blocks = splitMarkdownIntoBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].raw).toBe(content);
    });

    it('forces single-block when a definition is nested in a blockquote', () => {
      const content = 'See [docs][d].\n\n> [d]: https://example.com/docs';
      const blocks = splitMarkdownIntoBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].raw).toBe(content);
    });

    it('forces single-block when a definition is nested in a list item', () => {
      const content = 'See [a][d].\n\n- item\n\n  [d]: https://example.com';
      const blocks = splitMarkdownIntoBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].raw).toBe(content);
    });

    it('still splits when no document-level definition is present', () => {
      const blocks = splitMarkdownIntoBlocks('First paragraph.\n\nSecond paragraph.');
      expect(blocks).toHaveLength(2);
    });
  });

  describe('raw HTML blocks force single-block rendering', () => {
    it('renders the whole message as one block for multiple top-level HTML blocks', () => {
      const content = '<div>a</div>\n\n<div>b</div>';
      const blocks = splitMarkdownIntoBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].raw).toBe(content);
    });

    it('still splits when HTML is only inline within a paragraph', () => {
      const blocks = splitMarkdownIntoBlocks('para with <br> inline.\n\nsecond para');
      expect(blocks).toHaveLength(2);
    });
  });
});
