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
    if (data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b) {
      await assertSafeZipSize(data, { name: 'spreadsheet' });
    }
    // Avoid eager per-reference formatting and HTML expansion during read().
    const workbook = read(data, {
      type: 'buffer',
      cellText: false,
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
