import path from 'path';
import * as fs from 'fs';
import JSZip from 'jszip';
import { parseDocument } from './crud';

describe('Document Parser', () => {
  test('parseDocument() parses text from docx', async () => {
    const file = {
      originalname: 'sample.docx',
      path: path.join(__dirname, 'sample.docx'),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 29,
      filename: 'sample.docx',
      filepath: 'document_parser',
      images: [],
      text: 'This is a sample DOCX file.\n\n',
    });
  });

  test('parseDocument() parses text from xlsx', async () => {
    const file = {
      originalname: 'sample.xlsx',
      path: path.join(__dirname, 'sample.xlsx'),
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 66,
      filename: 'sample.xlsx',
      filepath: 'document_parser',
      images: [],
      text: 'Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n',
    });
  });

  test('parseDocument() parses text from xls', async () => {
    const file = {
      originalname: 'sample.xls',
      path: path.join(__dirname, 'sample.xls'),
      mimetype: 'application/vnd.ms-excel',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 31,
      filename: 'sample.xls',
      filepath: 'document_parser',
      images: [],
      text: 'Sheet One:\nData,on,first,sheet\n',
    });
  });

  test('parseDocument() parses text from xlsb', async () => {
    const file = {
      originalname: 'sample.xlsb',
      path: path.join(__dirname, 'sample.xlsb'),
      mimetype: 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 66,
      filename: 'sample.xlsb',
      filepath: 'document_parser',
      images: [],
      text: 'Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n',
    });
  });

  test('parseDocument() parses text from ods', async () => {
    const file = {
      originalname: 'sample.ods',
      path: path.join(__dirname, 'sample.ods'),
      mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 66,
      filename: 'sample.ods',
      filepath: 'document_parser',
      images: [],
      text: 'Sheet One:\nData,on,first,sheet\nSecond Sheet:\nData,On\nSecond,Sheet\n',
    });
  });

  test('parseDocument() parses text from odt', async () => {
    const file = {
      originalname: 'sample.odt',
      path: path.join(__dirname, 'sample.odt'),
      mimetype: 'application/vnd.oasis.opendocument.text',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 50,
      filename: 'sample.odt',
      filepath: 'document_parser',
      images: [],
      text: 'This is a sample ODT file.\n\nIt has two paragraphs.',
    });
  });

  test('parseDocument() throws for odt with no extractable text', async () => {
    const file = {
      originalname: 'empty.odt',
      path: path.join(__dirname, 'empty.odt'),
      mimetype: 'application/vnd.oasis.opendocument.text',
    } as Express.Multer.File;

    await expect(parseDocument({ file })).rejects.toThrow('No text found in document');
  });

  test('parseDocument() aborts decompression when content.xml exceeds the size limit', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    zip.file('content.xml', 'x'.repeat(51 * 1024 * 1024), { compression: 'DEFLATE' });
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const tmpPath = path.join(__dirname, 'bomb.odt');
    await fs.promises.writeFile(tmpPath, buf);
    try {
      const file = {
        originalname: 'bomb.odt',
        path: tmpPath,
        mimetype: 'application/vnd.oasis.opendocument.text',
      } as Express.Multer.File;
      await expect(parseDocument({ file })).rejects.toThrow(/exceeds the 50MB decompressed limit/);
    } finally {
      await fs.promises.unlink(tmpPath);
    }
  });

  test('parseDocument() decodes XML entities and normalizes tab and spacing elements to spaces from odt', async () => {
    const file = {
      originalname: 'sample-entities.odt',
      path: path.join(__dirname, 'sample-entities.odt'),
      mimetype: 'application/vnd.oasis.opendocument.text',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 19,
      filename: 'sample-entities.odt',
      filepath: 'document_parser',
      images: [],
      text: 'AT&T and A>B\n\nx y z',
    });
  });

  test.each([
    'application/msexcel',
    'application/x-msexcel',
    'application/x-ms-excel',
    'application/x-excel',
    'application/x-dos_ms_excel',
    'application/xls',
    'application/x-xls',
  ])('parseDocument() parses xls with variant MIME type: %s', async (mimetype) => {
    const file = {
      originalname: 'sample.xls',
      path: path.join(__dirname, 'sample.xls'),
      mimetype,
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 31,
      filename: 'sample.xls',
      filepath: 'document_parser',
      images: [],
      text: 'Sheet One:\nData,on,first,sheet\n',
    });
  });

  test('parseDocument() throws error for unhandled document type', async () => {
    const file = {
      originalname: 'nonexistent.file',
      path: path.join(__dirname, 'nonexistent.file'),
      mimetype: 'application/invalid',
    } as Express.Multer.File;

    await expect(parseDocument({ file })).rejects.toThrow(
      'Unsupported file type in document parser: application/invalid',
    );
  });

  test('parseDocument() throws error for empty document', async () => {
    const file = {
      originalname: 'empty.docx',
      path: path.join(__dirname, 'empty.docx'),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    } as Express.Multer.File;

    await expect(parseDocument({ file })).rejects.toThrow('No text found in document');
  });

  test('parseDocument() rejects files exceeding the pre-parse size limit', async () => {
    const file = {
      originalname: 'oversized.docx',
      path: path.join(__dirname, 'sample.docx'),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 16 * 1024 * 1024,
    } as Express.Multer.File;

    await expect(parseDocument({ file })).rejects.toThrow(
      /exceeds the 15MB document parser limit \(16MB\)/,
    );
  });

  test('parseDocument() allows files exactly at the size limit boundary', async () => {
    const file = {
      originalname: 'sample.docx',
      path: path.join(__dirname, 'sample.docx'),
      mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 15 * 1024 * 1024,
    } as Express.Multer.File;

    await expect(parseDocument({ file })).resolves.toBeDefined();
  });

  test('parseDocument() parses empty xlsx with only sheet name', async () => {
    const file = {
      originalname: 'empty.xlsx',
      path: path.join(__dirname, 'empty.xlsx'),
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    } as Express.Multer.File;

    const document = await parseDocument({ file });

    expect(document).toEqual({
      bytes: 8,
      filename: 'empty.xlsx',
      filepath: 'document_parser',
      images: [],
      text: 'Empty:\n\n',
    });
  });

  test('xlsx exports read and utils as named imports', async () => {
    const { read, utils } = await import('xlsx');
    expect(typeof read).toBe('function');
    expect(typeof utils?.sheet_to_csv).toBe('function');
  });
});

