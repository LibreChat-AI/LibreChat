import { read, write, utils, SSF } from 'xlsx';
import type { WorkBook, WorkSheet } from 'xlsx';
import { workbookToText, SPREADSHEET_LIMITS, SpreadsheetLimitError } from './workbook';

function workbook(sheet: WorkSheet): WorkBook {
  return { SheetNames: ['Sheet1'], Sheets: { Sheet1: sheet } };
}

describe('bounded spreadsheet CSV conversion', () => {
  it.each(['A1:XFD1048576', 'A1:A1048576', 'A1:XFD20', 'A1:XFE1', 'A1:A0'])(
    'rejects oversized or invalid dimensions %s before CSV generation',
    (ref) => {
      const csv = jest.spyOn(utils, 'sheet_to_csv');
      expect(() =>
        workbookToText(workbook({ '!ref': ref, A1: { t: 's', v: 'small' } }), utils, SSF.format),
      ).toThrow(SpreadsheetLimitError);
      expect(csv).not.toHaveBeenCalled();
    },
  );

  it('counts traversal across sheets, including empty rectangular space', () => {
    const sheet: WorkSheet = { '!ref': 'A1:GR700', A1: { t: 's', v: 'small' } };
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    expect(() =>
      workbookToText({ SheetNames: ['a', 'b'], Sheets: { a: sheet, b: sheet } }, utils, SSF.format),
    ).toThrow(SpreadsheetLimitError);
    expect(csv).not.toHaveBeenCalled();
  });

  it('bounds sheet count even when sheets contain no cells', () => {
    expect(() =>
      workbookToText(
        {
          SheetNames: Array.from({ length: SPREADSHEET_LIMITS.sheets + 1 }, (_, i) => String(i)),
          Sheets: {},
        },
        utils,
        SSF.format,
      ),
    ).toThrow(SpreadsheetLimitError);
  });

  it('rejects repeated shared strings before constructing amplified CSV', () => {
    const shared = 'x'.repeat(8192);
    const sheet = utils.aoa_to_sheet(Array.from({ length: 1024 }, () => [shared]));
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    const format = jest.spyOn(utils, 'format_cell');
    expect(() => workbookToText(workbook(sheet), utils, SSF.format)).toThrow(SpreadsheetLimitError);
    expect(csv).not.toHaveBeenCalled();
    expect(format.mock.calls.length).toBeLessThan(1024);
  });

  it.each(['😀', '"', '\n', ','])('accounts for UTF-8 and CSV escaping of %j', (character) => {
    const value = character.repeat(8192);
    const sheet = utils.aoa_to_sheet(Array.from({ length: 1024 }, () => [value]));
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    expect(() => workbookToText(workbook(sheet), utils, SSF.format)).toThrow(SpreadsheetLimitError);
    expect(csv).not.toHaveBeenCalled();
  });

  it('bounds uncached formulas and total text across sheets', () => {
    const formula = 'x'.repeat(8192);
    const sheet: WorkSheet = { '!ref': 'A1:A300' };
    for (let row = 1; row <= 300; row++) sheet[`A${row}`] = { t: 'n', f: formula };
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    expect(() =>
      workbookToText({ SheetNames: ['a', 'b'], Sheets: { a: sheet, b: sheet } }, utils, SSF.format),
    ).toThrow(SpreadsheetLimitError);
    expect(csv).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves the numeric date epoch, date1904=%s', (date1904) => {
    const book = workbook(
      utils.aoa_to_sheet([
        [
          { t: 'n', v: 1, z: 'yyyy-mm-dd' },
          { t: 'n', v: 1.5, z: 'yyyy-mm-dd hh:mm:ss' },
        ],
        [
          { t: 'n', v: 1.5, z: '[h]:mm' },
          { t: 'n', v: 0.25, z: '0%' },
        ],
        [
          { t: 'n', v: 1234.5, z: '#,##0.00' },
          { t: 'e', v: 7 },
        ],
        [{ t: 'n', v: 1, z: 'yyyy-mm-dd', f: '1+0' }, 'unchanged'],
      ]),
    );
    book.Workbook = { WBProps: { date1904 } };
    const data = write(book, { type: 'buffer', bookType: 'xlsx' });
    const baseline = read(data, { type: 'buffer' });
    const deferred = read(data, { type: 'buffer', cellText: false, cellNF: true, cellHTML: false });
    expect(deferred.Sheets.Sheet1.A1.w).toBeUndefined();
    const text = workbookToText(deferred, utils, SSF.format);
    expect(text).toBe(`Sheet1:\n${utils.sheet_to_csv(baseline.Sheets.Sheet1)}\n`);
    expect(text).toContain(date1904 ? '1904-01-02' : '1900-01-01');
    expect(text).toContain('36:00,25%');
  });

  it('keeps cached formatting and SheetJS fallback behavior for invalid formats', () => {
    const sheet = utils.aoa_to_sheet([
      [
        { t: 'n', v: 1, z: 'yyyy-mm-dd', w: 'cached' },
        { t: 'n', v: 123, z: 'invalid-format' },
      ],
    ]);
    const book = workbook(sheet);
    book.Workbook = { WBProps: { date1904: true } };
    const expected = `Sheet1:\n${utils.sheet_to_csv(structuredClone(sheet))}\n`;
    expect(workbookToText(book, utils, SSF.format)).toBe(expected);
  });

  it('preserves SheetJS CSV formatting, blank rows, names, and empty sheets', () => {
    const sheet = utils.aoa_to_sheet([
      ['ID', 'comma,quote"', 'a\nb', 'é😀'],
      [],
      [42, true, { t: 'n', v: 0.25, z: '0%' }, { t: 'n', f: 'SUM(A1,A2)' }],
    ]);
    const expected = `Data:\n${utils.sheet_to_csv(structuredClone(sheet))}\nEmpty:\n\n`;
    expect(
      workbookToText(
        { SheetNames: ['Data', 'Empty'], Sheets: { Data: sheet, Empty: {} } },
        utils,
        SSF.format,
      ),
    ).toBe(expected);
  });
});
