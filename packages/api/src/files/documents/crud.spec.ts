import os from 'os';
import path from 'path';
import * as fs from 'fs';
import JSZip from 'jszip';
import { docx, grid, paragraph } from './docx.helper';
import * as opendocument from './odt.helper';
import { parseDocument } from './crud';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ODT = 'application/vnd.oasis.opendocument.text';

/** Writes `buffer` out as an upload named `name`, parses it and removes it again. */
async function parseUpload(name: string, mimetype: string, buffer: Buffer): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'document-'));
  try {
    const filePath = path.join(dir, name);
    await fs.promises.writeFile(filePath, buffer);
    const file = { originalname: name, path: filePath, mimetype };
    return (await parseDocument({ file: file as Express.Multer.File })).text;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Writes `body` out as a .docx, parses it as an upload and removes it again. */
const parseBody = async (body: string): Promise<string> =>
  parseUpload('upload.docx', DOCX, await docx(body));

/** Writes `body` out as an .odt, parses it as an upload and removes it again. */
const parseOdt = async (body: string): Promise<string> =>
  parseUpload('upload.odt', ODT, await opendocument.odt(body));

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

  test('parseDocument() keeps each docx table row together as CSV', async () => {
    const text = await parseBody(
      paragraph('Intro paragraph.') +
        grid(['Region', 'Product', 'Units'], ['EU', 'Cable', '12'], ['US', 'Hub', '7']) +
        paragraph('Closing paragraph.'),
    );

    expect(text).toBe(
      'Intro paragraph.\n\nRegion,Product,Units\nEU,Cable,12\nUS,Hub,7\n\nClosing paragraph.\n\n',
    );
  });

  test('parseDocument() throws for a docx whose only content is an empty table', async () => {
    await expect(parseBody(grid(['', ''], [' ', '']))).rejects.toThrow('No text found in document');
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

  test('parseDocument() keeps each odt table row together as CSV', async () => {
    const text = await parseOdt(
      opendocument.paragraph('Intro paragraph.') +
        opendocument.grid(
          ['Region', 'Product', 'Units'],
          ['EU', 'Cable', '12'],
          ['US', 'Hub', '7'],
        ) +
        opendocument.paragraph('Closing paragraph.'),
    );

    expect(text).toBe(
      'Intro paragraph.\n\nRegion,Product,Units\nEU,Cable,12\nUS,Hub,7\n\nClosing paragraph.',
    );
  });

  test('parseDocument() throws for an odt whose only content is an empty table', async () => {
    await expect(parseOdt(opendocument.grid(['', ''], [' ', '']))).rejects.toThrow(
      'No text found in document',
    );
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
