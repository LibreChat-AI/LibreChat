/*
 * Safety limits, not tuning knobs: both stop a hostile file from turning a few bytes of XML into
 * a long output. Word tops out at 63 columns, so a wider merge only adds empty fields to a row.
 * Each level of nested table quotes the level below it again, which doubles every quote mark, so
 * deeper tables are read as plain paragraphs of the cell around them.
 */
const MAX_COLSPAN = 64;
const MAX_DEPTH = 3;

const COLSPAN = /colspan="(\d+)"/;
const ROWSPAN = /rowspan="(\d+)"/;
const ENTITY = /&(amp|lt|gt|quot);/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };
/** What mammoth makes of one paragraph, and the lists that hold list items. */
const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'ul', 'ol']);

/** The paragraphs of the document body, or of one table cell. */
interface Scope {
  paragraphs: string[];
  /** The paragraph being read. */
  line: string;
  /** Columns and rows a cell covers. */
  cols: number;
  rows: number;
}

interface Table {
  /** Finished rows: a cell is its paragraphs, and a column no cell starts in is `undefined`. */
  rows: Array<Array<string[] | undefined>>;
  /** Cells of the row being read. */
  cells: Scope[];
  /** How many more rows a cell merged down from above covers, for each column it still covers. */
  covered: Map<number, number>;
}

const scope = (cols = 1, rows = 1): Scope => ({ paragraphs: [], line: '', cols, rows });

const count = (attributes: string, pattern: RegExp): number =>
  Math.max(1, Number(pattern.exec(attributes)?.[1] ?? 1));

const quote = (text: string): string =>
  /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

/**
 * Renders the HTML mammoth writes for a .docx as plain text. Each paragraph ends in a blank line,
 * as in mammoth's raw text, and a table becomes CSV rows, as `sheet_to_csv` writes a spreadsheet,
 * so every cell stays with its row and its column.
 *
 * Reads only mammoth's own output. It escapes `<`, `>` and `&` in text and attributes, so a tag
 * cannot be mistaken for text, and `&amp;`, `&lt;`, `&gt;` and `&quot;` are the only entities.
 */
export function htmlToText(html: string): string {
  const body = scope();
  const scopes: Scope[] = [body];
  const tables: Table[] = [];
  /** Tables open inside `MAX_DEPTH` others, whose rows and cells are not told apart. */
  let flat = 0;

  const flush = (): void => {
    const current = scopes[scopes.length - 1];
    if (current.line === '') {
      return;
    }
    current.paragraphs.push(current.line);
    current.line = '';
  };

  const endCell = (): void => {
    flush();
    const cell = scopes.length > 1 ? scopes.pop() : undefined;
    if (cell) {
      tables[tables.length - 1]?.cells.push(cell);
    }
  };

  /** Places each cell in its column, leaving a gap under a cell merged down from an earlier row. */
  const endRow = (): void => {
    const table = tables[tables.length - 1];
    if (!table) {
      return;
    }
    const fields: Array<string[] | undefined> = [];
    let col = 0;
    for (const cell of table.cells) {
      while (table.covered.has(col)) {
        col++;
      }
      fields[col] = cell.paragraphs;
      for (let i = 0; cell.rows > 1 && i < cell.cols; i++) {
        table.covered.set(col + i, cell.rows);
      }
      col += cell.cols;
    }
    // A row costs only the columns still covered, however wide an earlier row was.
    for (const [column, rows] of table.covered) {
      if (rows > 1) {
        table.covered.set(column, rows - 1);
      } else {
        table.covered.delete(column);
      }
    }
    table.rows.push(fields);
    table.cells = [];
  };

  const endTable = (): void => {
    const table = tables.pop();
    if (!table) {
      return;
    }
    const parent = scopes[scopes.length - 1];
    const width = table.rows.reduce((most, fields) => Math.max(most, fields.length), 0);
    if (width < 2) {
      // One column is a box or a layout, not data: keep its paragraphs as they were.
      for (const fields of table.rows) {
        for (const paragraph of fields[0] ?? []) {
          parent.paragraphs.push(paragraph);
        }
      }
      return;
    }
    const csv: string[] = [];
    for (const fields of table.rows) {
      const texts = Array.from(fields, (paragraphs) => (paragraphs ?? []).join('\n').trim());
      if (texts.some((text) => text !== '')) {
        csv.push(texts.map(quote).join(','));
      }
    }
    if (csv.length > 0) {
      parent.paragraphs.push(csv.join('\n'));
    }
  };

  const open = (name: string, attributes: string): void => {
    if (name === 'br') {
      scopes[scopes.length - 1].line += '\n';
    } else if (name === 'table') {
      flush();
      if (flat > 0 || tables.length >= MAX_DEPTH) {
        flat++;
      } else {
        tables.push({ rows: [], cells: [], covered: new Map() });
      }
    } else if (name === 'td' || name === 'th') {
      if (flat === 0 && tables.length > 0) {
        const cols = Math.min(count(attributes, COLSPAN), MAX_COLSPAN);
        scopes.push(scope(cols, count(attributes, ROWSPAN)));
      }
    } else if (BLOCKS.has(name)) {
      flush();
    }
  };

  const close = (name: string): void => {
    if (name === 'td' || name === 'th') {
      if (flat === 0) {
        endCell();
      }
    } else if (name === 'tr') {
      if (flat === 0) {
        endRow();
      }
    } else if (name === 'table') {
      if (flat > 0) {
        flat--;
      } else {
        endTable();
      }
    } else if (BLOCKS.has(name)) {
      flush();
    }
  };

  for (const [, closing, name, attributes, text] of html.matchAll(
    /<(\/?)([a-z][a-z0-9]*)([^>]*)>|([^<]+)/g,
  )) {
    if (text !== undefined) {
      scopes[scopes.length - 1].line += text.includes('&')
        ? text.replace(ENTITY, (_, entity: string) => ENTITIES[entity])
        : text;
    } else if (closing) {
      close(name);
    } else {
      open(name, attributes);
    }
  }

  while (tables.length > 0) {
    endCell();
    endRow();
    endTable();
  }
  flush();
  return body.paragraphs.map((paragraph) => `${paragraph}\n\n`).join('');
}

/** Extracts the text of a .docx with its tables kept as CSV rows. */
export async function docxToText(buffer: Buffer): Promise<string> {
  const { convertToHtml, images } = await import('mammoth');
  /* A style map the document embeds can hide paragraphs or turn them into elements the renderer
   * does not know, so only mammoth's own map applies. Images never reach the text, so skip the
   * base64 pass mammoth makes of each one by default. */
  const { value } = await convertToHtml(
    { buffer },
    {
      includeEmbeddedStyleMap: false,
      convertImage: images.imgElement(async () => ({ src: '' })),
    },
  );
  return htmlToText(value);
}
