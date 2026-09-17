import path from 'path';
import * as fs from 'fs';
import JSZip from 'jszip';
import yauzl from 'yauzl';
import { EventEmitter } from 'node:events';
import { mayEmbedMedia } from './media';

const fixturesDir = __dirname;
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(fixturesDir, name));

const buildArchive = (entryNames: string[]): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  for (const name of entryNames) {
    zip.file(name, 'binary-ish');
  }
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe('mayEmbedMedia', () => {
  it.each([
    ['a Word picture', 'word/media/image1.png'],
    ['a slide picture', 'ppt/media/image3.jpeg'],
    ['a worksheet picture', 'xl/media/image1.emf'],
    ['an OpenDocument picture', 'Pictures/10000201.png'],
    ['a Word SVG', 'word/media/chart1.svg'],
    ['a slide SVG', 'ppt/media/diagram2.svg'],
    ['an OpenDocument SVG', 'Pictures/figure.svg'],
  ])('reports %s', async (_label, entryName) => {
    expect(await mayEmbedMedia(await buildArchive([entryName]))).toBe(true);
  });

  /**
   * The media directories hold sound and video too, and a deck with a soundtrack has
   * nothing for OCR to read. Escalating on one spends a paid request and replaces the
   * structured local extraction with whatever OCR returns.
   */
  it.each([
    ['a slide video', 'ppt/media/media1.mp4'],
    ['a slide sound', 'ppt/media/audio2.wav'],
    ['an embedded font', 'word/fonts/font1.odttf'],
  ])('ignores %s', async (_label, entryName) => {
    expect(await mayEmbedMedia(await buildArchive([entryName]))).toBe(false);
  });

  it.each([
    ['a Windows metafile, which Office wraps scans in', 'word/media/image1.wmf'],
    ['an enhanced metafile', 'ppt/media/image2.emf'],
  ])('reports %s', async (_label, entryName) => {
    expect(await mayEmbedMedia(await buildArchive([entryName]))).toBe(true);
  });

  it('ignores parts that merely reference artwork', async () => {
    const archive = await buildArchive(['word/document.xml', 'word/_rels/document.xml.rels']);
    expect(await mayEmbedMedia(archive)).toBe(false);
  });

  /**
   * A preview rendering of the document itself carries no text the converter missed,
   * and both Office and ODF write one whenever the "save preview" option is on, so
   * counting it would send a large share of ordinary uploads to a paid OCR service.
   */
  it.each([
    ['an Office thumbnail', 'docProps/thumbnail.jpeg'],
    ['an ODF thumbnail', 'Thumbnails/thumbnail.png'],
  ])('ignores %s', async (_label, entryName) => {
    expect(await mayEmbedMedia(await buildArchive([entryName]))).toBe(false);
  });

  /**
   * EPUB defines no media directory: resources sit wherever the manifest points, so a
   * fixed-path rule sees none of them, and EPUB is in the default OCR MIME list.
   */
  it.each([
    ['an OEBPS image', 'OEBPS/images/page012.jpg'],
    ['an EPUB3 image', 'EPUB/images/cover.png'],
    ['an image at the archive root', 'scan-001.tiff'],
    ['an EPUB SVG', 'OEBPS/images/figure.svg'],
  ])('reports %s', async (_label, entryName) => {
    const archive = await buildArchive(['mimetype', 'META-INF/container.xml', entryName]);
    expect(await mayEmbedMedia(archive)).toBe(true);
  });

  it('reports no media for a text-only EPUB', async () => {
    const archive = await buildArchive([
      'mimetype',
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/chapter1.xhtml',
    ]);
    expect(await mayEmbedMedia(archive)).toBe(false);
  });

  it.each(['structured.docx', 'deck.pptx', 'sample.xlsx', 'sample.odt'])(
    'reports no media for the text-only fixture %s',
    async (name) => {
      expect(await mayEmbedMedia(readFixture(name))).toBe(false);
    },
  );

  /**
   * Legacy Office keeps pictures in Escher records inside an unnamed Compound File
   * stream, so no cheap read separates a scanned page from a document with none. The
   * default has to be the one that cannot silently lose content: these keep reaching a
   * configured OCR service, which is what they did before local parsing existed.
   */
  it('reports media for a legacy Compound File document it cannot inspect', async () => {
    expect(await mayEmbedMedia(readFixture('sample.xls'))).toBe(true);
  });

  it('recognizes a CFB document before a nested ZIP attachment', async () => {
    const attachment = await buildArchive(['attachment.txt']);
    const combined = Buffer.concat([readFixture('sample.xls'), attachment]);

    expect(await mayEmbedMedia(combined)).toBe(true);
  });

  it('reports no media for a format that embeds none', async () => {
    expect(await mayEmbedMedia(Buffer.from('name,value\na,1\n'))).toBe(false);
  });

  /** RTF is plain text, so the picture control word answers it exactly. */
  it.each([
    ['an RTF with a picture', String.raw`{\rtf1\ansi {\pict\pngblip 89504e47}}`, true],
    ['an RTF without one', String.raw`{\rtf1\ansi Hello}`, false],
  ])('reports %s', async (_label, rtf, expected) => {
    expect(await mayEmbedMedia(Buffer.from(rtf))).toBe(expected);
  });

  it('reports no media for a PDF, which the page-accounting parser handles', async () => {
    expect(await mayEmbedMedia(readFixture('sample.pdf'))).toBe(false);
  });

  /** EOCD intact so the tail still reads as an archive, central directory shredded. */
  it('reports no media for a corrupt archive instead of throwing', async () => {
    const archive = await buildArchive(['word/media/image1.png']);
    archive.fill(0, archive.length - 128, archive.length - 22);
    await expect(mayEmbedMedia(archive)).resolves.toBe(false);
  });

  it('cancels an active archive walk and closes the archive', async () => {
    const archive = await buildArchive(['word/document.xml']);
    const controller = new AbortController();
    const reason = new Error('artifact extraction timed out');
    const close = jest.fn();
    const zipfile = Object.assign(new EventEmitter(), {
      close,
      readEntry: jest.fn(),
    }) as unknown as yauzl.ZipFile;
    const fromBuffer = jest
      .spyOn(yauzl, 'fromBuffer')
      /* @types/yauzl types the last overload as `(buffer, callback?)`, which is not the
       * one the implementation calls; the cast keeps the three-argument form the code uses. */
      .mockImplementation(((
        _buffer: Buffer,
        _options: yauzl.Options,
        callback: (error: Error | null, opened: yauzl.ZipFile) => void,
      ) => callback(null, zipfile)) as unknown as typeof yauzl.fromBuffer);

    try {
      const pending = mayEmbedMedia(archive, controller.signal);
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fromBuffer.mockRestore();
    }
  });
});
