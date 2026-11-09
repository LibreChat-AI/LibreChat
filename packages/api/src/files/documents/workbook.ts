import type { WorkBook, CellObject, NumberFormat, utils } from 'xlsx';

// Fixed security ceilings, not throughput tuning: every admitted job must remain bounded.
export const SPREADSHEET_LIMITS: Readonly<{
  inputBytes: number;
  outputBytes: number;
  cells: number;
  sheets: number;
  heapMb: number;
}> = {
  inputBytes: 15 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  cells: 250_000,
  sheets: 100,
  heapMb: 128,
};

export class SpreadsheetLimitError extends Error {
  readonly code = 'SPREADSHEET_LIMIT';
  readonly userErrorStatusCode = 413;
  constructor() {
    super('Spreadsheet exceeds the safe processing limits.');
    this.name = 'SpreadsheetLimitError';
  }
}

/** Validate total traversal and expanded text before SheetJS allocates CSV rows. */
export function workbookToText(
  workbook: WorkBook,
  sheetUtils: typeof utils,
  formatNumber: (format: NumberFormat, value: number, options: { date1904: boolean }) => string,
): string {
  if (workbook.SheetNames.length > SPREADSHEET_LIMITS.sheets) {
    throw new SpreadsheetLimitError();
  }
  const formatting = { date1904: workbook.Workbook?.WBProps?.date1904 === true };
  let remainingCells: number = SPREADSHEET_LIMITS.cells;
  let remainingBytes: number = SPREADSHEET_LIMITS.outputBytes;
  const reserve = (bytes: number): void => {
    remainingBytes -= bytes;
    if (remainingBytes < 0) throw new SpreadsheetLimitError();
  };

  for (const name of workbook.SheetNames) {
    reserve(Buffer.byteLength(name, 'utf8') + 3);
    const sheet = workbook.Sheets[name];
    if (!sheet?.['!ref']) continue;
    const range = sheetUtils.decode_range(sheet['!ref']);
    const coordinates = [range.s.r, range.s.c, range.e.r, range.e.c];
    if (
      coordinates.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      range.e.r < range.s.r ||
      range.e.c < range.s.c ||
      range.e.r >= 1_048_576 ||
      range.e.c >= 16_384
    ) {
      throw new SpreadsheetLimitError();
    }
    const width = range.e.c - range.s.c + 1;
    const height = range.e.r - range.s.r + 1;
    const cells = width * height;
    remainingCells -= cells;
    if (remainingCells < 0) throw new SpreadsheetLimitError();
    // Includes delimiters and empty rows, which blankrows:false still has to traverse.
    reserve(cells);
    for (let row = range.s.r; row <= range.e.r; row++) {
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cell: CellObject | undefined = sheet[sheetUtils.encode_cell({ r: row, c: col })];
        if (!cell) continue;
        const raw = cell.v == null && cell.f != null && !cell.F ? '=' + cell.f : cell.v;
        // Reject shared-string amplification before formatting or copying each reference.
        if (typeof raw === 'string' && raw.length > remainingBytes) {
          throw new SpreadsheetLimitError();
        }
        let formatted = '';
        if (cell.v != null) {
          // format_cell ignores the workbook epoch; SSF honors it for numeric dates.
          if (
            formatting.date1904 &&
            cell.t === 'n' &&
            typeof cell.v === 'number' &&
            cell.z != null &&
            cell.w === undefined
          ) {
            try {
              cell.w = formatNumber(cell.z, cell.v, formatting);
            } catch {
              // Retain format_cell's fallback for malformed number formats.
            }
          }
          formatted = sheetUtils.format_cell(cell);
          cell.w = formatted;
        } else if (cell.f != null && !cell.F) {
          formatted = '=' + cell.f;
        }
        // CSV can double every quote and add surrounding quotes. UTF-8, not UTF-16.
        reserve(2 * Buffer.byteLength(formatted, 'utf8') + 2);
      }
    }
  }

  return workbook.SheetNames.map(
    (name) => `${name}:\n${sheetUtils.sheet_to_csv(workbook.Sheets[name])}\n`,
  ).join('');
}
