import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

const UPLOADS_ROOT = process.env.UPLOADS_ROOT || '/app/uploads';
const IMAGES_ROOT = process.env.IMAGES_ROOT || '/app/client/public/images';
const GENERATED_ROOT = process.env.GENERATED_ROOT || '/app/generated_files';

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.xml', '.html', '.htm', '.css', '.js', '.ts',
  '.py', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.env',
  '.csv', '.tsv', '.sh', '.bash', '.zsh', '.fish', '.sql',
]);

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
]);

function resolvePath(filepath) {
  if (filepath.startsWith('/app/')) {
    return filepath;
  }
  if (filepath.startsWith('/uploads/')) {
    return path.join(UPLOADS_ROOT, filepath.replace('/uploads/', ''));
  }
  if (filepath.startsWith('/images/')) {
    return path.join(IMAGES_ROOT, filepath.replace('/images/', ''));
  }
  if (filepath.startsWith('/')) {
    return filepath;
  }
  return path.join(GENERATED_ROOT, filepath);
}

function detectType(filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.pdf') {
    return 'pdf';
  }
  if (ext === '.docx') {
    return 'docx';
  }
  if (['.xlsx', '.xls', '.ods'].includes(ext)) {
    return 'spreadsheet';
  }
  if (ext === '.odt') {
    return 'odt';
  }
  if (ext === '.pptx') {
    return 'pptx';
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return 'text';
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return 'image';
  }

  return 'unknown';
}

async function readPdfText(filepath) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(filepath));
  const pdf = await getDocument({ data }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .filter((item) => !('type' in item))
      .map((item) => item.str)
      .join(' ');
    pages.push(pageText);
  }

  return pages.join('\n\n');
}

async function readPdfAsImages(filepath) {
  const sharp = (await import('sharp')).default;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-pages-'));

  try {
    execSync(`pdftoppm -png -r 120 "${filepath}" "${tmpDir}/page"`, { timeout: 120000 });

    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('page-') && f.endsWith('.png'))
      .sort((a, b) => {
        const na = parseInt(a.match(/-(\d+)/)?.[1] || '0', 10);
        const nb = parseInt(b.match(/-(\d+)/)?.[1] || '0', 10);
        return na - nb;
      });

    const images = [];
    for (const file of files) {
      const imgPath = path.join(tmpDir, file);
      const buffer = await sharp(imgPath)
        .resize(1200, null, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
      images.push({
        data: buffer.toString('base64'),
        mimeType: 'image/jpeg',
      });
    }

    return images;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function readDocxText(filepath) {
  const { extractRawText } = await import('mammoth');
  const buffer = fs.readFileSync(filepath);
  const result = await extractRawText({ buffer });
  return result.value;
}

async function readSpreadsheetText(filepath) {
  const { read, utils } = await import('xlsx');
  const data = fs.readFileSync(filepath);
  const workbook = read(data, { type: 'buffer' });

  const sheets = [];
  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    const csv = utils.sheet_to_csv(worksheet);
    sheets.push(`## ${sheetName}\n\`\`\`csv\n${csv}\n\`\`\``);
  }

  return sheets.join('\n\n');
}

async function readOdtText(filepath) {
  const yauzl = await import('yauzl');
  const xml = await new Promise((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        return reject(err);
      }
      if (!zipfile) {
        return reject(new Error('Failed to open ODT file'));
      }

      let settled = false;
      const finish = (error, result) => {
        if (settled) {
          return;
        }
        settled = true;
        zipfile.close();
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      };

      let found = false;
      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        if (entry.fileName !== 'content.xml') {
          zipfile.readEntry();
          return;
        }
        found = true;
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            return finish(streamErr);
          }
          if (!readStream) {
            return finish(new Error('Failed to open content.xml stream'));
          }

          const chunks = [];
          readStream.on('data', (chunk) => chunks.push(chunk));
          readStream.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
          readStream.on('error', (readErr) => finish(readErr));
        });
      });

      zipfile.on('end', () => {
        if (!found) {
          finish(new Error('ODT file is missing content.xml'));
        }
      });
      zipfile.on('error', (zipErr) => finish(zipErr));
    });
  });

  const bodyMatch = xml.match(/<office:body[^>]*>([\s\S]*?)<\/office:body>/);
  if (!bodyMatch) {
    return '';
  }

  return bodyMatch[1]
    .replace(/<\/text:p>/g, '\n')
    .replace(/<\/text:h>/g, '\n')
    .replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:tab\/>/g, '\t')
    .replace(/<text:s[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readPptxText(filepath) {
  const yauzl = await import('yauzl');

  const slides = await new Promise((resolve, reject) => {
    yauzl.open(filepath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        return reject(err);
      }
      if (!zipfile) {
        return reject(new Error('Failed to open PPTX file'));
      }

      const slideXmls = [];
      let settled = false;

      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        zipfile.close();
        if (error) {
          reject(error);
        } else {
          slideXmls.sort((a, b) => a.number - b.number);
          resolve(slideXmls);
        }
      };

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        const match = entry.fileName.match(/^ppt\/slides\/slide(\d+)\.xml$/);
        if (!match) {
          zipfile.readEntry();
          return;
        }
        const slideNum = parseInt(match[1], 10);

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) {
            return finish(streamErr);
          }
          if (!readStream) {
            zipfile.readEntry();
            return;
          }

          const chunks = [];
          readStream.on('data', (chunk) => chunks.push(chunk));
          readStream.on('end', () => {
            slideXmls.push({ number: slideNum, xml: Buffer.concat(chunks).toString('utf8') });
            zipfile.readEntry();
          });
          readStream.on('error', (readErr) => finish(readErr));
        });
      });

      zipfile.on('end', () => finish(null));
      zipfile.on('error', (zipErr) => finish(zipErr));
    });
  });

  const lines = [];
  for (const slide of slides) {
    const xml = slide.xml;
    const textMatches = xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) || [];
    const texts = textMatches.map((m) => m.replace(/<\/?a:t[^>]*>/g, '')).filter(Boolean);
    if (texts.length > 0) {
      lines.push(`## Slide ${slide.number}\n${texts.join('\n')}`);
    }
  }

  return lines.join('\n\n');
}

