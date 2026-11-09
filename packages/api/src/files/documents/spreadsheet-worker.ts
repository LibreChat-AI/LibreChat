import { read, utils, SSF } from 'xlsx';
import { readFile, stat } from 'node:fs/promises';
import { workbookToText, SPREADSHEET_LIMITS, SpreadsheetLimitError } from './workbook';
import { assertSafeZipSize, ZipBombError } from './zipSafety';

export type SpreadsheetReply = { ok: true; text: string } | { ok: false; limited: boolean };

async function run(filePath: string): Promise<void> {
  let reply: SpreadsheetReply;
  try {
    if ((await stat(filePath)).size > SPREADSHEET_LIMITS.inputBytes) {
      throw new SpreadsheetLimitError();
    }
    const data = await readFile(filePath);
    if (data.length > SPREADSHEET_LIMITS.inputBytes) throw new SpreadsheetLimitError();
    let preserveDisplayText = false;
    if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
      await assertSafeZipSize(data, {
        name: 'spreadsheet',
        onEntry: (name) => {
          // Same format markers SheetJS uses to select the OpenDocument parser.
          const marker = name
            .replace(/^Root Entry[\\/]/, '')
            .replace(/\\/g, '/')
            .toLowerCase();
          if (marker === 'meta-inf/manifest.xml' || marker === 'objectdata.xml') {
            preserveDisplayText = true;
          }
        },
      });
    } else {
      preserveDisplayText = data.includes(
        Buffer.from(
          'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
          data[0] === 0xff && data[1] === 0xfe ? 'utf16le' : 'utf8',
        ),
      );
    }
    // ODS stores display text in XML. Excel formatting stays deferred and budgeted.
    const workbook = read(data, {
      type: 'buffer',
      cellText: preserveDisplayText,
      cellNF: true,
      cellHTML: false,
      dense: false,
    });
    reply = { ok: true, text: workbookToText(workbook, utils, SSF.format) };
  } catch (error) {
    reply = {
      ok: false,
      limited: error instanceof SpreadsheetLimitError || error instanceof ZipBombError,
    };
  }
  process.send?.(reply, () => process.disconnect());
}

void run(process.argv[2]);
