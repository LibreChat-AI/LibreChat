import JSZip from 'jszip';

const NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0"',
].join(' ');

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One paragraph, as LibreOffice writes it; an empty string makes an empty paragraph. */
export const paragraph = (text: string): string =>
  text === ''
    ? '<text:p text:style-name="Table_20_Contents"/>'
    : `<text:p text:style-name="Table_20_Contents">${escape(text)}</text:p>`;

/** One paragraph broken onto several lines, as Shift+Enter does in Writer. */
export const lines = (...parts: string[]): string =>
  `<text:p text:style-name="Table_20_Contents">${parts.map(escape).join('<text:line-break/>')}</text:p>`;

/** `attributes` is raw XML, such as `table:number-columns-spanned="2"`. */
export const cell = (content: string, attributes = ''): string =>
  `<table:table-cell table:style-name="Table1.A1" office:value-type="string"${
    attributes ? ` ${attributes}` : ''
  }>${content}</table:table-cell>`;

/** The cell a merge hides, which LibreOffice writes empty after the merged cell. */
export const covered = (content = ''): string =>
  content === ''
    ? '<table:covered-table-cell table:style-name="Table1.A1"/>'
    : `<table:covered-table-cell table:style-name="Table1.A1">${content}</table:covered-table-cell>`;

export const row = (...cells: string[]): string =>
  `<table:table-row>${cells.join('')}</table:table-row>`;

/** A table with the column definition LibreOffice writes before the rows. */
export const table = (...rows: string[]): string =>
  `<table:table table:name="Table1" table:style-name="Table1"><table:table-column table:style-name="Table1.A" table:number-columns-repeated="3"/>${rows.join('')}</table:table>`;

/** A table whose cells each hold one paragraph of the given text. */
export const grid = (...rows: string[][]): string =>
  table(...rows.map((texts) => row(...texts.map((text) => cell(paragraph(text))))));

/** A content.xml whose document body is `body`. */
export const content = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NAMESPACES} office:version="1.3"><office:automatic-styles/><office:body><office:text>${body}</office:text></office:body></office:document-content>`;

/** A package with just enough parts for the .odt reader to find `body`. */
export async function odt(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file('content.xml', content(body));
  zip.file(
    'META-INF/manifest.xml',
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
