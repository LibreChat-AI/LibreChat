import path from 'path';
import * as fs from 'fs';
import { megabyte } from 'librechat-data-provider';
import { parseWithPdfInspector, pdfInspectorSupportedMimeTypes } from './crud';

/**
 * pdfjs ships ESM this Jest setup cannot load, so the suite stubs it wholesale.
 * Per-test behavior is driven through these knobs; the default of no text models
 * pages with no readable layer, which is what image-only fixtures contain.
 */
const mockPdfjs: {
  numPages: number;
  pageText: Record<number, string>;
  destroy: jest.Mock<Promise<void>, []>;
  /** 1-indexed pages pdfjs was asked for, so tests can prove the walk is bounded. */
  requestedPages: number[];
  /** Fires as each page is read, so a test can interrupt the walk from inside it. */
  onPage?: (pageNumber: number) => void;
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
        mockPdfjs.onPage?.(pageNumber);
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

describe('pdf-inspector local parser', () => {
  const pdfFile = (name: string, mimetype = 'application/pdf'): Express.Multer.File =>
    ({
      originalname: name,
      path: path.join(__dirname, '..', 'documents', name),
      mimetype,
    }) as Express.Multer.File;

  const context = (file: Express.Multer.File) => file;

  beforeEach(() => {
    mockPdfjs.numPages = 1;
    mockPdfjs.pageText = {};
    mockPdfjs.destroy.mockClear();
    mockPdfjs.requestedPages = [];
    mockPdfjs.onPage = undefined;
  });

  describe('supported types', () => {
    test('declares PDF as its only supported type', () => {
      expect(pdfInspectorSupportedMimeTypes).toHaveLength(1);
      expect(pdfInspectorSupportedMimeTypes[0].test('application/pdf')).toBe(true);
      expect(pdfInspectorSupportedMimeTypes[0].test('application/pdfx')).toBe(false);
    });

    test('rejects a non-PDF with a message naming the provider and the type', async () => {
      /* Direct callers can still pass a DOCX, so the refusal has to say which engine
       * refused and what it was handed. */
      const file = pdfFile(
        'sample.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      );

      await expect(parseWithPdfInspector(context(file))).rejects.toThrow(
        /pdf-inspector only extracts PDF files, but received "application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document"/,
      );
    });

    test('rejects a missing mimetype rather than attempting a parse', async () => {
      const file = pdfFile('sample.pdf', '');

      await expect(parseWithPdfInspector(context(file))).rejects.toThrow(
        'pdf-inspector only extracts PDF files, but received "unknown".',
      );
    });
  });

  test('recovers layout structure from a text-based pdf', async () => {
    const result = await parseWithPdfInspector(context(pdfFile('sample.pdf')));

    expect(result.filepath).toBe('pdf_inspector');
    expect(result.filename).toBe('sample.pdf');
    expect(result.images).toEqual([]);
    expect(result.bytes).toBe(Buffer.byteLength(result.text, 'utf8'));
    /** Headings and tables are the structure the flat pdfjs extractor cannot express. */
    expect(result.text).toContain('# Quarterly Report');
    expect(result.text).toContain('|Region|Units|Revenue|');
    expect(result.text).toContain('|North|1200|48000|');
    expect(result.pagesNeedingOcr).toBeUndefined();
  });

  test('reports the scanned pages of a part-scanned pdf', async () => {
    const result = await parseWithPdfInspector(context(pdfFile('sample-mixed.pdf')));

    /** Page 1 is real text; page 2 has no text layer in either engine and must be
     * called out, not dropped silently. */
    expect(result.text).toContain('Quarterly Report');
    expect(result.pagesNeedingOcr).toEqual([2]);
  });

  test('recovers pages pdf-inspector drops, from the raw text layer', async () => {
    /* pdf-inspector's quality heuristics reject poor embedded OCR layers outright:
     * on a 157-page scanned press kit it kept 5 pages and silently dropped 152.
     * A page it drops must fall back to whatever the raw text layer holds, and only
     * pages where both engines find nothing belong in the omission notice. */
    mockPdfjs.pageText = { 2: 'garbled but present ocr layer text' };

    const result = await parseWithPdfInspector(context(pdfFile('sample-mixed.pdf')));

    expect(result.text).toContain('Quarterly Report');
    expect(result.text).toContain('garbled but present ocr layer text');
    expect(result.pagesNeedingOcr).toBeUndefined();
  });

  test('ignores garbled-text flags that are not scanned pages', async () => {
    /* pdf-inspector also flags pages via a suspected_garbled_text heuristic that
     * false-positives on dot leaders and other dense punctuation. Those pages keep
     * their text, so reporting them would claim content was dropped when none was.
     * Only the empirical two-engine probe decides what needs OCR. */
    const { processPdf } = await import('@firecrawl/pdf-inspector');
    const raw = processPdf(fs.readFileSync(path.join(__dirname, '..', 'documents', 'sample.pdf')));
    const reasons = (raw.ocrReasonsByPage ?? []).flatMap((entry) => entry.reasons ?? []);

    expect(reasons).not.toContain('scanned');

    const result = await parseWithPdfInspector(context(pdfFile('sample.pdf')));

    expect(result.pagesNeedingOcr).toBeUndefined();
  });

  test('returns no text and reports every page for a fully scanned pdf', async () => {
    /* Neither engine finds a text layer, so the document is empty and every page is
     * accounted for. Deciding what an empty extraction means belongs to the caller. */
    const result = await parseWithPdfInspector(context(pdfFile('sample-scanned.pdf')));

    expect(result.text).toBe('');
    expect(result.pagesNeedingOcr).toEqual([1]);
  });

  test('falls back to pdfjs for a document with a corrupted xref table', async () => {
    mockPdfjs.pageText = { 1: 'Quarterly Report' };

    const result = await parseWithPdfInspector(context(pdfFile('sample-badxref.pdf')));

    expect(result.filepath).toBe('pdf_inspector');
    expect(result.text).toBe('Quarterly Report\n');
    expect(mockPdfjs.destroy).toHaveBeenCalled();
  });

  test('falls back to pdfjs when pdf-inspector reports no pages', async () => {
    mockPdfjs.pageText = { 1: 'Recovered flat text' };
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: [], scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).toBe('Recovered flat text\n');
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('reports image-only pages when the whole-document pdfjs fallback reads mixed content', async () => {
    mockPdfjs.numPages = 2;
    mockPdfjs.pageText = { 1: 'Recovered text page' };
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => {
            throw new Error('native parser rejected the document');
          },
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).toBe('Recovered text page\n\n');
        expect(result.pagesNeedingOcr).toEqual([2]);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  /**
   * Past the recovery cap, unprobed pages are reported as needing OCR, which asks the
   * upload path to send the whole document to a configured provider. A page costs about
   * 100 bytes to declare, so without a ceiling a 1MB upload buys a ten-thousand-page
   * OCR job on someone else's bill.
   */
  test('refuses a document past the page ceiling before anything can hand it to OCR', async () => {
    const flooded = Array.from({ length: 1001 }, (_, page) => ({ page, markdown: '' }));
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(uploadIsolated(context(pdfFile('sample.pdf')))).rejects.toMatchObject({
          name: 'PdfPageLimitError',
          code: 'PDF_PAGE_LIMIT',
          /** Permanent for this document, so the route answers with it rather than a 500. */
          userErrorStatusCode: 413,
        });
        expect(mockPdfjs.requestedPages).toHaveLength(0);
      });
    } finally {
      jest.dontMock('./native');
    }
  });
  test('accepts a PDF above the default ceiling when maxPageCount is configured', async () => {
    const flooded = Array.from({ length: 1001 }, (_, page) => ({ page, markdown: '' }));
    mockPdfjs.pageText = { 1: 'Recovered page text' };
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')), undefined, {
          maxPageCount: 1500,
        });

        expect(result.text).toContain('Recovered page text');
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('applies maxPageCount to the whole-document pdfjs fallback', async () => {
    mockPdfjs.numPages = 1001;
    mockPdfjs.pageText = { 1: 'Recovered fallback text' };
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => {
            throw new Error('native parser rejected the document');
          },
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')), undefined, {
          maxPageCount: 1500,
        });

        expect(result.text).toContain('Recovered fallback text');
        expect(mockPdfjs.requestedPages).toHaveLength(1001);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  /**
   * The case the whole signal exists for, against the real binding: one page holding
   * selectable text and an image. The extraction reports the page as fine, so only the
   * classifier's `scanned` reason can say a scan may hold more text than was read.
   */
  test('reports a real page that carries both text and an image', async () => {
    const mixed = path.join(__dirname, 'sample-text-and-image.pdf');
    fs.writeFileSync(mixed, buildTextAndImagePdf());
    try {
      const result = await parseWithPdfInspector(
        context({
          originalname: 'invoice.pdf',
          path: mixed,
          mimetype: 'application/pdf',
        } as Express.Multer.File),
      );

      expect(result.text).toContain('Invoice');
      expect(result.pagesNeedingOcr).toBeUndefined();
      expect(result.mayOmitContent).toBe(true);
    } finally {
      fs.unlinkSync(mixed);
    }
  });

  test('reports nothing for a text-only document', async () => {
    const result = await parseWithPdfInspector(context(pdfFile('sample.pdf')));

    expect(result.mayOmitContent).toBeUndefined();
  });

  /**
   * A page with a header above a scanned body comes back with text, so no probe calls it
   * missing and PDFs have no media manifest to consult. The classifier's scan reason on
   * a page that did extract is the only thing left that can say more may be sitting there.
   */
  test('reports a page the classifier attributes to a scan despite extracting text', async () => {
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [
              { page: 0, markdown: '# Invoice header' },
              { page: 1, markdown: '# Terms' },
            ],
            scannedPages: [1],
          }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.mayOmitContent).toBe(true);
        expect(result.pagesNeedingOcr).toBeUndefined();
        expect(result.text).toContain('# Invoice header');
      });
    } finally {
      jest.dontMock('./native');
    }
  });
  test('marks content uncertain when page classification fails', async () => {
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [{ page: 0, markdown: '# Kept extraction' }],
            scannedPages: [],
            classificationDidNotRun: true,
          }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).toContain('# Kept extraction');
        expect(result.mayOmitContent).toBe(true);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  /**
   * The engine rejects a poor embedded OCR layer outright, so the page arrives with no
   * markdown and recovery supplies its raw text. That text drops the page out of the
   * omission report, and without the flag the upload reads as complete and keeps a
   * garbled layer a configured OCR service could have replaced.
   */
  test('keeps the scan signal for a flagged page whose text came from recovery', async () => {
    mockPdfjs.pageText = { 2: 'm u s h y r e c o v e r y' };
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [
              { page: 0, markdown: '# Cover' },
              { page: 1, markdown: '' },
            ],
            scannedPages: [2],
          }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).toContain('m u s h y r e c o v e r y');
        /** Recovered text means the page is no longer omitted, which is why the flag matters. */
        expect(result.pagesNeedingOcr).toBeUndefined();
        expect(result.mayOmitContent).toBe(true);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('reports nothing extra when the engine flags only pages it could not read', async () => {
    /* Those pages are already accounted for empirically, so repeating them as a media
     * signal would escalate every ordinary scanned document twice. */
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [
              { page: 0, markdown: '# Cover' },
              { page: 1, markdown: '' },
            ],
            scannedPages: [2],
          }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.mayOmitContent).toBeUndefined();
        expect(result.pagesNeedingOcr).toEqual([2]);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('bounds the whole-document pdfjs fallback on a page-flooded document', async () => {
    mockPdfjs.numPages = 4000;
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => {
            throw new Error('native parser rejected the document');
          },
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(uploadIsolated(context(pdfFile('sample.pdf')))).rejects.toMatchObject({
          name: 'PdfPageLimitError',
          code: 'PDF_PAGE_LIMIT',
          /* The fallback answers to the parser's ceiling, not the recovery walk's: the
           * two bound different work, and a PDF this parser accepts with a good xref
           * should not be refused with a damaged one. */
          message: 'PDF contains 4000 pages, exceeding the 1000-page fallback limit',
        });
        expect(mockPdfjs.requestedPages).toHaveLength(0);
        expect(mockPdfjs.destroy).toHaveBeenCalled();
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  /**
   * The child refuses an extraction that would not fit, and pdfjs is not the answer to
   * that: it would rebuild in the API process the very string the child declined to
   * send, spending the bound where it was supposed to be enforced.
   */
  test('does not answer a size refusal with the pdfjs fallback', async () => {
    mockPdfjs.numPages = 3;
    mockPdfjs.pageText = { 1: 'recovered text', 2: 'recovered text', 3: 'recovered text' };
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => {
            throw Object.assign(new Error('pdf-inspector extracted 22MB of text'), {
              name: 'ParserOutputLimitError',
              code: 'PARSER_OUTPUT_LIMIT',
            });
          },
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(uploadIsolated(context(pdfFile('sample.pdf')))).rejects.toThrow(
          /extracted 22MB of text/,
        );
        expect(mockPdfjs.requestedPages).toHaveLength(0);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('bounds the per-page pdfjs recovery by aggregate output size', async () => {
    /* Recovery is capped at 250 pages, which says nothing about how much text a page
     * holds, and every recovered string is retained together in the API process. */
    const flooded = Array.from({ length: 40 }, (_, page) => ({ page, markdown: '' }));
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [i + 1, 'x'.repeat(megabyte)]),
    );
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(uploadIsolated(context(pdfFile('sample.pdf')))).rejects.toMatchObject({
          name: 'ParserOutputLimitError',
          code: 'PARSER_OUTPUT_LIMIT',
        });
        /* Refused partway through rather than after reading all 40. */
        expect(mockPdfjs.requestedPages.length).toBeLessThan(40);
      });
    } finally {
      jest.dontMock('./native');
    }
  }, 30_000);

  /**
   * Recovered pages are joined with the native markdown, so giving recovery its own
   * full-size budget would let the pair reach twice the limit before anything
   * downstream could refuse the combined result.
   */
  test('charges page recovery against the budget the native pages already spent', async () => {
    const pages = [
      { page: 0, markdown: 'y'.repeat(14 * megabyte) },
      ...Array.from({ length: 10 }, (_, i) => ({ page: i + 1, markdown: '' })),
    ];
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 11 }, (_, i) => [i + 1, 'x'.repeat(megabyte)]),
    );
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: pages, scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(uploadIsolated(context(pdfFile('sample.pdf')))).rejects.toMatchObject({
          code: 'PARSER_OUTPUT_LIMIT',
        });
        /** 14MB of markdown leaves room for about one recovered page, not ten. */
        expect(mockPdfjs.requestedPages.length).toBeLessThanOrEqual(2);
      });
    } finally {
      jest.dontMock('./native');
    }
  }, 30_000);

  /**
   * Cancellation is the sharpest case of "this is not a document the engine could not
   * read": nobody is waiting for the answer, so starting a second engine would hold the
   * admission slot to produce something no one reads.
   */
  test('does not start the pdfjs fallback for a cancelled parse', async () => {
    mockPdfjs.numPages = 3;
    mockPdfjs.pageText = { 1: 'recovered', 2: 'recovered', 3: 'recovered' };
    const cancellation = new AbortController();
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => {
            cancellation.abort();
            throw new Error('Document parsing was cancelled');
          },
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(
          uploadIsolated(context(pdfFile('sample.pdf')), cancellation.signal),
        ).rejects.toThrow(/cancelled/);
        expect(mockPdfjs.requestedPages).toHaveLength(0);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('rethrows cancellation from the whole-document text fallback', async () => {
    const cancellation = new AbortController();
    const cancellationError = new Error('whole-document extraction cancelled');
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [
              { page: 0, markdown: '# Kept page' },
              { page: 1, markdown: '' },
              { page: 2, markdown: '' },
            ],
            scannedPages: [],
          }),
          extractTextIsolated: async () => {
            cancellation.abort(cancellationError);
            throw cancellationError;
          },
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(
          uploadIsolated(context(pdfFile('sample.pdf')), cancellation.signal),
        ).rejects.toBe(cancellationError);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  /**
   * Opening a slow or malformed document is itself long work. Checking only in the page
   * loop meant an abandoned parse held its admission slot for as long as the document
   * took to open, which is exactly the case the artifact timeout gives up on.
   */
  test('stops while the document is still loading when the caller cancels', async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => {
            throw new Error('native parser rejected the document');
          },
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(
          uploadIsolated(context(pdfFile('sample.pdf')), cancellation.signal),
        ).rejects.toThrow();
        /** Never reached a page, because the load was never awaited. */
        expect(mockPdfjs.requestedPages).toHaveLength(0);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('stops the per-page recovery walk when the caller cancels', async () => {
    /* The recovery walk is the long half of a parse, so an abandoned one has to stop at
     * the next page rather than run to the cap. */
    const flooded = Array.from({ length: 200 }, (_, page) => ({ page, markdown: '' }));
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [i + 1, 'recovered line']),
    );
    const cancellation = new AbortController();
    /* Aborted from inside the walk: the caller's own timeout fires while pages are being
     * read, which is the only moment the check has anything to catch. */
    mockPdfjs.onPage = (pageNumber) => {
      if (pageNumber === 5) {
        cancellation.abort();
      }
    };
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(
          uploadIsolated(context(pdfFile('sample.pdf')), cancellation.signal),
        ).rejects.toThrow(/cancelled/);
        expect(mockPdfjs.requestedPages.length).toBeLessThan(20);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('bounds the whole-document pdfjs walk by output size', async () => {
    /* Page count says nothing about how much text a page holds, and this walk runs in
     * the API process where the string is built before any caller can reject it. */
    mockPdfjs.numPages = 40;
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [i + 1, 'x'.repeat(megabyte)]),
    );
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => {
            throw new Error('native parser rejected the document');
          },
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');

        await expect(uploadIsolated(context(pdfFile('sample.pdf')))).rejects.toMatchObject({
          name: 'ParserOutputLimitError',
          code: 'PARSER_OUTPUT_LIMIT',
        });
      });
    } finally {
      jest.dontMock('./native');
    }
  }, 30_000);

  test('bounds the pdfjs recovery walk on a page-flooded document', async () => {
    /* Recovery is one sequential pdfjs read per dropped page (~20ms), while a page
     * object costs an attacker ~110 bytes, so an unbounded walk turns a single
     * upload into hours of CPU on the request path. Past the cap the pages are
     * reported as needing OCR instead of probed. */
    const flooded = Array.from({ length: 900 }, (_, page) => ({ page, markdown: '' }));
    /* Every page carries a readable layer, so an unbounded walk would recover all
     * 900 and report none. What the cap costs is visible in the assertions below. */
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 900 }, (_, i) => [i + 1, 'recovered line']),
    );
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(mockPdfjs.requestedPages).toHaveLength(250);
        /* Unprobed pages are reported rather than silently dropped, so the count
         * still accounts for the whole document. */
        expect(result.pagesNeedingOcr).toHaveLength(650);
        /** The pages that were probed still contribute their text. */
        expect(result.text).toContain('recovered line');
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  /* The cap bounds request time, not what the document is, so a deployment willing to
   * spend longer on a mostly-scanned PDF can probe further instead of reporting those
   * pages as needing OCR — which a strict inspection policy would refuse outright. */
  test('probes further when the configured recovery ceiling is raised', async () => {
    const flooded = Array.from({ length: 900 }, (_, page) => ({ page, markdown: '' }));
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 900 }, (_, i) => [i + 1, 'recovered line']),
    );
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => '',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')), undefined, {
          maxRecoveredPageCount: 400,
        });

        expect(mockPdfjs.requestedPages).toHaveLength(400);
        expect(result.pagesNeedingOcr).toHaveLength(500);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  /**
   * Whole-document text proves some text exists somewhere, not that each page past the
   * recovery cap had a layer. Taking it there would either claim included pages were
   * omitted or, worse, drop scanned ones silently and never reach OCR. Interleaving
   * keeps the report true, since there an unprobed page really is missing.
   */
  test('keeps unprobed pages accounted for rather than taking whole-document text', async () => {
    const flooded = Array.from({ length: 900 }, (_, page) => ({ page, markdown: '' }));
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [i + 1, 'recovered line']),
    );
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => 'clean whole document text',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).not.toBe('clean whole document text');
        expect(result.text).toContain('recovered line');
        /** Every page past the probe is still named, because it really is missing. */
        expect(result.pagesNeedingOcr).toHaveLength(650);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('keeps probed pages in the report when whole-document text ships', async () => {
    /* The counterpart, on a document small enough that every dropped page was probed:
     * a page both engines found nothing on holds no text layer at all, so the
     * whole-document extractor cannot have included it either. */
    const dropped = Array.from({ length: 200 }, (_, page) => ({ page, markdown: '' }));
    const structured = Array.from({ length: 100 }, (_, i) => ({
      page: 200 + i,
      markdown: '# Structured',
    }));
    const flooded = [...dropped, ...structured];
    mockPdfjs.pageText = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [i + 1, i === 4 ? '' : 'recovered line']),
    );
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({ pages: flooded, scannedPages: [] }),
          extractTextIsolated: async () => 'clean whole document text',
        }));

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).toBe('clean whole document text');
        expect(result.pagesNeedingOcr).toEqual([5]);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('ships whole-document plain text when most pages are dropped', async () => {
    /* Letter-spacing in poor OCR layers lives inside the item strings, so pdfjs
     * assembly outputs mush ("m i s s i o n"). pdf-inspector's plain-text extractor
     * re-segments words from glyph positions; when structure survived on only a
     * sliver of pages, the whole document goes through it instead. The omission
     * notice still comes from the empirical per-page probe. */
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [
              { page: 0, markdown: '# Only structured page' },
              { page: 1, markdown: '' },
              { page: 2, markdown: '' },
            ],
            scannedPages: [],
          }),
          extractTextIsolated: async () => 'clean whole document text',
        }));
        mockPdfjs.pageText = { 2: 'm u s h y r e c o v e r y' };

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).toBe('clean whole document text');
        /** Page 3 had nothing in either engine, and stays reported despite the swap. */
        expect(result.pagesNeedingOcr).toEqual([3]);
      });
    } finally {
      /* isolateModulesAsync scopes the module registry but not doMock itself. */
      jest.dontMock('./native');
    }
  });

  test('keeps per-page interleaving when exactly half the pages drop', async () => {
    /* Pins the majority threshold as a strict '>': at exactly 50% dropped the
     * per-page path still wins. Without this a '>=' would pass every other
     * assertion in the suite, since the mixed fixture is itself exactly 50%. */
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [
              { page: 0, markdown: '# Structured page' },
              { page: 1, markdown: '' },
            ],
            scannedPages: [],
          }),
          extractTextIsolated: async () => 'WHOLE_DOCUMENT_SENTINEL',
        }));
        mockPdfjs.pageText = { 2: 'recovered second page' };

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).not.toContain('WHOLE_DOCUMENT_SENTINEL');
        expect(result.text).toBe('# Structured page\n\nrecovered second page');
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('interleaves pages when the whole-document extractor throws', async () => {
    /* The plain-text extractor is an optimization, not a dependency: if it fails
     * on a majority-dropped document the per-page assembly still has to ship. */
    try {
      await jest.isolateModulesAsync(async () => {
        jest.doMock('./native', () => ({
          extractPagesMarkdownIsolated: async () => ({
            pages: [
              { page: 0, markdown: '# Only structured page' },
              { page: 1, markdown: '' },
              { page: 2, markdown: '' },
            ],
            scannedPages: [],
          }),
          extractTextIsolated: async () => {
            throw new Error('plain-text extraction failed');
          },
        }));
        mockPdfjs.pageText = { 2: 'recovered second page' };

        const { parseWithPdfInspector: uploadIsolated } = await import('./crud');
        const result = await uploadIsolated(context(pdfFile('sample.pdf')));

        expect(result.text).toBe('# Only structured page\n\nrecovered second page');
        /** Page 3 had nothing in either engine and is still reported. */
        expect(result.pagesNeedingOcr).toEqual([3]);
      });
    } finally {
      jest.dontMock('./native');
    }
  });

  test('releases the pdfjs document after page recovery', async () => {
    /* pdfjs pins the decoded document and its worker until the loading task is
     * destroyed, so an undestroyed task holds the buffer for the whole request. */
    await parseWithPdfInspector(context(pdfFile('sample-mixed.pdf')));

    expect(mockPdfjs.destroy).toHaveBeenCalled();
  });
});

/** One page holding selectable text and an embedded image, the mixed-content case. */
function buildTextAndImagePdf(): Buffer {
  const imageBytes = Buffer.alloc(8 * 8, 0x40).toString('latin1');
  const content =
    'BT /F1 18 Tf 72 700 Td (Invoice Header Total Due) Tj ET\n' +
    'q 200 0 0 200 72 400 cm /Im1 Do Q\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${imageBytes.length} >>\nstream\n${imageBytes}\nendstream`,
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(body, 'latin1');
}
