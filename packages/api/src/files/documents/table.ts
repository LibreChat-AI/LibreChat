/*
 * Safety limits, not tuning knobs: both stop a hostile file from turning a few bytes of XML into
 * a long output. Word tops out at 63 columns, so a wider merge only adds empty fields to a row,
 * and a cell repeated across more columns only adds copies. Each level of nested table quotes the
 * level below it again, which doubles every quote mark, so deeper tables are read as plain
 * paragraphs of the cell around them.
 */
export const MAX_COLSPAN = 64;
export const MAX_DEPTH = 3;

/** The columns and rows a cell covers. */
export interface Span {
  cols: number;
  rows: number;
}

export interface Table<Cell extends Span> {
  /** Finished rows: each cell sits in the column it starts in, and any other column is `undefined`. */
  rows: Array<Array<Cell | undefined>>;
  /** Cells of the row being read. */
  cells: Cell[];
  /** How many more rows a cell merged down from above covers, for each column it still covers. */
  covered: Map<number, number>;
}

/** The whole number the first group of `pattern` finds in a tag's attributes, at least 1. */
export const count = (attributes: string, pattern: RegExp): number =>
  Math.max(1, Number(pattern.exec(attributes)?.[1] ?? 1));

export const createTable = <Cell extends Span>(): Table<Cell> => ({
  rows: [],
  cells: [],
  covered: new Map(),
});

/**
 * Ends the row being read: places each cell in its column, leaving a gap under a cell merged down
 * from an earlier row.
 */
export function addRow<Cell extends Span>(table: Table<Cell>): void {
  const fields: Array<Cell | undefined> = [];
  let col = 0;
  for (const cell of table.cells) {
    while (table.covered.has(col)) {
      col++;
    }
    fields[col] = cell;
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
}

/** How many columns the widest row reaches. */
export const width = <Cell extends Span>(table: Table<Cell>): number =>
  table.rows.reduce((most, fields) => Math.max(most, fields.length), 0);

const quote = (text: string): string =>
  /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

/**
 * The rows as CSV, as `sheet_to_csv` writes a sheet: a field is the text of the cell that starts
 * in its column, quoted when it holds a comma, a quote mark or a line break, and a row with no
 * text is left out. Empty when no row has any text.
 */
export function toCsv<Cell extends Span>(table: Table<Cell>, text: (cell: Cell) => string): string {
  const csv: string[] = [];
  for (const fields of table.rows) {
    const texts = Array.from(fields, (cell) => (cell ? text(cell) : ''));
    if (texts.some((field) => field !== '')) {
      csv.push(texts.map(quote).join(','));
    }
  }
  return csv.join('\n');
}
