import { cell, content, covered, grid, lines, paragraph, row, table } from './odt.helper';
import { contentToText } from './odt';

const text = (body: string): string => contentToText(content(body));

const frame = (inner: string): string =>
  `<text:p>Caption<draw:frame draw:name="Frame1"><draw:text-box>${inner}</draw:text-box></draw:frame></text:p>`;

describe('contentToText', () => {
  it('keeps each paragraph and heading on its own line, as before', () => {
    const body =
      '<text:h text:outline-level="1">Title</text:h>' +
      paragraph('First.') +
      paragraph('') +
      paragraph('Second.');

    expect(text(body)).toBe('Title\nFirst.\nSecond.');
  });

  it('renders a table as CSV rows set off from the paragraphs around it', () => {
    const body =
      paragraph('Intro paragraph.') +
      grid(['Region', 'Product', 'Units'], ['EU', 'Cable', '12'], ['US', 'Hub', '7']) +
      paragraph('Closing paragraph.');

    expect(text(body)).toBe(
      'Intro paragraph.\n\nRegion,Product,Units\nEU,Cable,12\nUS,Hub,7\n\nClosing paragraph.',
    );
  });

  it('renders header rows like any other row', () => {
    const header = `<table:table-header-rows>${row(cell(paragraph('Region')), cell(paragraph('Units')))}</table:table-header-rows>`;

    expect(text(table(header, row(cell(paragraph('EU')), cell(paragraph('12')))))).toBe(
      'Region,Units\nEU,12',
    );
  });

  it('quotes cells holding a comma, a quote mark or a line break', () => {
    const body = grid(['Name', 'Note'], ['Ann, "AJ" Lee', 'plain']);

    expect(text(body)).toBe('Name,Note\n"Ann, ""AJ"" Lee",plain');
  });

  it('keeps a cell with several paragraphs or a line break in one quoted field', () => {
    const body = table(
      row(cell(paragraph('Name')), cell(paragraph('Notes'))),
      row(
        cell(paragraph('Ann')),
        cell(paragraph('first') + lines('line a', 'line b') + paragraph('last')),
      ),
    );

    expect(text(body)).toBe('Name,Notes\nAnn,"first\nline a\nline b\nlast"');
  });

  it('keeps a merged cell in its column and leaves the positions it covers empty', () => {
    const body = table(
      row(
        cell(paragraph('Region'), 'table:number-rows-spanned="2"'),
        cell(paragraph('Sales'), 'table:number-columns-spanned="2"'),
        covered(),
      ),
      row(covered(), cell(paragraph('Q1')), cell(paragraph('Q2'))),
      row(cell(paragraph('EU')), cell(paragraph('10')), cell(paragraph('20'))),
    );

    expect(text(body)).toBe('Region,Sales,\n,Q1,Q2\nEU,10,20');
  });

  it('pads a row past a cell merged across columns', () => {
    const body = table(
      row(
        cell(paragraph('Total'), 'table:number-columns-spanned="2"'),
        covered(),
        cell(paragraph('30')),
      ),
      row(cell(paragraph('a')), cell(paragraph('b')), cell(paragraph('c'))),
    );

    expect(text(body)).toBe('Total,,30\na,b,c');
  });

  it('drops the text of a cell a merge covers, as LibreOffice does', () => {
    const body = table(
      row(
        cell(paragraph('A'), 'table:number-columns-spanned="2"'),
        covered(paragraph('hidden')),
        cell(paragraph('B')),
      ),
    );

    expect(text(body)).toBe('A,,B');
  });

  it('fills the columns of a repeated cell with copies of it', () => {
    const body = table(
      row(cell(paragraph('Item')), cell(paragraph('0'), 'table:number-columns-repeated="3"')),
      row(cell(paragraph('a')), cell(paragraph('1')), cell(paragraph('2')), cell(paragraph('3'))),
    );

    expect(text(body)).toBe('Item,0,0,0\na,1,2,3');
  });

  it('keeps the columns of repeated empty cells', () => {
    const body = table(
      row(
        cell(paragraph('a')),
        '<table:table-cell table:number-columns-repeated="2"/>',
        cell(paragraph('b')),
      ),
    );

    expect(text(body)).toBe('a,,,b');
  });

  it('reads a row marked as repeated once, as LibreOffice Writer does', () => {
    const repeated = `<table:table-row table:number-rows-repeated="3">${cell(paragraph('x')) + cell(paragraph('y'))}</table:table-row>`;

    expect(text(table(row(cell(paragraph('a')), cell(paragraph('b'))), repeated))).toBe('a,b\nx,y');
  });

  it('skips rows with nothing in them', () => {
    expect(text(grid(['a', 'b'], ['', ' '], ['c', 'd']))).toBe('a,b\nc,d');
  });

  it('renders a table of empty cells as nothing', () => {
    expect(text(paragraph('Before.') + grid(['', ''], ['', '']))).toBe('Before.');
  });

  it('reads a one-column table as if its text stood outside it', () => {
    const box = table(row(cell(paragraph('Note: this, that') + paragraph('A "quoted" line.'))));

    expect(text(paragraph('Before.') + box + paragraph('After.'))).toBe(
      'Before.\nNote: this, that\nA "quoted" line.\nAfter.',
    );
  });

  it('sets off a table held in a one-column table from the text around it', () => {
    const box = table(
      row(cell(paragraph('Header') + grid(['x', 'y'], ['z', 'w']) + paragraph('Footer'))),
    );

    expect(text(paragraph('Before.') + box)).toBe('Before.\nHeader\n\nx,y\nz,w\n\nFooter');
  });

  it('renders a table nested in a cell as CSV inside that cell', () => {
    const inner = grid(['x', 'y'], ['z', 'w']);
    const body = table(
      row(cell(paragraph('Name')), cell(paragraph('Detail'))),
      row(cell(paragraph('Ann')), cell(paragraph('see') + inner)),
    );

    expect(text(body)).toBe('Name,Detail\nAnn,"see\nx,y\nz,w"');
  });

  it('keeps the text of tables nested deeper than it renders as tables', () => {
    let body = paragraph('deep, text');
    for (let depth = 0; depth < 12; depth++) {
      body = table(row(cell(body), cell(paragraph(`c${depth}`))));
    }

    const output = text(body);

    expect(output).toContain('deep, text');
    // Quoted at every level, the innermost row would pass 8,000 characters.
    expect(output.length).toBeLessThan(500);
  });

  it('renders a table in a text frame where the frame stands', () => {
    expect(text(frame(grid(['a', 'b'])) + paragraph('After.'))).toBe('Caption\n\na,b\n\nAfter.');
  });

  it('renders a table LibreOffice writes in a shape under loext', () => {
    const shape =
      '<loext:table table:name="Table2"><loext:table-column table:number-columns-repeated="2"/>' +
      '<loext:table-row><loext:table-cell table:number-columns-spanned="2"><text:p>a</text:p></loext:table-cell>' +
      '<loext:covered-table-cell/><loext:table-cell><text:p>b, c</text:p></loext:table-cell></loext:table-row>' +
      '</loext:table>';

    expect(text(frame(shape))).toBe('Caption\n\na,,"b, c"');
  });

  it('reads indented XML as it reads XML on one line', () => {
    const indented = `
      <table:table table:name="Table1">
        <table:table-column table:number-columns-repeated="2"/>
        <table:table-row>
          <table:table-cell office:value-type="string">
            <text:p>a</text:p>
          </table:table-cell>
          <table:table-cell office:value-type="string">
            <text:p>b</text:p>
          </table:table-cell>
        </table:table-row>
      </table:table>
    `;

    expect(text(paragraph('Intro') + indented + paragraph('End'))).toBe('Intro\n\na,b\n\nEnd');
  });

  it('decodes the characters content.xml escapes exactly once', () => {
    const body = paragraph('AT&T <b>') + grid(['a&b', '<i>'], ['&amp;', '"x"']);

    expect(text(body)).toBe('AT&T <b>\n\na&b,<i>\n&amp;,"""x"""');
  });

  it('keeps non-ASCII text in its cells', () => {
    expect(text(grid(['Größe', '価格'], ['é', '€5, ok']))).toBe('Größe,価格\né,"€5, ok"');
  });

  it('places cells by the covered cells the file writes, so a declared span costs nothing', () => {
    const merged = cell(
      paragraph('a'),
      'table:number-columns-spanned="64" table:number-rows-spanned="1000000000"',
    );
    const below = row(cell(paragraph('x')), cell(paragraph('y')));
    const xml = content(table(row(...Array(200).fill(merged)), ...Array(2_000).fill(below)));
    const start = Date.now();

    const output = contentToText(xml);

    // Read from the spans, every later row would start past 12,800 covered columns.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(output.length).toBeLessThan(xml.length);
    expect(output.endsWith('\nx,y')).toBe(true);
  });

  it('stops a repeated cell at 64 columns', () => {
    const body = table(
      row(cell(paragraph('a')), cell(paragraph('x'), 'table:number-columns-repeated="1000000"')),
    );

    expect(text(body)).toBe(`a,${Array(64).fill('x').join(',')}`);
  });

  it('does not let repeated cells multiply a long cell without bound', () => {
    const long = paragraph('y'.repeat(10_000));
    const repeated = row(cell(paragraph('k')), cell(long, 'table:number-columns-repeated="64"'));
    const xml = content(table(...Array(200).fill(repeated)));

    const output = contentToText(xml);

    // Copied in full, the 200 rows would hold 128 million characters.
    expect(output.length).toBeLessThan(xml.length + 1_100_000);
    expect(output.split('\n')).toHaveLength(200);
  });

  it('does not read a table tag inside a comment as a table', () => {
    const output = text(paragraph('Before.') + '<!-- <table:table> -->' + paragraph('After.'));

    expect(output.startsWith('Before.')).toBe(true);
    expect(output.endsWith('After.')).toBe(true);
  });

  it('reads tables, rows and cells that are never closed', () => {
    const body =
      paragraph('a') +
      '<table:table><table:table-row><table:table-cell><text:p>b</text:p>' +
      '<table:table-cell><text:p>c</text:p>';

    expect(text(body)).toBe('a\n\nb,c');
  });

  it('ignores closing tags with nothing open', () => {
    expect(text('</table:table-cell></table:table-row></table:table>' + paragraph('a'))).toBe('a');
  });

  it('returns nothing for content.xml without a body', () => {
    expect(contentToText('<office:document-content/>')).toBe('');
  });
});
