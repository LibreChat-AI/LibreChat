import JSZip from 'jszip';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { read, utils, write } from 'xlsx';
import { performance } from 'node:perf_hooks';
import { spreadsheetParsingSchema } from 'librechat-data-provider';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import type { ServerRequest } from '~/types';
import { SpreadsheetBusyError } from '../upload/errors';
import { createSpreadsheetParser } from './spreadsheet';
import { SPREADSHEET_LIMITS } from './workbook';
import { parseDocument } from './crud';

const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('spreadsheet parser regressions', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'spreadsheet-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function parse(buffer: Buffer, name: string): Promise<string> {
    const filePath = path.join(directory, name);
    await writeFile(filePath, buffer);
    return (
      await parseDocument({
        file: {
          path: filePath,
          originalname: name,
          mimetype: mime,
          size: buffer.length,
        } as Express.Multer.File,
      })
    ).text;
  }

  it('rejects a compact shared-string amplification workbook while API timers run', async () => {
    const sheet = utils.aoa_to_sheet(Array.from({ length: 1024 }, () => ['x'.repeat(8192)]));
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, 'Shared');
    const buffer: Buffer = write(workbook, {
      type: 'buffer',
      bookType: 'xlsx',
      bookSST: true,
      compression: true,
    });
    expect(buffer.length).toBeLessThan(100_000);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await expect(parse(buffer, 'shared.xlsx')).rejects.toMatchObject({
        code: 'SPREADSHEET_LIMIT',
        userErrorStatusCode: 413,
      });
      expect(ticks).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });

  it('rejects inflated XML dimensions before CSV traversal', async () => {
    const archive = await JSZip.loadAsync(await readFile(path.join(__dirname, 'sample.xlsx')));
    const entry = archive.file('xl/worksheets/sheet1.xml');
    if (!entry) throw new Error('Missing worksheet fixture');
    archive.file(
      'xl/worksheets/sheet1.xml',
      (await entry.async('string')).replace(
        '<sheetData>',
        '<dimension ref="A1:XFD1048576"/><sheetData>',
      ),
    );
    await expect(
      parse(await archive.generateAsync({ type: 'nodebuffer' }), 'dimension.xlsx'),
    ).rejects.toThrow('safe processing limits');
  });

  it.each(['A1048576', 'XFD104', 'XFD1048576'])(
    'bounds sparse real cell %s, even without a declared dimension',
    async (address) => {
      const archive = await JSZip.loadAsync(await readFile(path.join(__dirname, 'sample.xlsx')));
      const row = address.match(/\d+$/)?.[0];
      archive.file(
        'xl/worksheets/sheet1.xml',
        `<?xml version="1.0"?>
        <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <sheetData>
            <row r="1"><c r="A1" t="inlineStr"><is><t>start</t></is></c></row>
            <row r="${row}"><c r="${address}" t="inlineStr"><is><t>end</t></is></c></row>
          </sheetData>
        </worksheet>`,
      );
      await expect(
        parse(await archive.generateAsync({ type: 'nodebuffer' }), `sparse-${address}.xlsx`),
      ).rejects.toThrow('safe processing limits');
    },
  );

  it('preserves offset ranges, numeric formats, Unicode, and blank rows', async () => {
    const sheet = utils.aoa_to_sheet([]);
    utils.sheet_add_aoa(
      sheet,
      [['ID', 'comma,quote"', 'é😀'], [], [42, true, { t: 'n', v: 0.25, z: '0%' }]],
      { origin: 'B3' },
    );
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, 'Offset');
    const expected = `Offset:\n${utils.sheet_to_csv(sheet)}\n`;
    await expect(
      parse(write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'normal.xlsx'),
    ).resolves.toBe(expected);
  });

  it.each([
    ['xlsx', false, '1900-01-01'],
    ['xlsx', true, '1904-01-02'],
    ['xls', false, '1900-01-01'],
    ['xls', true, '1904-01-02'],
  ] as const)('preserves %s dates with date1904=%s', async (bookType, date1904, expected) => {
    const workbook = utils.book_new();
    workbook.Workbook = { WBProps: { date1904 } };
    utils.book_append_sheet(
      workbook,
      utils.aoa_to_sheet([
        [
          { t: 'n', v: 1, z: 'yyyy-mm-dd' },
          { t: 'n', v: 1.5, z: 'yyyy-mm-dd hh:mm:ss' },
          { t: 'n', v: 1.5, z: '[h]:mm' },
          { t: 'n', v: 0.25, z: '0%' },
        ],
      ]),
      'Dates',
    );
    await expect(
      parse(write(workbook, { type: 'buffer', bookType }), `dates-${date1904}.${bookType}`),
    ).resolves.toBe(`Dates:\n${expected},${expected} 12:00:00,36:00,25%\n`);
  });

  it.each(['ods', 'fods'] as const)(
    'preserves stored %s display text instead of reformatting it',
    async (bookType) => {
      const workbook = utils.book_new();
      utils.book_append_sheet(
        workbook,
        utils.aoa_to_sheet([
          [
            { t: 'n', v: 0.25, z: '0%' },
            { t: 'n', v: 1234.5, z: '#,##0.00' },
          ],
        ]),
        'Display',
      );
      const data: Buffer = write(workbook, { type: 'buffer', bookType });
      const baseline = read(data, { type: 'buffer' });
      // ODS XML stores 0.25 and 1234.5 as its display text despite the number formats.
      expect(baseline.Sheets.Display.A1.w).toBe('0.25');
      const expected = `Display:\n${utils.sheet_to_csv(baseline.Sheets.Display)}\n`;
      expect(expected).toBe('Display:\n0.25,1234.5\n');
      await expect(parse(data, `display.${bookType}`)).resolves.toBe(expected);
    },
  );

  it('preserves UTF-16 flat OpenDocument display text without decoding the input twice', async () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(
      workbook,
      utils.aoa_to_sheet([[{ t: 'n', v: 0.25, z: '0%' }, 'stored']]),
      'Display',
    );
    const xml = write(workbook, { type: 'string', bookType: 'fods' }).replace(
      'encoding="UTF-8"',
      'encoding="UTF-16"',
    );
    const data = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    const baseline = read(data, { type: 'buffer' });
    const expected = `Display:\n${utils.sheet_to_csv(baseline.Sheets.Display)}\n`;
    expect(expected).toBe('Display:\n0.25,stored\n');
    await expect(parse(data, 'display-utf16.ods')).resolves.toBe(expected);
  });

  it('recognizes OpenDocument markers with the same case-insensitive rules as SheetJS', async () => {
    const workbook = utils.book_new();
    utils.book_append_sheet(
      workbook,
      utils.aoa_to_sheet([[{ t: 'n', v: 0.25, z: '0%' }]]),
      'Display',
    );
    const archive = await JSZip.loadAsync(write(workbook, { type: 'buffer', bookType: 'ods' }));
    const manifest = archive.file('META-INF/manifest.xml');
    if (!manifest) throw new Error('Missing generated ODS manifest');
    archive.file('meta-inf/MANIFEST.XML', await manifest.async('string'));
    archive.remove('META-INF/manifest.xml');
    await expect(
      parse(await archive.generateAsync({ type: 'nodebuffer' }), 'display-case.ods'),
    ).resolves.toBe('Display:\n0.25\n');
  });

  it('bounds repeated ODS display text before CSV generation', async () => {
    const archive = await JSZip.loadAsync(await readFile(path.join(__dirname, 'sample.ods')));
    archive.file(
      'content.xml',
      `<?xml version="1.0"?>
      <office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
        xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
        xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
        <office:body><office:spreadsheet><table:table table:name="Display">
          <table:table-row table:number-rows-repeated="1024">
            <table:table-cell office:value-type="float" office:value="1"><text:p>${'x'.repeat(8192)}</text:p>
          </table:table-cell></table:table-row>
        </table:table></office:spreadsheet></office:body>
      </office:document-content>`,
    );
    await expect(
      parse(await archive.generateAsync({ type: 'nodebuffer' }), 'display-repeat.ods'),
    ).rejects.toMatchObject({ code: 'SPREADSHEET_LIMIT', userErrorStatusCode: 413 });
  });

  it('passes the request policy to spreadsheet parsing', async () => {
    const file = {
      path: path.join(__dirname, 'sample.xlsx'),
      mimetype: mime,
    } as Express.Multer.File;
    const req = { config: { spreadsheetParsing: { maxConcurrent: 0 } } } as Pick<
      ServerRequest,
      'config'
    >;
    await expect(parseDocument({ file, req })).rejects.toThrow('configuration is invalid');
  });

  it('does not trust upload size metadata in the parser process', async () => {
    const buffer = Buffer.alloc(SPREADSHEET_LIMITS.inputBytes + 1);
    await expect(parse(buffer, 'oversize.xlsx')).rejects.toThrow('document parser limit');
    const parser = createSpreadsheetParser(
      path.join(
        path.dirname(require.resolve('@librechat/api')),
        'files/documents/spreadsheet-worker.cjs',
      ),
    );
    await expect(parser(path.join(directory, 'oversize.xlsx'))).rejects.toThrow(
      'safe processing limits',
    );
  });
});

