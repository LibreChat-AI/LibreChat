import type { Span, Table } from './table';
import { MAX_COLSPAN, MAX_DEPTH, createTable, addRow, count, toCsv, width } from './table';

/**
 * Characters that copies of repeated cells may add to one document. A repeat stands for identical
 * cells, so without a bound a few bytes of XML could multiply a long cell many times over.
 */
const MAX_COPIED = 1_000_000;

/**
 * Table structure tags; LibreOffice writes a table inside a shape's text box under `loext:`.
 * Comments, CDATA sections and processing instructions are matched only so that a tag written
 * inside one is left as text.
 */
const TAG =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(\/?)(?:table|loext):([\w-]+)([^>]*?)(\/?)>/g;
const REPEATED = /table:number-columns-repeated=["'](\d+)/;

/** The text of the document body, or of one table cell, read so far. */
interface Scope extends Span {
  text: string;
  /** Tables open around it, its own included. */
  depth: number;
  /** How many columns of its row the cell fills, each with a copy of it. */
  repeat: number;
  /** A position under a merge, whose text LibreOffice drops, as mammoth does for a .docx. */
  covered: boolean;
}

/**
 * Every cell fills one column. A merge's span is not read: the positions it hides, in its own
 * row and in the rows below, are covered cells of their own, so a declared span costs nothing.
 */
const scope = (depth: number, attributes = '', covered = false): Scope => ({
  text: '',
  depth,
  cols: 1,
  rows: 1,
  repeat: Math.min(count(attributes, REPEATED), MAX_COLSPAN),
  covered,
});

/**
 * Ends paragraphs, headings and line breaks with a newline, turns tab and spacing elements into a
 * tab and a space, strips every other tag but keeps its text, and decodes the five standard XML
 * entities.
 */
const inline = (xml: string): string =>
  xml
    .replace(/<\/text:p>/g, '\n')
    .replace(/<\/text:h>/g, '\n')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:s[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

/** Collapses spaces and tabs, drops them at line ends and keeps at most one blank line. */
const normalize = (text: string): string =>
  text
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * Extracts the body text of an .odt's content.xml, one line per paragraph or heading. A table
 * becomes CSV rows set off by a blank line, as a .docx table does, so every cell stays with its
 * row and its column; a one-column table is a box or a layout, so its text reads as if it stood
 * outside the table.
 *
 * content.xml writes out every position of a table: LibreOffice follows a merged cell with a
 * covered cell for each position it hides, in its row and in the rows below. So a merged cell keeps
 * its column and the positions it covers stay empty, dropping any text a covered cell holds, as
 * LibreOffice does. A repeated cell fills as many columns as it repeats, and a row marked as
 * repeated is read once, as LibreOffice Writer reads it.
 */
export function contentToText(xml: string): string {
  const body = xml.match(/<office:body[^>]*>([\s\S]*?)<\/office:body>/)?.[1];
  if (body == null) {
    return '';
  }

  const root = scope(0);
  const scopes: Scope[] = [root];
  const tables: Array<Table<Scope>> = [];
  /** Tables open inside `MAX_DEPTH` others, read as plain text of the cell around them. */
  let flat = 0;
  let budget = MAX_COPIED;

  /** Whether the innermost scope is a cell of the innermost table. */
  const inCell = (): boolean =>
    scopes.length > 1 && scopes[scopes.length - 1].depth === tables.length;

  const append = (xml: string): void => {
    const current = scopes[scopes.length - 1];
    // Between a table's rows and cells there is only layout whitespace or a title, not content.
    if (xml !== '' && current.depth === tables.length) {
      current.text += inline(xml);
    }
  };

  const endCell = (): void => {
    const cell = scopes.pop();
    const table = tables[tables.length - 1];
    if (!cell || !table) {
      return;
    }
    if (cell.covered) {
      cell.text = '';
    }
    table.cells.push(cell);
    // A copy costs its text and a comma; once the budget is spent, a repeat fills one column.
    const cost = cell.text.length + 1;
    const copies = Math.min(cell.repeat - 1, Math.floor(budget / cost));
    budget -= copies * cost;
    for (let i = 0; i < copies; i++) {
      table.cells.push(cell);
    }
  };

  const render = (table: Table<Scope>): string => {
    // A position under a merge ends no row, as in a .docx, so a box of merged rows is one column.
    for (const fields of table.rows) {
      while (fields.length > 0 && fields[fields.length - 1]?.covered !== false) {
        fields.pop();
      }
    }
    if (width(table) < 2) {
      return table.rows.map((fields) => fields[0]?.text ?? '').join('');
    }
    const csv = toCsv(table, (cell) => normalize(cell.text).replace(/\n+/g, '\n'));
    return csv === '' ? '' : `\n\n${csv}\n\n`;
  };

  const endTable = (): void => {
    if (inCell()) {
      endCell();
    }
    const table = tables.pop();
    if (!table) {
      return;
    }
    if (table.cells.length > 0) {
      addRow(table);
    }
    scopes[scopes.length - 1].text += render(table);
  };

  const open = (name: string, attributes: string): void => {
    if (name === 'table') {
      if (flat > 0 || tables.length >= MAX_DEPTH) {
        flat++;
      } else {
        tables.push(createTable());
      }
    } else if (
      flat === 0 &&
      tables.length > 0 &&
      (name === 'table-cell' || name === 'covered-table-cell')
    ) {
      if (inCell()) {
        endCell();
      }
      scopes.push(scope(tables.length, attributes, name === 'covered-table-cell'));
    }
  };

  const close = (name: string): void => {
    if (name === 'table') {
      if (flat > 0) {
        flat--;
      } else {
        endTable();
      }
    } else if (flat > 0 || tables.length === 0) {
      return;
    } else if (name === 'table-row') {
      if (inCell()) {
        endCell();
      }
      addRow(tables[tables.length - 1]);
    } else if ((name === 'table-cell' || name === 'covered-table-cell') && inCell()) {
      endCell();
    }
  };

  let last = 0;
  for (const match of body.matchAll(TAG)) {
    const [tag, closing, name, attributes, empty] = match;
    if (name === undefined) {
      continue;
    }
    append(body.slice(last, match.index));
    last = match.index + tag.length;
    if (closing) {
      close(name);
    } else {
      open(name, attributes);
      if (empty) {
        close(name);
      }
    }
  }
  append(body.slice(last));
  while (tables.length > 0) {
    endTable();
  }
  return normalize(root.text);
}
