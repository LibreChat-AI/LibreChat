import path from 'path';
import { parseDocument, annotateMissingPages } from './crud';

/**
 * pdfjs ships ESM this Jest setup cannot load, so the suite stubs it wholesale.
 * Per-test behavior is driven through these knobs; the default of no text models
 * pages with no readable layer, which is what image-only fixtures contain.
 */
const mockPdfjs: {
  numPages: number;
  pageText: Record<number, string>;
  destroy: jest.Mock<Promise<void>, []>;
  requestedPages: number[];
} = {
  numPages: 1,
  pageText: {},
  destroy: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  requestedPages: [],
};

jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => ({
    destroy: () => mockPdfjs.destroy(),
    promise: Promise.resolve({
      get numPages() {
        return mockPdfjs.numPages;
      },
      getPage: (pageNumber: number) => {
        mockPdfjs.requestedPages.push(pageNumber);
        return Promise.resolve({
          getTextContent: () =>
            Promise.resolve({
              items: (mockPdfjs.pageText[pageNumber] ?? '')
                .split(' ')
                .filter(Boolean)
                .map((str) => ({ str })),
            }),
        });
      },
    }),
  }),
}));

const fixture = (name: string, mimetype: string): Express.Multer.File =>
  ({
    originalname: name,
    path: path.join(__dirname, name),
    mimetype,
  }) as Express.Multer.File;

