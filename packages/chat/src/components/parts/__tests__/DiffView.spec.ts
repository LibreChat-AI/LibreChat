import { parseUnifiedDiff, buildEditPreviewDiff } from '../DiffView';

describe('parseUnifiedDiff', () => {
  it('drops file headers but keeps changed lines that begin with header markers', () => {
    const parsed = parseUnifiedDiff(
      [
        '--- a/example.txt',
        '+++ b/example.txt',
        '@@ -4,2 +4,2 @@',
        '--- deleted text',
        '+++ added text',
        ' unchanged',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      additions: 1,
      deletions: 1,
      hasLineNumbers: true,
      lines: [
        { type: 'hunk', text: '@@ -4,2 +4,2 @@' },
        { type: 'del', text: '-- deleted text', oldLine: 4 },
        { type: 'add', text: '++ added text', newLine: 4 },
        { type: 'context', text: 'unchanged', oldLine: 5, newLine: 5 },
      ],
    });
  });

  it('keeps the same changed lines after an argless streaming hunk marker', () => {
    const parsed = parseUnifiedDiff(
      ['--- old_text', '+++ new_text', '@@', '--- deleted text', '+++ added text'].join('\n'),
    );

    expect(parsed.lines).toEqual([
      { type: 'hunk', text: '' },
      { type: 'del', text: '-- deleted text', oldLine: undefined },
      { type: 'add', text: '++ added text', newLine: undefined },
    ]);
    expect(parsed.additions).toBe(1);
    expect(parsed.deletions).toBe(1);
  });

  it('counts a batched edit preview from its structured edits', () => {
    /** Built directly rather than formatted into diff text and parsed back:
     *  the separators that round trip needed were byte-identical to a real
     *  changed line, so no parser could tell them apart. */
    const parsed = buildEditPreviewDiff([
      { oldText: 'first old', newText: 'first new' },
      { oldText: 'second old', newText: 'second new' },
    ]);

    expect(parsed.deletions).toBe(2);
    expect(parsed.additions).toBe(2);
    expect(parsed.hasLineNumbers).toBe(false);
    expect(parsed.lines).toEqual([
      { type: 'del', text: 'first old' },
      { type: 'add', text: 'first new' },
      { type: 'hunk', text: '' },
      { type: 'del', text: 'second old' },
      { type: 'add', text: 'second new' },
    ]);
  });

  it('keeps multi-line replacement text as separate rows', () => {
    const parsed = buildEditPreviewDiff([{ oldText: 'a\nb', newText: 'c' }]);

    expect(parsed.deletions).toBe(2);
    expect(parsed.additions).toBe(1);
    expect(parsed.lines.map((line) => line.text)).toEqual(['a', 'b', 'c']);
  });

  it('does not count an empty replacement as an added line', () => {
    /** A pure deletion (`new_text: ""`) must not render a blank green row or
     *  report an addition; `''.split('\n')` yields one element. */
    const parsed = buildEditPreviewDiff([{ oldText: 'gone', newText: '' }]);

    expect(parsed.deletions).toBe(1);
    expect(parsed.additions).toBe(0);
    expect(parsed.lines).toEqual([{ type: 'del', text: 'gone' }]);
  });

  it('treats a trailing newline as a terminator, not an empty final line', () => {
    const parsed = buildEditPreviewDiff([{ oldText: 'a\n', newText: 'b\n' }]);

    expect(parsed.deletions).toBe(1);
    expect(parsed.additions).toBe(1);
    expect(parsed.lines.map((line) => line.text)).toEqual(['a', 'b']);
  });

  it('keeps changed lines that look like the old synthetic header names', () => {
    /** Deleting a real `-- old_text` comment (SQL, Lua) and adding
     *  `++ new_text` prefixes to exactly the text the removed separators used.
     *  Nothing emits those separators any more, so these are unambiguously
     *  content and must survive. */
    const parsed = parseUnifiedDiff(['@@ -1,2 +1,2 @@', '--- old_text', '+++ new_text'].join('\n'));

    expect(parsed.deletions).toBe(1);
    expect(parsed.additions).toBe(1);
    expect(parsed.lines).toEqual([
      { type: 'hunk', text: '@@ -1,2 +1,2 @@' },
      { type: 'del', text: '-- old_text', oldLine: 1 },
      { type: 'add', text: '++ new_text', newLine: 1 },
    ]);
  });
});
