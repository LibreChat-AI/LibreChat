import path from 'path';
import * as fs from 'fs';
import JSZip from 'jszip';
import { logger } from '@librechat/data-schemas';
import { megabyte } from 'librechat-data-provider';
import type { DocumentExtractionOptions } from '../documents/nativeProcess';
import type { ParsedDocumentUploadResult } from '~/types';
import { parseWithAnydoc } from './crud';

type ParseResult = Promise<ParsedDocumentUploadResult>;
type TestExtractionOptions = DocumentExtractionOptions & { fileLabel?: string };
type ParseFile = (
  file: Partial<Express.Multer.File>,
  signal?: AbortSignal,
  options?: TestExtractionOptions,
) => ParseResult;

/** Fixtures are shared with the built-in parser suite and live alongside it. */
const fixtures = path.join(__dirname, '..', 'documents');

const parse: ParseFile = (file, signal, options) =>
  parseWithAnydoc(file as Express.Multer.File, signal, options);

const docxFile = (name: string): Partial<Express.Multer.File> => ({
  originalname: name,
  path: path.join(fixtures, name),
  mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

const pdfFile = (name: string): Partial<Express.Multer.File> => ({
  originalname: name,
  path: path.join(fixtures, name),
  mimetype: 'application/pdf',
});

/**
 * Runs `body` with the isolated parser stubbed by a spy, in a scoped module registry.
 * Format detection stays real, so the spy exercises the same routing production does.
 * The finally is load-bearing: `doMock` outlives `isolateModulesAsync`, so a failing
 * assertion would otherwise leak the stub into every later test.
 */
const withAnydocSpy = async (
  extractMarkdown: jest.Mock,
  body: (run: ParseFile) => Promise<void>,
): Promise<void> => {
  try {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('./native', () => ({ extractMarkdownIsolated: extractMarkdown }));
      const { parseWithAnydoc: parseWithSpy } = await import('./crud');
      await body((file, signal, options) =>
        parseWithSpy(file as Express.Multer.File, signal, options),
      );
    });
  } finally {
    jest.dontMock('./native');
  }
};

