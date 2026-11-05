import { utils } from 'xlsx';
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
        workbookToText(workbook({ '!ref': ref, A1: { t: 's', v: 'small' } }), utils),
      ).toThrow(SpreadsheetLimitError);
      expect(csv).not.toHaveBeenCalled();
    },
  );

  it('counts traversal across sheets, including empty rectangular space', () => {
    const sheet: WorkSheet = { '!ref': 'A1:GR700', A1: { t: 's', v: 'small' } };
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    expect(() =>
      workbookToText({ SheetNames: ['a', 'b'], Sheets: { a: sheet, b: sheet } }, utils),
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
      ),
    ).toThrow(SpreadsheetLimitError);
  });

  it('rejects repeated shared strings before constructing amplified CSV', () => {
    const shared = 'x'.repeat(8192);
    const sheet = utils.aoa_to_sheet(Array.from({ length: 1024 }, () => [shared]));
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    const format = jest.spyOn(utils, 'format_cell');
    expect(() => workbookToText(workbook(sheet), utils)).toThrow(SpreadsheetLimitError);
    expect(csv).not.toHaveBeenCalled();
    expect(format.mock.calls.length).toBeLessThan(1024);
  });

  it.each(['😀', '"', '\n', ','])('accounts for UTF-8 and CSV escaping of %j', (character) => {
    const value = character.repeat(8192);
    const sheet = utils.aoa_to_sheet(Array.from({ length: 1024 }, () => [value]));
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    expect(() => workbookToText(workbook(sheet), utils)).toThrow(SpreadsheetLimitError);
    expect(csv).not.toHaveBeenCalled();
  });

  it('bounds uncached formulas and total text across sheets', () => {
    const formula = 'x'.repeat(8192);
    const sheet: WorkSheet = { '!ref': 'A1:A300' };
    for (let row = 1; row <= 300; row++) sheet[`A${row}`] = { t: 'n', f: formula };
    const csv = jest.spyOn(utils, 'sheet_to_csv');
    expect(() =>
      workbookToText({ SheetNames: ['a', 'b'], Sheets: { a: sheet, b: sheet } }, utils),
    ).toThrow(SpreadsheetLimitError);
    expect(csv).not.toHaveBeenCalled();
  });

  it('preserves SheetJS CSV formatting, blank rows, names, and empty sheets', () => {
    const sheet = utils.aoa_to_sheet([
      ['ID', 'comma,quote"', 'a\nb', 'é😀'],
      [],
      [42, true, { t: 'n', v: 0.25, z: '0%' }, { t: 'n', f: 'SUM(A1,A2)' }],
    ]);
    const expected = `Data:\n${utils.sheet_to_csv(structuredClone(sheet))}\nEmpty:\n\n`;
    expect(
      workbookToText({ SheetNames: ['Data', 'Empty'], Sheets: { Data: sheet, Empty: {} } }, utils),
    ).toBe(expected);
  });
});
