import JSZip from 'jszip';

const NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const run = (text: string): string => `<w:r><w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;

/** One paragraph; an empty string makes an empty paragraph. */
export const paragraph = (text: string): string => `<w:p>${run(text)}</w:p>`;

/** One paragraph broken onto several lines, as Shift+Enter does in Word. */
export const lines = (...parts: string[]): string =>
  `<w:p>${parts.map(run).join('<w:r><w:br/></w:r>')}</w:p>`;

/** `properties` is raw `w:tcPr` content, such as `<w:gridSpan w:val="2"/>`. */
export const cell = (content: string, properties = ''): string =>
  `<w:tc>${properties ? `<w:tcPr>${properties}</w:tcPr>` : ''}${content}</w:tc>`;

export const row = (...cells: string[]): string => `<w:tr>${cells.join('')}</w:tr>`;

export const table = (...rows: string[]): string =>
  `<w:tbl><w:tblPr/><w:tblGrid/>${rows.join('')}</w:tbl>`;

/** A table whose cells each hold one paragraph of the given text. */
export const grid = (...rows: string[][]): string =>
  table(...rows.map((texts) => row(...texts.map((text) => cell(paragraph(text))))));

/** A package with just enough parts for mammoth to read `body`, plus optional footnotes. */
export async function docx(body: string, notes?: string): Promise<Buffer> {
  const zip = new JSZip();
  const part = (name: string, content: string): void => {
    zip.file(name, `<?xml version="1.0" encoding="UTF-8"?>${content}`);
  };
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  part(
    '[Content_Types].xml',
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="${TYPE}.document.main+xml"/>` +
      (notes
        ? `<Override PartName="/word/footnotes.xml" ContentType="${TYPE}.footnotes+xml"/>`
        : '') +
      `</Types>`,
  );
  part(
    '_rels/.rels',
    `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  part(
    'word/_rels/document.xml.rels',
    `<Relationships xmlns="${rels}">` +
      (notes ? `<Relationship Id="rId2" Type="${REL}/footnotes" Target="footnotes.xml"/>` : '') +
      `</Relationships>`,
  );
  part(
    'word/document.xml',
    `<w:document xmlns:w="${NAMESPACE}"><w:body>${body}</w:body></w:document>`,
  );
  if (notes) {
    part(
      'word/footnotes.xml',
      `<w:footnotes xmlns:w="${NAMESPACE}"><w:footnote w:id="2">${paragraph(notes)}</w:footnote></w:footnotes>`,
    );
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** A paragraph that cites the footnote `docx()` writes when given `notes`. */
export const cite = (text: string): string =>
  `<w:p>${run(text)}<w:r><w:footnoteReference w:id="2"/></w:r></w:p>`;
