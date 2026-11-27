import { cell, cite, docx, grid, lines, paragraph, row, table } from './docx.helper';
import { docxToText, htmlToText } from './docx';

const text = async (body: string, notes?: string): Promise<string> =>
  docxToText(await docx(body, notes));

describe('docxToText', () => {
  it('keeps paragraphs as mammoth raw text does, each ending in a blank line', async () => {
    expect(await text(paragraph('First.') + paragraph('Second.'))).toBe('First.\n\nSecond.\n\n');
  });

  it('does not add a blank line for an empty paragraph', async () => {
    const body = paragraph('One.') + paragraph('') + paragraph('Two.');

    expect(await text(body)).toBe('One.\n\nTwo.\n\n');
  });

  it('renders a table as CSV rows between the paragraphs around it', async () => {
    const body =
      paragraph('Intro paragraph.') +
      grid(['Region', 'Product', 'Units'], ['EU', 'Cable', '12'], ['US', 'Hub', '7']) +
      paragraph('Closing paragraph.');

    expect(await text(body)).toBe(
      'Intro paragraph.\n\nRegion,Product,Units\nEU,Cable,12\nUS,Hub,7\n\nClosing paragraph.\n\n',
    );
  });

  it('renders a header row like any other row', async () => {
    const header = row(
      '<w:trPr><w:tblHeader/></w:trPr>' + cell(paragraph('Region')) + cell(paragraph('Units')),
    );
    const body = table(header, row(cell(paragraph('EU')), cell(paragraph('12'))));

    expect(await text(body)).toBe('Region,Units\nEU,12\n\n');
  });

  it('quotes cells holding a comma, a quote mark or a line break', async () => {
    const body = grid(['Name', 'Note'], ['Ann, "AJ" Lee', 'plain']);

    expect(await text(body)).toBe('Name,Note\n"Ann, ""AJ"" Lee",plain\n\n');
  });

  it('keeps a cell with several paragraphs or a soft break in one quoted field', async () => {
    const body = table(
      row(cell(paragraph('Name')), cell(paragraph('Notes'))),
      row(
        cell(paragraph('Ann')),
        cell(paragraph('first') + lines('line a', 'line b') + paragraph('last')),
      ),
    );

    expect(await text(body)).toBe('Name,Notes\nAnn,"first\nline a\nline b\nlast"\n\n');
  });

  it('keeps a merged cell in its columns', async () => {
    const body = table(
      row(
        cell(paragraph('Region'), '<w:vMerge w:val="restart"/>'),
        cell(paragraph('Sales'), '<w:gridSpan w:val="2"/>'),
      ),
      row(cell(paragraph(''), '<w:vMerge/>'), cell(paragraph('Q1')), cell(paragraph('Q2'))),
      row(cell(paragraph('EU')), cell(paragraph('10')), cell(paragraph('20'))),
    );

    expect(await text(body)).toBe('Region,Sales\n,Q1,Q2\nEU,10,20\n\n');
  });

  it('pads a row past a cell merged across columns', async () => {
    const body = table(
      row(cell(paragraph('Total'), '<w:gridSpan w:val="2"/>'), cell(paragraph('30'))),
      row(cell(paragraph('a')), cell(paragraph('b')), cell(paragraph('c'))),
    );

    expect(await text(body)).toBe('Total,,30\na,b,c\n\n');
  });

  it('lets a cell merged down cover several rows and then end', async () => {
    const body = table(
      row(cell(paragraph('A'), '<w:vMerge w:val="restart"/>'), cell(paragraph('1'))),
      row(cell(paragraph(''), '<w:vMerge/>'), cell(paragraph('2'))),
      row(cell(paragraph('B')), cell(paragraph('3'))),
    );

    expect(await text(body)).toBe('A,1\n,2\nB,3\n\n');
  });

  it('skips rows with nothing in them', async () => {
    const body = grid(['a', 'b'], ['', ' '], ['c', 'd']);

    expect(await text(body)).toBe('a,b\nc,d\n\n');
  });

  it('renders a table of empty cells as nothing', async () => {
    expect(await text(paragraph('Before.') + grid(['', ''], ['', '']))).toBe('Before.\n\n');
  });

  it('keeps the paragraphs of a one-column table, as a box or a layout holds them', async () => {
    const body = table(row(cell(paragraph('Note: this, that') + paragraph('A "quoted" line.'))));

    expect(await text(paragraph('Before.') + body + paragraph('After.'))).toBe(
      'Before.\n\nNote: this, that\n\nA "quoted" line.\n\nAfter.\n\n',
    );
  });

  it('renders a table nested in a cell as CSV inside that cell', async () => {
    const inner = grid(['x', 'y'], ['z', 'w']);
    const body = table(
      row(cell(paragraph('Name')), cell(paragraph('Detail'))),
      row(cell(paragraph('Ann')), cell(paragraph('see') + inner)),
    );

    expect(await text(body)).toBe('Name,Detail\nAnn,"see\nx,y\nz,w"\n\n');
  });

  it('keeps the text of tables nested deeper than it renders as tables', async () => {
    let body = paragraph('deep, text');
    for (let depth = 0; depth < 12; depth++) {
      body = table(row(cell(body), cell(paragraph(`c${depth}`))));
    }

    const output = await text(body);

    expect(output).toContain('deep, text');
    // Quoted at every level, the innermost row would pass 8,000 characters.
    expect(output.length).toBeLessThan(500);
  });

  it('does not let a wide merge write a long run of empty fields', async () => {
    const body = table(
      row(cell(paragraph('a'), '<w:gridSpan w:val="1000000"/>'), cell(paragraph('b'))),
    );

    const output = await text(body);

    expect(output.length).toBeLessThan(200);
    expect(output.startsWith('a,')).toBe(true);
    expect(output.trimEnd().endsWith(',b')).toBe(true);
  });

  it('breaks a line where the document does', async () => {
    expect(await text(lines('one', 'two'))).toBe('one\ntwo\n\n');
  });

  it('decodes the characters mammoth escapes exactly once', async () => {
    const body = paragraph('AT&T <b> &lt; "q"') + grid(['a&b', '<i>'], ['&amp;', '"x"']);

    expect(await text(body)).toBe('AT&T <b> &lt; "q"\n\na&b,<i>\n&amp;,"""x"""\n\n');
  });

  it.each(['p => !', 'p => div'])(
    'reads the same text when the document embeds the style map %s',
    async (styleMap) => {
      const { embedStyleMap } = await import('mammoth');
      const buffer = await docx(paragraph('One.') + paragraph('Two.') + grid(['a', 'b']));
      const embedded = await embedStyleMap({ buffer }, styleMap);

      expect(await docxToText(embedded.toBuffer())).toBe('One.\n\nTwo.\n\na,b\n\n');
    },
  );

  it('keeps non-ASCII text in its cells', async () => {
    const body = grid(['Größe', '価格'], ['é', '€5, ok']);

    expect(await text(body)).toBe('Größe,価格\né,"€5, ok"\n\n');
  });

  it('keeps footnotes, after the text that cites them', async () => {
    const output = await text(cite('Claim'), 'Footnote text');

    expect(output.startsWith('Claim')).toBe(true);
    expect(output.indexOf('Footnote text')).toBeGreaterThan(output.indexOf('Claim'));
  });
});

describe('htmlToText', () => {
  it('reads tables without rows or cells it never closed', () => {
    expect(htmlToText('<p>a</p><table><tr><td><p>b</p></td><td><p>c</p>')).toBe('a\n\nb,c\n\n');
  });

  it('ignores a closing tag with nothing open', () => {
    expect(htmlToText('</td></tr></table><p>a</p>')).toBe('a\n\n');
  });

  it('does not revisit columns an early merge covered on every row after it', () => {
    const wide = '<td colspan="64" rowspan="2"><p>x</p></td>'.repeat(250);
    const rows = '<tr><td><p>a</p></td><td><p>b</p></td></tr>'.repeat(6000);
    const html = `<table><tr>${wide}</tr><tr></tr>${rows}</table>`;
    const start = Date.now();

    const output = htmlToText(html);

    // Walking all 16,000 columns again on each of the 6,000 rows takes many seconds.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(output.endsWith('\na,b\n\n')).toBe(true);
  });
});
