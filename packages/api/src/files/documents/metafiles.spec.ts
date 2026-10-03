import JSZip from 'jszip';
import { convertMetafileToSvg } from 'emf-converter';
import { buildEmf, buildWmf, buildEmfWithRecords } from './__tests__/emf.helper';
import {
  extractPptxMetafileSvgs,
  metafileKey,
  METAFILE_KEY_JS,
  withinRecordBudget,
} from './metafiles';

const buildZip = async (files: Record<string, Buffer | string>): Promise<Buffer> => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    zip.file(name, data);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe('metafiles', () => {
  const emf = buildEmf();

  test('fixture converts with emf-converter', async () => {
    const ab = emf.buffer.slice(emf.byteOffset, emf.byteOffset + emf.byteLength);
    const svg = await convertMetafileToSvg(ab as ArrayBuffer, { idPrefix: 'x-' });
    expect(svg).toContain('<svg');
  });

  test('extracts only convertible emf/wmf entries, keyed by base64 hash', async () => {
    const pptx = await buildZip({
      'ppt/media/image1.emf': emf,
      'ppt/media/image2.png': Buffer.from([1, 2, 3]),
      'ppt/media/logo.emf': emf,
      'ppt/media/image3.emf': Buffer.from('garbage bytes that are not an emf'),
    });
    const map = await extractPptxMetafileSvgs(pptx);
    expect(Object.keys(map)).toEqual([metafileKey(emf.toString('base64'))]);
    const value = Object.values(map)[0];
    expect(value.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(
      Buffer.from(value.slice('data:image/svg+xml;base64,'.length), 'base64').toString(),
    ).toContain('<svg');
  });

  test('converts a .wmf entry', async () => {
    const wmf = buildWmf();
    const map = await extractPptxMetafileSvgs(await buildZip({ 'ppt/media/image1.wmf': wmf }));
    expect(Object.keys(map)).toEqual([metafileKey(wmf.toString('base64'))]);
  });

  test('skips a metafile over the record budget without converting it', async () => {
    const hostile = buildEmfWithRecords(10_001);
    const ok = buildEmfWithRecords(100);
    expect(withinRecordBudget(hostile)).toBe(false);
    expect(withinRecordBudget(ok)).toBe(true);
    const started = Date.now();
    const map = await extractPptxMetafileSvgs(
      await buildZip({ 'ppt/media/image1.emf': hostile, 'ppt/media/image2.emf': ok }),
    );
    expect(Object.keys(map)).toEqual([metafileKey(ok.toString('base64'))]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('skips a metafile over the per-file byte cap', async () => {
    const wmf = buildWmf();
    const pptx = await buildZip({
      'ppt/media/image2.wmf': wmf,
      'ppt/media/image9.emf': Buffer.alloc(512 * 1024 + 1),
    });
    const map = await extractPptxMetafileSvgs(pptx);
    expect(Object.keys(map)).toEqual([metafileKey(wmf.toString('base64'))]);
  });

  test('resolves {} for a non-zip buffer', async () => {
    await expect(extractPptxMetafileSvgs(Buffer.from('not a zip'))).resolves.toEqual({});
  });

  test('stops converting once the time budget is spent', async () => {
    const blue = Buffer.from(emf);
    blue.writeInt32LE(0x000000ff, 108 + 16);
    const pptx = await buildZip({ 'ppt/media/image1.emf': emf, 'ppt/media/image2.emf': blue });
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10_000);
    try {
      const map = await extractPptxMetafileSvgs(pptx);
      expect(Object.keys(map)).toEqual([metafileKey(emf.toString('base64'))]);
    } finally {
      now.mockRestore();
    }
  });

  test('METAFILE_KEY_JS matches metafileKey', () => {
    const fn = new Function('return (' + METAFILE_KEY_JS + ')')() as (s: string) => string;
    for (const s of ['', 'abc', Buffer.alloc(52500, 7).toString('base64')]) {
      expect(fn(s)).toBe(metafileKey(s));
    }
  });
});