describe('spreadsheet process lifecycle', () => {
  const fixture = path.join(__dirname, '__fixtures__', 'spreadsheet-worker.cjs');

  it('limits concurrency without a queue, terminates synchronous stalls, and recovers admission', async () => {
    const parser = createSpreadsheetParser(fixture);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const jobs = Array.from({ length: spreadsheetParsingSchema.parse({}).maxConcurrent }, () =>
      parser('stall'),
    );
    const results = Promise.allSettled(jobs);
    try {
      await expect(parser('extra')).rejects.toThrow('busy');
      for (const result of await results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { code: 'SPREADSHEET_LIMIT', userErrorStatusCode: 413 },
        });
      }
      expect(ticks).toBeGreaterThan(0);
      await expect(parser('normal')).resolves.toBe('recovered');
    } finally {
      clearInterval(timer);
    }
  });

  it.each([1, 3])(
    'applies configured concurrency %i without a queue and recovers capacity',
    async (maxConcurrent) => {
      const parser = createSpreadsheetParser(fixture);
      const jobs = Promise.allSettled(
        Array.from({ length: maxConcurrent }, () =>
          parser('stall', { maxConcurrent, timeoutMs: 500 }),
        ),
      );
      await expect(parser('extra', { maxConcurrent })).rejects.toBeInstanceOf(SpreadsheetBusyError);
      await expect(parser('extra', { maxConcurrent })).rejects.toMatchObject({
        code: 'SPREADSHEET_BUSY',
        userErrorStatusCode: 503,
      });
      for (const result of await jobs) {
        expect(result).toMatchObject({
          status: 'rejected',
          reason: { code: 'SPREADSHEET_LIMIT', userErrorStatusCode: 413 },
        });
      }
      await expect(parser('normal', { maxConcurrent })).resolves.toBe('recovered');
    },
  );

  it('honors a configured deadline longer than the default', async () => {
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(5000);
    try {
      await expect(createSpreadsheetParser(fixture)('normal', { timeoutMs: 6000 })).resolves.toBe(
        'recovered',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it.each([{ maxConcurrent: 9 }, { timeoutMs: 60_001 }, { timeoutMs: Infinity }])(
    'fails closed on unsafe parser policy %p before starting work',
    async (configured) => {
      await expect(createSpreadsheetParser(fixture)('normal', configured)).rejects.toThrow(
        'configuration is invalid',
      );
    },
  );

  it.each(['crash', 'exit'])('sanitizes a process %s and releases admission', async (operation) => {
    const parser = createSpreadsheetParser(fixture);
    await expect(parser(operation)).rejects.toThrow(/^Spreadsheet processing failed\.$/);
    await expect(parser('normal')).resolves.toBe('recovered');
  });

  it('rejects a reply at the monotonic deadline, even before the timer callback', async () => {
    const clock = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(spreadsheetParsingSchema.parse({}).timeoutMs);
    try {
      await expect(createSpreadsheetParser(fixture)('normal')).rejects.toThrow(
        'safe processing limits',
      );
    } finally {
      clock.mockRestore();
    }
  });

  it('enforces its own effective heap ceiling despite inherited Node heap flags', async () => {
    const original = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--max-old-space-size=6144';
    try {
      const parser = createSpreadsheetParser(fixture);
      const heapLimit = Number(await parser('heap'));
      expect(heapLimit).toBeGreaterThan(SPREADSHEET_LIMITS.heapMb);
      expect(heapLimit).toBeLessThan(200);
      await expect(parser('allocate')).rejects.toThrow(/^Spreadsheet processing failed\.$/);
      await expect(parser('normal')).resolves.toBe('recovered');
    } finally {
      if (original === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = original;
    }
  });

  it('sanitizes asynchronous startup failures and releases admission', async () => {
    const parser = createSpreadsheetParser(path.join(__dirname, 'missing-worker.cjs'));
    await expect(parser('normal')).rejects.toThrow(/^Spreadsheet processing failed\.$/);
    await expect(parser('normal')).rejects.toThrow(/^Spreadsheet processing failed\.$/);
  });

  it('sanitizes startup failures without consuming capacity', async () => {
    const startup = jest
      .spyOn(jest.requireActual<typeof import('node:child_process')>('node:child_process'), 'fork')
      .mockImplementationOnce(() => {
        throw new Error('PRIVATE-STARTUP');
      });
    const parser = createSpreadsheetParser(fixture);
    await expect(parser('normal')).rejects.toThrow(/^Spreadsheet processing failed\.$/);
    startup.mockRestore();
    await expect(parser('normal')).resolves.toBe('recovered');
  });
});
