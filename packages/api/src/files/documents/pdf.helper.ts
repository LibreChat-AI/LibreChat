import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseDocument } from './crud';

export interface PdfExtractionResult {
  name: string;
  pages: number;
  text?: string;
  bytes?: number;
  error?: string;
}

/** Small, valid PDFs with distinct text on every page and an optional nested page tree. */
function createPdf(name: string, pages: number, depth = 0): Buffer {
  const objects = [
    '',
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: string[] = [];
  for (let page = 1; page <= pages; page++) {
    const index = objects.length;
    const text = name === 'blank' ? '' : `Document ${name} page ${page}`;
    const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    kids.push(`${index} 0 R`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${index + 1} 0 R >>`,
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`;
  if (depth > 0) {
    const start = objects.length;
    objects[2] = `<< /Type /Pages /Kids [${start} 0 R] /Count ${pages} >>`;
    for (let i = 0; i < depth; i++) {
      const parent = i === 0 ? 2 : start + i - 1;
      const children = i === depth - 1 ? kids.join(' ') : `${start + i + 1} 0 R`;
      objects.push(`<< /Type /Pages /Parent ${parent} 0 R /Kids [${children}] /Count ${pages} >>`);
    }
    for (let i = 4; i < start; i += 2) {
      objects[i] = objects[i].replace('/Parent 2 0 R', `/Parent ${start + depth - 1} 0 R`);
    }
  }
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const startXref = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function main(): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-extraction-'));
  try {
    const files = await Promise.all(
      [27, 18, 5, 2].map(async (pages, index) => {
        const name = String(index);
        const filePath = path.join(directory, `${name}.pdf`);
        // Deeper page lookup lets the short PDF finish loading during the other extractions.
        await fs.writeFile(filePath, createPdf(name, pages, index === 3 ? 20 : 0));
        return { name, pages, path: filePath };
      }),
    );
    const extract = async (file: (typeof files)[number]): Promise<PdfExtractionResult> => {
      try {
        const result = await parseDocument({
          file: {
            path: file.path,
            originalname: `${file.name}.pdf`,
            mimetype: 'application/pdf',
          } as Express.Multer.File,
        });
        return { name: file.name, pages: file.pages, text: result.text, bytes: result.bytes };
      } catch (error) {
        return {
          name: file.name,
          pages: file.pages,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };
    const results: PdfExtractionResult[] = [];
    if (process.argv[2] === 'errors') {
      for (const name of ['blank', 'invalid', 'oversized']) {
        const filePath = path.join(directory, `${name}.pdf`);
        await fs.writeFile(filePath, name === 'invalid' ? 'not a PDF' : createPdf('blank', 1));
        try {
          await parseDocument({
            file: {
              path: filePath,
              originalname: `${name}.pdf`,
              mimetype: 'application/pdf',
              ...(name === 'oversized' ? { size: 15 * 1024 * 1024 + 1 } : {}),
            } as Express.Multer.File,
          });
          results.push({ name, pages: 1 });
        } catch (error) {
          results.push({
            name,
            pages: 1,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } else if (process.argv[2] === 'serial') {
      for (const file of files) results.push(await extract(file));
    } else {
      // Warm the native ESM module and worker before exercising overlapping document loads.
      await extract(files[0]);
      const readFile = fs.readFile;
      const paths = new Set(files.map((file) => file.path));
      const waiting: Array<() => void> = [];
      // Release real file reads together so filesystem scheduling cannot serialize PDF loading.
      fs.readFile = ((...args: Parameters<typeof fs.readFile>) => {
        const read = readFile(...args);
        if (!paths.has(String(args[0]))) return read;
        return read.then(async (data) => {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            if (waiting.length === files.length) {
              for (const release of waiting.splice(0)) release();
            }
          });
          return data;
        });
      }) as typeof fs.readFile;
      try {
        for (let round = 0; round < 5; round++) {
          results.push(...(await Promise.all(files.map(extract))));
        }
      } finally {
        fs.readFile = readFile;
      }
    }
    process.send?.(results);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});
