import { apiBaseUrl } from 'librechat-data-provider';
import { markdownToHtml } from './richtext';

describe('markdownToHtml', () => {
  it('returns an empty string for empty markdown', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('   \n  ')).toBe('');
  });

  it('converts headings, emphasis and paragraphs', () => {
    expect(markdownToHtml('# Title\n\nSome **bold** and *italic* text.')).toBe(
      '<h1>Title</h1>\n<p>Some <strong>bold</strong> and <em>italic</em> text.</p>',
    );
  });

  it('converts unordered and ordered lists', () => {
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
    expect(markdownToHtml('3. three\n4. four')).toBe(
      '<ol start="3"><li>three</li><li>four</li></ol>',
    );
  });

  it('marks task list items', () => {
    expect(markdownToHtml('- [x] done\n- [ ] todo')).toBe(
      '<ul><li>☑ done</li><li>☐ todo</li></ul>',
    );
  });

  it('styles tables so they keep their borders when pasted', () => {
    const html = markdownToHtml('| a | b |\n| --- | ---: |\n| 1 | 2 |');

    expect(html).toContain('<table style="border-collapse:collapse;">');
    expect(html).toContain('<thead><tr><th style="border:1px solid #d0d7de;padding:6px 13px;');
    expect(html).toContain('text-align:right;">b</th>');
    expect(html).toContain('<tbody><tr><td');
    expect(html).toContain('>1</td>');
  });

  it('keeps code blocks and inline code monospaced', () => {
    const html = markdownToHtml('Run `npm test`\n\n```js\nconst a = 1;\n```');

    expect(html).toContain('<code style="font-family:ui-monospace');
    expect(html).toContain('npm test</code>');
    expect(html).toContain('<pre style="font-family:ui-monospace');
    expect(html).toContain('<code>const a = 1;</code></pre>');
  });

  it('keeps safe links and drops unsafe ones', () => {
    expect(markdownToHtml('[docs](https://example.com)')).toBe(
      '<p><a href="https://example.com">docs</a></p>',
    );
    expect(markdownToHtml('[click](javascript:alert(1))')).toBe('<p>click</p>');
  });

  it('escapes text, code and raw html instead of emitting markup', () => {
    expect(markdownToHtml('5 < 6 & "quoted"')).toBe('<p>5 &lt; 6 &amp; &quot;quoted&quot;</p>');
    expect(markdownToHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(markdownToHtml('`<b>x</b>`')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('converts blockquotes, rules, strikethrough and images', () => {
    expect(markdownToHtml('> quoted')).toContain('<blockquote style="margin:0 0 16px;');
    expect(markdownToHtml('---')).toBe('<hr />');
    expect(markdownToHtml('~~gone~~')).toBe('<p><s>gone</s></p>');
    expect(markdownToHtml('![alt](https://example.com/a.png)')).toBe(
      '<p><img src="https://example.com/a.png" alt="alt" /></p>',
    );
  });

  it('renders math as its LaTeX source and unwraps directives', () => {
    expect(markdownToHtml('$$E = mc^2$$')).toBe('<p>E = mc^2</p>');
    expect(markdownToHtml(':::note\ncontents\n:::')).toBe('<p>contents</p>');
  });

  it('keeps directive markers literal for the lite renderer, which has no directives', () => {
    expect(markdownToHtml(':::warning\ntext\n:::', { variant: 'lite', latex: false })).toBe(
      '<p>:::warning<br />text<br />:::</p>',
    );
  });

  it('applies the supersub transform the renderers apply', () => {
    expect(markdownToHtml('x^2^ is squared')).toBe('<p>x<sup>2</sup> is squared</p>');
    expect(markdownToHtml('x^2^ is squared', { variant: 'lite', latex: false })).toBe(
      '<p>x<sup>2</sup> is squared</p>',
    );
  });

  it('leaves an approximate tilde out of the subscript pairing', () => {
    expect(markdownToHtml('about ~50% of the time')).toBe('<p>about ∼50% of the time</p>');
  });

  it('absolutizes relative links and images so they survive the paste', () => {
    expect(markdownToHtml('[file](/api/files/code/download/abc)')).toBe(
      `<p><a href="${new URL('/api/files/code/download/abc', document.baseURI).href}">file</a></p>`,
    );
    expect(markdownToHtml('![chart](/images/chart.png)')).toBe(
      `<p><img src="${new URL('/images/chart.png', document.baseURI).href}" alt="chart" /></p>`,
    );
  });

  it('keeps soft line breaks visible, as the pre-wrap renderer does', () => {
    expect(markdownToHtml('first line\nsecond line')).toBe('<p>first line<br />second line</p>');
  });

  it('keeps bare relative links and images, resolved against the app', () => {
    expect(markdownToHtml('[guide](docs/guide.html)')).toBe(
      `<p><a href="${new URL('docs/guide.html', document.baseURI).href}">guide</a></p>`,
    );
    expect(markdownToHtml('![plot](images/plot.png)')).toBe(
      `<p><img src="${new URL('images/plot.png', document.baseURI).href}" alt="plot" /></p>`,
    );
  });

  it('renders single-dollar math when the renderer parses LaTeX', () => {
    expect(markdownToHtml('Energy is $E=mc^2$ inline.', { variant: 'full', latex: true })).toBe(
      '<p>Energy is E=mc^2 inline.</p>',
    );
    expect(markdownToHtml('Energy is $E=mc^2$ inline.')).toBe('<p>Energy is $E=mc^2$ inline.</p>');
  });

  it('still leaves currency alone with LaTeX parsing on', () => {
    expect(markdownToHtml('Costs rose from $5 to $10.', { variant: 'full', latex: true })).toBe(
      '<p>Costs rose from $5 to $10.</p>',
    );
  });

  it('shows an inline directive by name, as the artifact plugin does', () => {
    expect(markdownToHtml('a :foo[bar] b')).toBe('<p>a :foo b</p>');
  });

  it('omits a footnote definition nothing references, as the renderer does', () => {
    expect(markdownToHtml('Plain text.\n\n[^unused]: never cited')).toBe('<p>Plain text.</p>');
  });

  it('keeps reserved labels from capturing a reference', () => {
    const markdown = 'Cited [1].\n\n[1]: https://other.example';

    expect(markdownToHtml(markdown)).toBe('<p>Cited <a href="https://other.example">1</a>.</p>');
    expect(
      markdownToHtml(markdown, { variant: 'full', latex: false, reserved: new Set(['1']) }),
    ).toBe('<p>Cited [1].</p>');
  });

  it('keeps a loose list wrapped in paragraphs, as the renderer does', () => {
    expect(markdownToHtml('- one\n\n- two')).toBe(
      '<ul><li><p>one</p></li><li><p>two</p></li></ul>',
    );
    expect(markdownToHtml('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('shows an artifact by its title, which is what the button displays', () => {
    expect(markdownToHtml(':::artifact{title="Chart component"}\ncode here\n:::')).toBe(
      '<p>Chart component</p>',
    );
  });

  it('falls back to the button default for an untitled artifact', () => {
    expect(markdownToHtml('::artifact{identifier="a" type="x"}')).toBe('<p>untitled</p>');
  });

  it('drops MCP resource markers rather than pasting the protocol text', () => {
    expect(markdownToHtml('See \\ui{resource1} here.')).toBe('<p>See  here.</p>');
    expect(markdownToHtml('See \\ui{a,b} here.')).toBe('<p>See  here.</p>');
  });

  it('leaves MCP markers alone for the lite renderer, which does not transform them', () => {
    expect(markdownToHtml('See \\ui{resource1} here.', { variant: 'lite', latex: false })).toBe(
      '<p>See \\ui{resource1} here.</p>',
    );
  });

  it('routes rooted image sources through the deployment base', () => {
    const html = markdownToHtml('![chart](/images/chart.png)');
    expect(html).toBe(
      `<p><img src="${new URL(`${apiBaseUrl()}/images/chart.png`, document.baseURI).href}" alt="chart" /></p>`,
    );
  });

  it('gathers footnote definitions into a footer in reference order', () => {
    const html = markdownToHtml('Second[^b] then first[^a].\n\n[^a]: alpha\n\n[^b]: beta');

    expect(html).toBe(
      '<p>Second<sup>1</sup> then first<sup>2</sup>.</p>\n' +
        '<div><sup>1</sup><p>beta</p></div>\n' +
        '<div><sup>2</sup><p>alpha</p></div>',
    );
  });

  it('keeps the first of two definitions sharing a label', () => {
    expect(
      markdownToHtml(
        '[docs][guide]\n\n[guide]: https://first.example\n[guide]: https://second.example',
      ),
    ).toBe('<p><a href="https://first.example">docs</a></p>');
  });

  it('routes a generated file link through the app, as the renderer does', () => {
    const url = 'https://provider.example/files/user-1/file-1/report.csv';
    const mode = { variant: 'full' as const, latex: false, userId: 'user-1' };

    expect(markdownToHtml(`[report](${url})`, mode)).toBe(
      `<p><a href="${new URL(`${apiBaseUrl()}/api/files/user-1/file-1/report.csv`, document.baseURI).href}">report</a></p>`,
    );
  });

  it("leaves another user's file link untouched", () => {
    const url = 'https://provider.example/files/user-2/file-1/report.csv';

    expect(
      markdownToHtml(`[report](${url})`, { variant: 'full', latex: false, userId: 'user-1' }),
    ).toBe(`<p><a href="${url}">report</a></p>`);
  });

  it('leaves paired currency alone, as the renderer does', () => {
    expect(markdownToHtml('Costs rose from $5 to $10.')).toBe('<p>Costs rose from $5 to $10.</p>');
  });

  it('resolves reference-style links and images against their definitions', () => {
    expect(markdownToHtml('See [docs][guide].\n\n[guide]: https://example.com')).toBe(
      '<p>See <a href="https://example.com">docs</a>.</p>',
    );
    expect(markdownToHtml('![logo][pic]\n\n[pic]: https://example.com/a.png')).toBe(
      '<p><img src="https://example.com/a.png" alt="logo" /></p>',
    );
  });

  it('falls back to plain text when a reference has no definition', () => {
    expect(markdownToHtml('See [docs][missing].')).toBe('<p>See [docs][missing].</p>');
  });

  it('pairs every background it sets with its own foreground', () => {
    const html = markdownToHtml('`x`\n\n```\ny\n```\n\n| a |\n| --- |\n| b |');
    const backgrounds = html.match(/background-color:[^;]+;/g) ?? [];

    expect(backgrounds.length).toBeGreaterThan(0);
    for (const style of html.match(/style="[^"]*background-color[^"]*"/g) ?? []) {
      expect(style).toContain('color:#24292f;');
    }
    expect(backgrounds).toHaveLength(
      (html.match(/style="[^"]*background-color[^"]*"/g) ?? []).length,
    );
  });

  it('lets blockquotes and table cells inherit the destination colors', () => {
    expect(markdownToHtml('> quoted')).toContain(
      '<blockquote style="margin:0 0 16px;padding:0 1em;border-left:4px solid #d0d7de;">',
    );
    expect(markdownToHtml('| a |\n| --- |\n| b |')).toContain(
      '<td style="border:1px solid #d0d7de;padding:6px 13px;">b</td>',
    );
  });
});