/* eslint-disable jest/no-standalone-expect -- the `itIfFixturePresent` alias collapses to
 * `test.skip` when the real Rich Value fixture hasn't been supplied; the lint rule doesn't
 * realize the `expect`s below are still scoped to a real test block via the alias. Disabling
 * locally matches the established pattern in `libreoffice.spec.ts`'s `itIfLibreOffice`. */
describe('Document Parser - Excel read() failure handling', () => {
  /**
   * SheetJS CE 0.20.3 hard-throws a raw internal error (`Unexpected record 0x3b`) on at
   * least one legitimate, non-corrupted XLSB shape: workbooks using Excel's "Rich Value"
   * cell-metadata feature (linked data types such as Stocks/Geography) emit a `BrtStr`
   * record in `xl/metadata.bin` that SheetJS's metadata parser doesn't recognize. Confirmed
   * via an independent parser (python-calamine) successfully reading the same file
   * byte-for-byte — this is a SheetJS parsing gap, not file corruption.
   *
   * This first test is fully deterministic and needs no special fixture: a minimal ZIP
   * that passes the zip-bomb safety check (it's tiny and well-formed) but carries none of
   * the OPC parts SheetJS expects reproduces the same "safety check passes, read() itself
   * throws" shape as the real Rich Value crash, without needing a real Excel file.
   */
  test('parseDocument() rejects a malformed xlsb with a clean message, not a raw SheetJS error', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/vnd.ms-excel.sheet.binary.macroenabled.12');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const tmpPath = path.join(__dirname, 'malformed.xlsb');
    await fs.promises.writeFile(tmpPath, buf);
    try {
      const file = {
        originalname: 'malformed.xlsb',
        path: tmpPath,
        mimetype: 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
      } as Express.Multer.File;

      await expect(parseDocument({ file })).rejects.toThrow(
        'Unable to extract text from this Excel file',
      );
    } finally {
      await fs.promises.unlink(tmpPath);
    }
  });

  /**
   * Best-effort regression test for the exact real-world crash. A self-generated SheetJS
   * fixture CANNOT reproduce this bug (SheetJS can always read back whatever it just wrote),
   * so this test only runs if a real, Excel-authored Rich Value `.xlsb` fixture has been
   * supplied at `richvalue.xlsb` alongside this spec file — see
   * `docs/librechat/librechat-xlsb-support-plan.md` §9 for how to author one (Excel Data tab
   * → Data Types → Stocks/Geography on a small column, then Save As `.xlsb`). Skips
   * gracefully (not a failure) when the fixture hasn't been provided yet.
   */
  const richValueFixture = path.join(__dirname, 'richvalue.xlsb');
  const itIfFixturePresent = fs.existsSync(richValueFixture) ? test : test.skip;

  itIfFixturePresent(
    'parseDocument() rejects a real Rich Value xlsb cleanly instead of crashing (requires richvalue.xlsb fixture)',
    async () => {
      const file = {
        originalname: 'richvalue.xlsb',
        path: richValueFixture,
        mimetype: 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
      } as Express.Multer.File;

      await expect(parseDocument({ file })).rejects.toThrow(
        'Unable to extract text from this Excel file',
      );
    },
  );
});
