import { readFile } from 'node:fs/promises';

export async function readPrintWidth(path: string): Promise<number> {
  const { printWidth } = JSON.parse(await readFile(path, 'utf8')) as { printWidth?: number };
  if (typeof printWidth !== 'number' || !Number.isInteger(printWidth) || printWidth <= 0) {
    throw new Error('Import cleanup requires a positive integer printWidth in .prettierrc');
  }
  return printWidth;
}