async function readImageBase64(filepath) {
  const buffer = fs.readFileSync(filepath);
  const ext = path.extname(filepath).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';
  const base64 = buffer.toString('base64');
  return { base64, mimeType };
}

function readTextFile(filepath) {
  return fs.readFileSync(filepath, 'utf-8');
}

const server = new Server(
  { name: 'file-reader', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'extract_content',
        description: 'Extracts content from a file. Supports PDF (text or rendered images at reduced size), DOCX, XLSX, ODT, PPTX, images (base64), and plain text. Use this to read documents that the model cannot parse natively. For image-based/scanned PDFs, pages are rendered as compressed JPEG images (1200px, 60% quality).',
        inputSchema: {
          type: 'object',
          properties: {
            filepath: {
              type: 'string',
              description: 'Path to the file. Can be an absolute path, a relative path (looked up in generated_files), or a LibreChat filepath like /uploads/userid/file.pdf or /images/userid/photo.png.',
            },
          },
          required: ['filepath'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'extract_content') {
      const { filepath } = args;

      if (!filepath) {
        return {
          content: [{ type: 'text', text: 'Error: filepath is required' }],
          isError: true,
        };
      }

      const resolvedPath = resolvePath(filepath);
      const filename = path.basename(filepath);
      const type = detectType(filename);

      if (!fs.existsSync(resolvedPath)) {
        return {
          content: [{
            type: 'text',
            text: `Error: File not found at ${resolvedPath} (original: ${filepath})`,
          }],
          isError: true,
        };
      }

      let content;

      switch (type) {
      case 'pdf': {
        const text = await readPdfText(resolvedPath);

        if (text.trim().length > 100) {
          content = [{
            type: 'text',
            text: `[PDF: ${filename}]\n\n${text}`,
          }];
        } else {
          try {
            const images = await readPdfAsImages(resolvedPath);
            content = images.map(img => ({
              type: 'image',
              data: img.data,
              mimeType: img.mimeType,
            }));
            content.push({
              type: 'text',
              text: `[PDF: ${filename}] ${images.length} page(s) rendered as images (1200px, JPEG 60%).`,
            });
          } catch (imgErr) {
            console.error('PDF image rendering failed:', imgErr);
            content = [{
              type: 'text',
              text: text.trim()
                ? `[PDF: ${filename}]\n\n${text}`
                : `[PDF: ${filename}]\n\nNo extractable text and image rendering failed: ${imgErr.message}`,
            }];
          }
        }
        break;
      }

      case 'docx': {
        const text = await readDocxText(resolvedPath);
        content = [{
          type: 'text',
          text: text
            ? `[DOCX: ${filename}]\n\n${text}`
            : `[DOCX: ${filename}]\n\nNo text extracted.`,
        }];
        break;
      }

      case 'spreadsheet': {
        const text = await readSpreadsheetText(resolvedPath);
        content = [{
          type: 'text',
          text: text
            ? `[Spreadsheet: ${filename}]\n\n${text}`
            : `[Spreadsheet: ${filename}]\n\nNo data extracted.`,
        }];
        break;
      }

      case 'odt': {
        const text = await readOdtText(resolvedPath);
        content = [{
          type: 'text',
          text: text
            ? `[ODT: ${filename}]\n\n${text}`
            : `[ODT: ${filename}]\n\nNo text extracted.`,
        }];
        break;
      }

      case 'pptx': {
        const text = await readPptxText(resolvedPath);
        content = [{
          type: 'text',
          text: text
            ? `[PPTX: ${filename}]\n\n${text}`
            : `[PPTX: ${filename}]\n\nNo text extracted.`,
        }];
        break;
      }

      case 'image': {
        const { base64, mimeType } = await readImageBase64(resolvedPath);
        content = [
          {
            type: 'image',
            data: base64,
            mimeType,
          },
          {
            type: 'text',
            text: `[Image: ${filename}]`,
          },
        ];
        break;
      }

      case 'text': {
        const text = readTextFile(resolvedPath);
        content = [{
          type: 'text',
          text: `[Text: ${filename}]\n\n${text}`,
        }];
        break;
      }

      default:
        return {
          content: [{
            type: 'text',
            text: `Error: Unsupported file type ".${path.extname(filename)}" for file "${filename}". Supported types: PDF, DOCX, XLSX/XLS/ODS/CSV, ODT, PPTX, images (PNG/JPG/WebP/GIF), and plain text (TXT/MD/JSON/XML/HTML/CSS/JS/TS/PY/YAML/SH/SQL).`,
          }],
          isError: true,
        };
      }

      return { content };
    }

    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('File Reader MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
