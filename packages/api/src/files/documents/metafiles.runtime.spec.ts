import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import { pptxToHtml } from './html';
import { buildEmf } from './__tests__/emf.helper';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const buildPptx = async (withEmf: boolean): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:sld>',
  );
  if (withEmf) {
    zip.file('ppt/media/image1.emf', buildEmf());
  }
  return zip.generateAsync({ type: 'nodebuffer' });
};

/**
 * Loads the generated iframe document into jsdom with a fake `pptxPreview`
 * that mimics pptx-preview's metafile output, and resolves once the
 * bootstrap's finalize() has wrapped the slides.
 */
const doms: JSDOM[] = [];

async function runIframe(html: string): Promise<Document> {
  const emfB64 = buildEmf().toString('base64');
  const doc = html.replace(/<script[^>]*src=[^>]*><\/script>/g, '');
  const dom = new JSDOM(doc, {
    runScripts: 'dangerously',
    beforeParse(window) {
      (window as unknown as Record<string, unknown>).pptxPreview = {
        init: (container: HTMLElement) => ({
          preview: async () => {
            const wrapper = window.document.createElement('div');
            wrapper.className = 'pptx-preview-slide-wrapper';
            wrapper.innerHTML =
              `<img id="emf" src="data:image/x-emf;base64,${emfB64}">` +
              `<img id="png" src="${PNG}">`;
            container.appendChild(wrapper);
            return { slides: [{}] };
          },
        }),
      };
    },
  });
  doms.push(dom);
  const { document } = dom.window;
  for (let i = 0; i < 100 && !document.querySelector('.lc-slide-wrap'); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(document.querySelector('.lc-slide-wrap')).not.toBeNull();
  return document;
}

describe('pptx iframe metafile swap (runtime)', () => {
  /* closing the window clears the bootstrap's 8s safety-net timer */
  afterEach(() => doms.splice(0).forEach((d) => d.window.close()));

  test('replaces the x-emf img src with the converted SVG and leaves other images alone', async () => {
    const html = await pptxToHtml(await buildPptx(true));
    expect(html).toContain('id="lc-metafiles"');
    const document = await runIframe(html);
    expect(document.getElementById('emf')?.getAttribute('src')).toMatch(
      /^data:image\/svg\+xml;base64,/,
    );
    expect(document.getElementById('png')?.getAttribute('src')).toBe(PNG);
    expect(document.getElementById('lc-fallback')?.hasAttribute('hidden')).toBe(true);
  });

  test('without a metafile map the emf src is unchanged and the fallback stays hidden', async () => {
    const html = await pptxToHtml(await buildPptx(false));
    expect(html).not.toContain('id="lc-metafiles"');
    const document = await runIframe(html);
    expect(document.getElementById('emf')?.getAttribute('src')).toMatch(
      /^data:image\/x-emf;base64,/,
    );
    expect(document.getElementById('png')?.getAttribute('src')).toBe(PNG);
    expect(document.getElementById('lc-fallback')?.hasAttribute('hidden')).toBe(true);
  });
});
