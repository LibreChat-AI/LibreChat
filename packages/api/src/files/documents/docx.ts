import type { Table } from './table';
import { MAX_COLSPAN, MAX_DEPTH, createTable, addRow, count, toCsv, width } from './table';

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

const scope = (cols = 1, rows = 1): Scope => ({ paragraphs: [], line: '', cols, rows });

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
  const tables: Array<Table<Scope>> = [];
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

  const endRow = (): void => {
    const table = tables[tables.length - 1];
    if (table) {
      addRow(table);
    }
  };

  const endTable = (): void => {
    const table = tables.pop();
    if (!table) {
      return;
    }
    const parent = scopes[scopes.length - 1];
    if (width(table) < 2) {
      // One column is a box or a layout, not data: keep its paragraphs as they were.
      for (const fields of table.rows) {
        for (const paragraph of fields[0]?.paragraphs ?? []) {
          parent.paragraphs.push(paragraph);
        }
      }
      return;
    }
    const csv = toCsv(table, (cell) => cell.paragraphs.join('\n').trim());
    if (csv !== '') {
      parent.paragraphs.push(csv);
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
        tables.push(createTable());
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