describe('parseWithAnydoc', () => {
  test('converts an office document to Markdown', async () => {
    const result = await parse(docxFile('structured.docx'));

    expect(result.filename).toBe('structured.docx');
    expect(result.filepath).toBe('anydoc');
    expect(result.images).toEqual([]);
    expect(result.bytes).toBe(Buffer.byteLength(result.text, 'utf8'));
    expect(result.text).toContain('# Quarterly Report');
    expect(result.text).toContain('| Region | Units | Revenue |');
  });

  test('converts a legacy .xls workbook, which is not a zip archive', async () => {
    const result = await parse({
      originalname: 'sample.xls',
      path: path.join(fixtures, 'sample.xls'),
      mimetype: 'application/vnd.ms-excel',
    });

    expect(result.text).toContain('Data');
  });

  test('never reports pagesNeedingOcr, which anydoc cannot produce', async () => {
    const result = await parse(docxFile('structured.docx'));

    expect(result.pagesNeedingOcr).toBeUndefined();
  });

  /**
   * anydoc converts artwork to nothing, so a document whose content is a scanned page
   * comes back looking as complete as one with no images at all. This flag is what the
   * upload path escalates on, and it is only meaningful if a text-only document stays
   * silent: reporting it everywhere would send every office upload to a paid OCR
   * service.
   */
  describe('embedded media reporting', () => {
    test('reports nothing for a document with no artwork', async () => {
      const result = await parse(docxFile('structured.docx'));

      expect(result.mayOmitContent).toBeUndefined();
    });

    test('reports media a document embeds', async () => {
      const zip = await JSZip.loadAsync(
        await fs.promises.readFile(path.join(fixtures, 'structured.docx')),
      );
      zip.file('word/media/image1.png', Buffer.from('not really a png'));
      const withMediaPath = path.join(fixtures, 'anydoc-with-media.docx');
      await fs.promises.writeFile(withMediaPath, await zip.generateAsync({ type: 'nodebuffer' }));

      try {
        const result = await parse({
          originalname: 'anydoc-with-media.docx',
          path: withMediaPath,
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        expect(result.mayOmitContent).toBe(true);
        expect(result.text).toContain('# Quarterly Report');
      } finally {
        await fs.promises.unlink(withMediaPath);
      }
    });
  });

  /**
   * A declared type that names a format anydoc supports describes the bytes; an
   * extension only describes what the file was called. Reading the extension first meant
   * DOCX bytes renamed `report.csv` went to the CSV reader, and the same bytes named
   * `.pdf` were refused as another engine's problem.
   */
  describe('format resolution', () => {
    test('reads a supported MIME type over a conflicting extension', async () => {
      const toMarkdownBytes = jest.fn().mockResolvedValue('# Quarterly Report');

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await run({
          originalname: 'report.csv',
          path: path.join(fixtures, 'structured.docx'),
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        expect(toMarkdownBytes.mock.calls[0]?.[1]).toBe('docx');
      });
    });

    test('accepts a supported MIME type on a file named like a PDF', async () => {
      const toMarkdownBytes = jest.fn().mockResolvedValue('# Quarterly Report');

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        const result = await run({
          originalname: 'report.pdf',
          path: path.join(fixtures, 'structured.docx'),
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        expect(result.text).toBe('# Quarterly Report');
        expect(toMarkdownBytes.mock.calls[0]?.[1]).toBe('docx');
      });
    });

    test('still refuses a PDF that nothing else identifies as an anydoc format', async () => {
      const toMarkdownBytes = jest.fn();

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await expect(
          run({
            originalname: 'paper.pdf',
            path: path.join(fixtures, 'sample.pdf'),
            mimetype: 'application/octet-stream',
          }),
        ).rejects.toThrow(/handled by pdf-inspector/);
        expect(toMarkdownBytes).not.toHaveBeenCalled();
      });
    });

    test('falls back to the extension when the type says nothing useful', async () => {
      const toMarkdownBytes = jest.fn().mockResolvedValue('# Quarterly Report');

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await run({
          originalname: 'structured.docx',
          path: path.join(fixtures, 'structured.docx'),
          mimetype: 'application/octet-stream',
        });

        expect(toMarkdownBytes.mock.calls[0]?.[1]).toBe('docx');
      });
    });

    test('redacts the filename from fallback warnings while preserving the caller label', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      const originalname = 'secret-payroll.docx';
      const file = {
        ...docxFile('structured.docx'),
        mimetype: 'application/octet-stream',
      };

      try {
        const labeledResult = await parse(file, undefined, { fileLabel: 'file_id=opaque-123' });
        const labeledWarnings = warn.mock.calls.map(([message]) => String(message));

        expect(labeledResult.text).toContain('# Quarterly Report');
        expect(labeledWarnings).toEqual(
          expect.arrayContaining([expect.stringContaining('file_id=opaque-123')]),
        );
        expect(labeledWarnings.join('\n')).not.toContain(originalname);

        warn.mockClear();
        const unlabeledResult = await parse(file);
        const unlabeledWarnings = warn.mock.calls.map(([message]) => String(message));

        expect(unlabeledResult.text).toContain('# Quarterly Report');
        expect(unlabeledWarnings).toEqual(
          expect.arrayContaining([expect.stringContaining('uploaded document')]),
        );
        expect(unlabeledWarnings.join('\n')).not.toContain(originalname);
        expect(unlabeledWarnings.join('\n')).not.toContain('file_id=opaque-123');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('zip decompression guard', () => {
    test('rejects a zip bomb without handing it to anydoc', async () => {
      /* anydoc applies no decompression cap of its own: measured on this fixture it
       * returns 80MB of Markdown at ~400MB RSS from 158KB on disk. Asserting only that
       * the upload rejects would pass even if anydoc had already inflated the file.
       * What has to hold is that anydoc is never handed the bytes at all. */
      const toMarkdownBytes = jest.fn();

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await expect(run(docxFile('bomb.docx'))).rejects.toThrow(
          /exceeds the 25MB per-entry decompressed cap/,
        );
        expect(toMarkdownBytes).not.toHaveBeenCalled();
      });
    });

    test('accepts an oversized archive entry when the configured ceiling is raised', async () => {
      const zip = await JSZip.loadAsync(
        await fs.promises.readFile(path.join(fixtures, 'structured.docx')),
      );
      zip.file('word/media/large.png', Buffer.alloc(26 * megabyte));
      const oversizedPath = path.join(fixtures, 'anydoc-large-entry.docx');
      await fs.promises.writeFile(oversizedPath, await zip.generateAsync({ type: 'nodebuffer' }));

      try {
        const file = {
          originalname: 'anydoc-large-entry.docx',
          path: oversizedPath,
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        } as Express.Multer.File;
        await expect(parseWithAnydoc(file)).rejects.toThrow(
          /exceeds the 25MB per-entry decompressed cap/,
        );
        await expect(
          parseWithAnydoc(file, undefined, { archiveEntrySizeLimit: 30 * megabyte }),
        ).resolves.toEqual(expect.objectContaining({ filepath: 'anydoc' }));
      } finally {
        await fs.promises.unlink(oversizedPath);
      }
    });

    test('rejects a zip bomb padded with junk bytes ahead of the archive', async () => {
      /* The bypass a leading-magic-byte check cannot see. anydoc's zip reader finds the
       * central directory from the tail and tolerates prepended data, exactly as
       * self-extracting archives rely on, so eight junk bytes made a magic-byte guard
       * report "not a zip" while anydoc still inflated 162KB into 80MB of Markdown at
       * ~336MB RSS. Detection scans the tail, and because yauzl does not compensate for
       * the offset shift, the refusal surfaces as a malformed central directory rather
       * than the cap message. Either way it must not reach the parser. */
      const bomb = await fs.promises.readFile(path.join(fixtures, 'bomb.docx'));
      const paddedPath = path.join(fixtures, 'anydoc-bomb-padded.docx');
      await fs.promises.writeFile(paddedPath, Buffer.concat([Buffer.from('JUNKJUNK'), bomb]));

      const toMarkdownBytes = jest.fn();
      try {
        await withAnydocSpy(toMarkdownBytes, async (run) => {
          await expect(
            run({
              originalname: 'anydoc-bomb-padded.docx',
              path: paddedPath,
              mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            }),
          ).rejects.toThrow(/central directory/i);
          expect(toMarkdownBytes).not.toHaveBeenCalled();
        });
      } finally {
        await fs.promises.unlink(paddedPath);
      }
    });

    /* An archive can be refused for how many entries it holds rather than how much they
     * inflate to, and a deck with per-slide notes, rels and media climbs that count. */
    test('accepts an entry-heavy archive when the configured count ceiling is raised', async () => {
      const zip = await JSZip.loadAsync(
        await fs.promises.readFile(path.join(fixtures, 'structured.docx')),
      );
      for (let index = 0; index < 64; index += 1) {
        zip.file(`word/media/part${index}.bin`, 'x');
      }
      const entryHeavyPath = path.join(fixtures, 'anydoc-entry-heavy.docx');
      await fs.promises.writeFile(entryHeavyPath, await zip.generateAsync({ type: 'nodebuffer' }));

      try {
        const file = {
          originalname: 'anydoc-entry-heavy.docx',
          path: entryHeavyPath,
          mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        } as Express.Multer.File;
        await expect(
          parseWithAnydoc(file, undefined, { archiveEntryCountLimit: 16 }),
        ).rejects.toThrow(/entry count \(\d+\) exceeds the 16-entry cap/);
        await expect(
          parseWithAnydoc(file, undefined, { archiveEntryCountLimit: 256 }),
        ).resolves.toEqual(expect.objectContaining({ filepath: 'anydoc' }));
      } finally {
        await fs.promises.unlink(entryHeavyPath);
      }
    });

    test('hands a safe document to anydoc', async () => {
      /* The counterpart to the bomb cases: proves the spy above would have fired, so
       * "not called" there is a real guarantee and not a broken mock. */
      const toMarkdownBytes = jest.fn().mockResolvedValue('# stubbed');

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        const result = await run(docxFile('structured.docx'));

        expect(toMarkdownBytes).toHaveBeenCalledTimes(1);
        expect(result.text).toBe('# stubbed');
        expect(result.filepath).toBe('anydoc');
      });
    });

    test('hands a CFB document with a nested ZIP attachment to anydoc', async () => {
      const attachment = new JSZip();
      attachment.file('attachment.txt', 'nested');
      const combinedPath = path.join(fixtures, 'anydoc-cfb-with-attachment.xls');
      await fs.promises.writeFile(
        combinedPath,
        Buffer.concat([
          await fs.promises.readFile(path.join(fixtures, 'sample.xls')),
          await attachment.generateAsync({ type: 'nodebuffer' }),
        ]),
      );

      const toMarkdownBytes = jest.fn().mockResolvedValue('# Legacy workbook');
      try {
        await withAnydocSpy(toMarkdownBytes, async (run) => {
          const result = await run({
            originalname: 'workbook.xls',
            path: combinedPath,
            mimetype: 'application/vnd.ms-excel',
          });

          expect(toMarkdownBytes).toHaveBeenCalledTimes(1);
          expect(result.mayOmitContent).toBe(true);
        });
      } finally {
        await fs.promises.unlink(combinedPath);
      }
    });

    test('hands an RTF document with a nested ZIP attachment to anydoc', async () => {
      const attachment = new JSZip();
      attachment.file('attachment.txt', 'nested');
      const attachmentBuffer = await attachment.generateAsync({ type: 'nodebuffer' });
      const combinedPath = path.join(fixtures, 'anydoc-rtf-with-attachment.rtf');
      await fs.promises.writeFile(
        combinedPath,
        Buffer.concat([
          Buffer.from(String.raw`{\rtf1\ansi{\object\objdata\bin${attachmentBuffer.length} `),
          attachmentBuffer,
          Buffer.from('}}'),
        ]),
      );

      const toMarkdownBytes = jest.fn().mockResolvedValue('# RTF document');
      try {
        await withAnydocSpy(toMarkdownBytes, async (run) => {
          const result = await run({
            originalname: 'notes.rtf',
            path: combinedPath,
            mimetype: 'application/rtf',
          });

          expect(toMarkdownBytes.mock.calls[0]?.[1]).toBe('rtf');
          expect(result.text).toBe('# RTF document');
        });
      } finally {
        await fs.promises.unlink(combinedPath);
      }
    });

    /**
     * The upload route stages a document under its sanitized filename, so two concurrent
     * uploads of the same name share one path. The guard reads the buffer in memory and
     * the child reads a path, so without a private copy the second request's bytes would
     * be what anydoc converts and what gets persisted — the bytes this guard never saw.
     */
    test('parses the bytes the guard validated, not whatever replaced them', async () => {
      const stagedPath = path.join(fixtures, 'anydoc-staged-collision.docx');
      const validated = await fs.promises.readFile(path.join(fixtures, 'structured.docx'));
      await fs.promises.writeFile(stagedPath, validated);

      let parsedBytes: Buffer | undefined;
      const toMarkdownBytes = jest.fn(async (handedPath: string) => {
        /* A concurrent upload of the same filename, landing between validation and the
         * child's read. */
        await fs.promises.writeFile(stagedPath, Buffer.from('replaced by another upload'));
        parsedBytes = await fs.promises.readFile(handedPath);
        return '# Quarterly Report';
      });

      try {
        await withAnydocSpy(toMarkdownBytes, async (run) => {
          const result = await run({
            originalname: 'structured.docx',
            path: stagedPath,
            mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          });

          expect(result.text).toBe('# Quarterly Report');
          expect(parsedBytes?.equals(validated)).toBe(true);
        });
      } finally {
        await fs.promises.unlink(stagedPath);
      }
    });

    test('cancels before native extraction when the caller already stopped waiting', async () => {
      const toMarkdownBytes = jest.fn();
      const controller = new AbortController();
      const reason = new Error('artifact extraction timed out');
      controller.abort(reason);

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await expect(run(docxFile('structured.docx'), controller.signal)).rejects.toMatchObject({
          name: 'AbortError',
          code: 'ABORT_ERR',
        });
        expect(toMarkdownBytes).not.toHaveBeenCalled();
      });
    });

    test('does not let an RTF extension override a declared OOXML container', async () => {
      const disguisedPath = path.join(fixtures, 'anydoc-disguised-bomb.rtf');
      await fs.promises.copyFile(path.join(fixtures, 'bomb.docx'), disguisedPath);

      const toMarkdownBytes = jest.fn();
      try {
        await withAnydocSpy(toMarkdownBytes, async (run) => {
          await expect(
            run({
              originalname: 'disguised.rtf',
              path: disguisedPath,
              mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            }),
          ).rejects.toMatchObject({ code: 'ZIP_BOMB' });
          expect(toMarkdownBytes).not.toHaveBeenCalled();
        });
      } finally {
        await fs.promises.unlink(disguisedPath);
      }
    });

    test('does not let a legacy extension override a declared OOXML container', async () => {
      const combinedPath = path.join(fixtures, 'anydoc-cfb-prefixed-bomb.xls');
      await fs.promises.writeFile(
        combinedPath,
        Buffer.concat([
          await fs.promises.readFile(path.join(fixtures, 'sample.xls')),
          await fs.promises.readFile(path.join(fixtures, 'bomb.docx')),
        ]),
      );

      const toMarkdownBytes = jest.fn();
      try {
        await withAnydocSpy(toMarkdownBytes, async (run) => {
          await expect(
            run({
              originalname: 'disguised.xls',
              path: combinedPath,
              mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            }),
          ).rejects.toMatchObject({
            code: expect.stringMatching(/^(?:ZIP_BOMB|ARCHIVE_INVALID)$/),
          });
          expect(toMarkdownBytes).not.toHaveBeenCalled();
        });
      } finally {
        await fs.promises.unlink(combinedPath);
      }
    });
  });

  describe('declared format support', () => {
    test('rejects an unsupported type before reading the file', async () => {
      const toMarkdownBytes = jest.fn();

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await expect(
          run({
            originalname: 'notes.txt',
            path: path.join(fixtures, 'does-not-exist.txt'),
            mimetype: 'text/plain',
          }),
        ).rejects.toThrow(/Unsupported file type in the anydoc parser: "text\/plain"/);
        expect(toMarkdownBytes).not.toHaveBeenCalled();
      });
    });

    test('ignores MIME type parameters when matching the declared table', async () => {
      const result = await parse({
        ...docxFile('structured.docx'),
        mimetype:
          'Application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=binary',
      });

      expect(result.text).toContain('# Quarterly Report');
    });

    test('attempts a generic MIME type whose extension anydoc recognizes', async () => {
      /* Browsers routinely send application/octet-stream for ordinary office documents,
       * so the extension alone is enough to try, with the uncertainty logged. */
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      const result = await parse({
        ...docxFile('structured.docx'),
        mimetype: 'application/octet-stream',
      });

      expect(result.text).toContain('# Quarterly Report');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('application/octet-stream'));
    });

    test('attempts a declared MIME type whose filename has no usable extension', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      const result = await parse({
        originalname: 'structured',
        path: path.join(fixtures, 'structured.docx'),
        mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      expect(result.text).toContain('# Quarterly Report');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('content detection'));
    });

    test('accepts the macro-enabled slideshow MIME type without an extension', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

      const result = await parse({
        originalname: 'slides',
        path: path.join(fixtures, 'deck.pptx'),
        mimetype: 'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
      });

      expect(result.text).toContain('Quarterly Highlights');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('content detection'));
    });

    test('accepts every declared legacy Excel MIME alias without an extension', async () => {
      const aliases = [
        'application/msexcel',
        'application/x-msexcel',
        'application/x-ms-excel',
        'application/x-excel',
        'application/x-dos_ms_excel',
        'application/xls',
        'application/x-xls',
      ];
      const toMarkdownBytes = jest.fn().mockResolvedValue('# Legacy spreadsheet');

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        for (const mimetype of aliases) {
          const result = await run({
            originalname: 'legacy-sheet',
            path: path.join(fixtures, 'sample.xls'),
            mimetype,
          });

          expect(result.text).toBe('# Legacy spreadsheet');
        }
      });

      expect(toMarkdownBytes).toHaveBeenCalledTimes(aliases.length);
    });
  });

  describe('PDF routing boundary', () => {
    test('refuses PDFs so the page-aware pdf-inspector path is always used', async () => {
      const toMarkdownBytes = jest.fn();

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await expect(run(pdfFile('sample.pdf'))).rejects.toThrow(
          /PDF files are handled by pdf-inspector, not anydoc/,
        );
        expect(toMarkdownBytes).not.toHaveBeenCalled();
      });
    });
  });

  describe('empty output', () => {
    test('throws a provider-named error instead of returning empty text', async () => {
      /* anydoc can succeed and still produce nothing. The shared parser's fallback
       * chain owns what happens next, so this provider only has to say it failed. */
      const toMarkdownBytes = jest.fn().mockResolvedValue('   ');

      await withAnydocSpy(toMarkdownBytes, async (run) => {
        await expect(run(docxFile('structured.docx'))).rejects.toThrow(
          /anydoc extracted no text from "structured\.docx"/,
        );
        expect(toMarkdownBytes).toHaveBeenCalledTimes(1);
      });
    });
  });
});
