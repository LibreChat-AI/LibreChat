import { read, utils } from 'xlsx';
import { readFile, stat } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';
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
    reply = { ok: true, text: workbookToText(workbook, utils) };
  } catch (error) {
    reply = {
      ok: false,
      limited: error instanceof SpreadsheetLimitError || error instanceof ZipBombError,
    };
  }
  parentPort?.postMessage(reply);
}

void run(workerData as string);