describe('Document Parser', () => {
  beforeEach(() => {
    mockPdfjs.numPages = 1;
    mockPdfjs.pageText = {};
    mockPdfjs.destroy.mockClear();
    mockPdfjs.requestedPages = [];
  });

  test.each([
    [
      'sample.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'This is a sample DOCX file.',
    ],
    [
      'sample.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '| Data | on | first | sheet |',
    ],
    ['sample.xls', 'application/vnd.ms-excel', '| Data | on | first | sheet |'],
    ['sample.ods', 'application/vnd.oasis.opendocument.spreadsheet', '## Second Sheet'],
    ['sample.odt', 'application/vnd.oasis.opendocument.text', 'It has two paragraphs.'],
  ])('routes %s through AnyDoc', async (name, mimetype, expectedText) => {
    const document = await parseDocument({ file: fixture(name, mimetype) });

    expect(document.filepath).toBe('anydoc');
    expect(document.filename).toBe(name);
    expect(document.text).toContain(expectedText);
    expect(document.bytes).toBe(Buffer.byteLength(document.text, 'utf8'));
  });

  /**
   * Admission accepts a PDF alias an operator names in the parser allowlist, so dispatch
   * has to recognize it too: anydoc refuses a `.pdf` outright, so an alias that reached
   * it would be accepted at the door and then rejected by the only engine offered it.
   */
  test.each([
    ['a vendor PDF alias', 'application/x-pdf'],
    ['a generic binary type', 'application/octet-stream'],
    ['no type at all', ''],
  ])('routes a .pdf declared as %s through pdf-inspector', async (_label, mimetype) => {
    const document = await parseDocument({ file: fixture('sample.pdf', mimetype) });

    expect(document.filepath).toBe('pdf_inspector');
    expect(document.text).toContain('# Quarterly Report');
  });

  test('keeps a supported anydoc type on anydoc even when named .pdf', async () => {
    /* The other direction: a declared type that names an anydoc format describes the
     * bytes, and the name does not. */
    const document = await parseDocument({
      file: {
        ...fixture(
          'structured.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
        originalname: 'report.pdf',
      },
    });

    expect(document.filepath).toBe('anydoc');
    expect(document.text).toContain('# Quarterly Report');
  });

  test('routes PowerPoint through AnyDoc and preserves table structure', async () => {
    const document = await parseDocument({
      file: fixture(
        'deck.pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      ),
    });

    expect(document.filepath).toBe('anydoc');
    expect(document.text).toContain('Quarterly Highlights');
    expect(document.text).toContain('| Region |');
  });

  test('routes PDFs through the direct pdf-inspector adapter', async () => {
    const document = await parseDocument({ file: fixture('sample.pdf', 'application/pdf') });

    expect(document.filepath).toBe('pdf_inspector');
    expect(document.filename).toBe('sample.pdf');
    expect(document.text).toContain('# Quarterly Report');
    expect(document.text).toContain('|Region|Units|Revenue|');
    expect(document.pagesNeedingOcr).toBeUndefined();
  });

  test.each(['application/octet-stream', 'binary/octet-stream'])(
    'routes a PDF with generic MIME %s through the direct pdf-inspector adapter',
    async (mimetype) => {
      const document = await parseDocument({ file: fixture('sample.pdf', mimetype) });

      expect(document.filepath).toBe('pdf_inspector');
      expect(document.filename).toBe('sample.pdf');
      expect(document.text).toContain('# Quarterly Report');
    },
  );

  test('reports pages that still need OCR after local PDF extraction', async () => {
    const document = await parseDocument({
      file: fixture('sample-mixed.pdf', 'application/pdf'),
    });

    expect(document.filepath).toBe('pdf_inspector');
    expect(document.text).toContain('Quarterly Report');
    expect(document.pagesNeedingOcr).toEqual([2]);
  });

  test('recovers a page from its raw PDF text layer before requesting OCR', async () => {
    mockPdfjs.pageText = { 2: 'garbled but present ocr layer text' };

    const document = await parseDocument({
      file: fixture('sample-mixed.pdf', 'application/pdf'),
    });

    expect(document.text).toContain('garbled but present ocr layer text');
    expect(document.pagesNeedingOcr).toBeUndefined();
    expect(mockPdfjs.destroy).toHaveBeenCalled();
  });

  test('falls back to pdfjs when pdf-inspector rejects a damaged PDF', async () => {
    mockPdfjs.pageText = { 1: 'Quarterly Report' };

    const document = await parseDocument({
      file: fixture('sample-badxref.pdf', 'application/pdf'),
    });

    expect(document.filepath).toBe('pdf_inspector');
    expect(document.text).toBe('Quarterly Report\n');
    expect(mockPdfjs.destroy).toHaveBeenCalled();
  });

  test('throws when a fully scanned PDF has no local text', async () => {
    await expect(
      parseDocument({ file: fixture('sample-scanned.pdf', 'application/pdf') }),
    ).rejects.toThrow('No text found in document');
  });

  test('returns a provider-specific error for unsupported non-PDF input', async () => {
    const file = {
      ...fixture('nonexistent.file', 'application/invalid'),
      size: 0,
    } as Express.Multer.File;

    await expect(parseDocument({ file })).rejects.toThrow(
      'Unsupported file type in the anydoc parser',
    );
  });

  test('rejects files exceeding the shared local parser size limit', async () => {
    const file = {
      ...fixture(
        'sample.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      size: 16 * 1024 * 1024,
    } as Express.Multer.File;

    await expect(parseDocument({ file })).rejects.toMatchObject({
      name: 'ParserInputLimitError',
      code: 'PARSER_INPUT_LIMIT',
      userErrorStatusCode: 413,
      message: expect.stringMatching(/exceeds the 15MB document parser limit \(16MB\)/),
    });
  });

  test('allows files exactly at the shared local parser size limit', async () => {
    const file = {
      ...fixture(
        'sample.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      size: 15 * 1024 * 1024,
    } as Express.Multer.File;

    await expect(parseDocument({ file })).resolves.toEqual(
      expect.objectContaining({ filepath: 'anydoc' }),
    );
  });

  /* An operator who raises the endpoint and server limits above the parser's default
   * otherwise gets an unconditional 413 on an upload the rest of the stack admitted. */
  test('parses a file above the default ceiling when the operator raised it', async () => {
    const file = {
      ...fixture(
        'sample.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
      size: 16 * 1024 * 1024,
    } as Express.Multer.File;

    await expect(parseDocument({ file, maxFileSize: 32 * 1024 * 1024 })).resolves.toEqual(
      expect.objectContaining({ filepath: 'anydoc' }),
    );
    await expect(parseDocument({ file, maxFileSize: 8 * 1024 * 1024 })).rejects.toMatchObject({
      code: 'PARSER_INPUT_LIMIT',
      message: expect.stringMatching(/exceeds the 8MB document parser limit \(16MB\)/),
    });
  });

  /* The deadline is an operator lever, and only the child enforces it: a document that
   * converts fine on the default has to be killed on a 1ms budget. */
  test('kills an extraction that exceeds the configured deadline', async () => {
    const file = fixture(
      'sample.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );

    await expect(parseDocument({ file, timeoutMs: 1 })).rejects.toThrow(/timed out after 1ms/);
    await expect(parseDocument({ file })).resolves.toEqual(
      expect.objectContaining({ filepath: 'anydoc' }),
    );
  });

  describe('annotateMissingPages()', () => {
    test('returns text unchanged when no pages are missing', () => {
      expect(annotateMissingPages('body', undefined)).toBe('body');
      expect(annotateMissingPages('body', [])).toBe('body');
    });

    test('names a single missing page in the singular', () => {
      const annotated = annotateMissingPages('body', [3]);

      expect(annotated).toContain('[Page 3 of this document contains no extractable text');
      expect(annotated).toContain('requires an OCR service');
      expect(annotated.startsWith('body')).toBe(true);
    });

    test('names every missing page', () => {
      const annotated = annotateMissingPages('body', [2, 5, 9]);

      expect(annotated).toContain('Pages 2, 5, 9');
      expect(annotated).toContain('require an OCR service');
    });

    test('caps the enumeration on a mostly-scanned document', () => {
      const pages = Array.from({ length: 5000 }, (_, index) => index + 1);

      const annotated = annotateMissingPages('body', pages);

      expect(annotated).toContain('Pages 1, 2, 3');
      expect(annotated).toContain('20 and 4980 more');
      expect(annotated).not.toContain('21,');
      expect(annotated.length).toBeLessThan(300);
    });
  });
});
