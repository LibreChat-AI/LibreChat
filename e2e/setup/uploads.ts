import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';

/**
 * Upload fixtures for the automatic reading policy (automatic-upload.spec.ts). The mock lane's
 * global setup writes them from the rows below; the totals a spec asserts are stated on their own
 * and checked against those rows when the fixtures are written, so an edit to either fails there.
 */
export const UPLOAD_FIXTURE_DIR = path.resolve(__dirname, '../.generated/uploads');

/** Sits alone in `Notes!A1`, so it reaches the model only through extracted text. */
export const WORKBOOK_SENTINEL = 'SENTINEL-7F3A';

export type SheetRow = readonly [item: string, amount: number];

/** Six-digit amounts, so none can be mistaken for an id, a port or a timestamp fragment. */
export const Q1_ROWS: readonly SheetRow[] = [
  ['North', 731842],
  ['South', 905317],
  ['East', 648259],
  ['West', 517093],
];

export const Q2_ROWS: readonly SheetRow[] = [
  ['North', 812406],
  ['South', 693178],
  ['East', 574921],
  ['West', 786350],
];

/** Column-B totals the fake code server computes from the uploaded bytes, as known values. */
export const WORKBOOK_TOTALS = {
  Q1: 2_802_511,
  Q2: 2_866_855,
  Notes: 0,
} as const;

const sumAmounts = (rows: readonly SheetRow[]): number =>
  rows.reduce((total, [, amount]) => total + amount, 0);

function assertKnownTotals(): void {
  const computed = { Q1: sumAmounts(Q1_ROWS), Q2: sumAmounts(Q2_ROWS) };
  if (computed.Q1 !== WORKBOOK_TOTALS.Q1 || computed.Q2 !== WORKBOOK_TOTALS.Q2) {
    throw new Error(
      `Fixture rows sum to ${JSON.stringify(computed)}, not the known totals ${JSON.stringify(
        WORKBOOK_TOTALS,
      )}`,
    );
  }
}

export type UploadFixture = { name: string; mimeType: string; path: string };

const fixture = (name: string, mimeType: string): UploadFixture => ({
  name,
  mimeType,
  path: path.join(UPLOAD_FIXTURE_DIR, name),
});

export const UPLOAD_FIXTURES = {
  xlsx: fixture(
    'quarterly.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ),
  csv: fixture('q1.csv', 'text/csv'),
  smallPdf: fixture('small.pdf', 'application/pdf'),
  largePdf: fixture('large.pdf', 'application/pdf'),
} as const;

const SHEET_HEADER = ['item', 'amount'];
const SMALL_PDF_BYTES = 50 * 1024;
const LARGE_PDF_BYTES = 3 * 1024 * 1024;

const sheetRows = (rows: readonly SheetRow[]): (string | number)[][] => [
  SHEET_HEADER,
  ...rows.map(([item, amount]) => [item, amount]),
];

function buildWorkbook(): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows(Q1_ROWS)), 'Q1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows(Q2_ROWS)), 'Q2');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([[WORKBOOK_SENTINEL]]), 'Notes');
  return workbook;
}

const writeWorkbook = (workbook: XLSX.WorkBook, bookType: XLSX.BookType): Buffer =>
  XLSX.write(workbook, { type: 'buffer', bookType }) as Buffer;

const delimited = (rows: readonly SheetRow[], separator: string): string =>
  `${sheetRows(rows)
    .map((cells) => cells.join(separator))
    .join('\n')}\n`;

/** Deterministic filler bytes for the PDF padding stream. */
function fillerBytes(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let state = 0x2545f491;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

const ascii = (value: string): Buffer => Buffer.from(value, 'latin1');

const streamBody = (data: Buffer): Buffer =>
  Buffer.concat([ascii(`<< /Length ${data.length} >>\nstream\n`), data, ascii('\nendstream')]);

/** A one-page PDF with a correct cross-reference table; the extra stream sets its size. */
function assemblePdf(title: string, padding: Buffer): Buffer {
  const header = ascii('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const bodies = [
    ascii('<< /Type /Catalog /Pages 2 0 R >>'),
    ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    ascii(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    streamBody(ascii(`BT /F1 18 Tf 72 720 Td (${title}) Tj ET`)),
    ascii('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    streamBody(padding),
  ];
  const objects = bodies.map((body, index) =>
    Buffer.concat([ascii(`${index + 1} 0 obj\n`), body, ascii('\nendobj\n')]),
  );
  let cursor = header.length;
  const offsets = objects.map((object) => {
    const offset = cursor;
    cursor += object.length;
    return offset;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(cursor),
    '%%EOF',
    '',
  ].join('\n');
  return Buffer.concat([header, ...objects, ascii(xref)]);
}

function buildPdf(title: string, targetBytes: number): Buffer {
  const baseLength = assemblePdf(title, Buffer.alloc(0)).length;
  return assemblePdf(title, fillerBytes(Math.max(0, targetBytes - baseLength)));
}

/** Writes every upload fixture under `e2e/.generated/uploads/`, replacing earlier copies. */
export function writeUploadFixtures(): void {
  assertKnownTotals();
  fs.mkdirSync(UPLOAD_FIXTURE_DIR, { recursive: true });
  const workbook = buildWorkbook();
  const contents: ReadonlyArray<readonly [UploadFixture, Buffer]> = [
    [UPLOAD_FIXTURES.xlsx, writeWorkbook(workbook, 'xlsx')],
    [UPLOAD_FIXTURES.csv, Buffer.from(delimited(Q1_ROWS, ','), 'utf8')],
    [UPLOAD_FIXTURES.smallPdf, buildPdf('E2E small PDF', SMALL_PDF_BYTES)],
    [UPLOAD_FIXTURES.largePdf, buildPdf('E2E large PDF', LARGE_PDF_BYTES)],
  ];
  contents.forEach(([{ path: filePath }, content]) => fs.writeFileSync(filePath, content));
}
