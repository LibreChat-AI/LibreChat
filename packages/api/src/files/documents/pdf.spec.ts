import path from 'node:path';
import { fork } from 'node:child_process';
import type { PdfExtractionResult } from './pdf.helper';

/** Native Node preserves pdf.js's ESM import without changing the workspace's CJS Jest setup. */
function extractPdfs(mode: 'serial' | 'concurrent' | 'errors'): Promise<PdfExtractionResult[]> {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, 'pdf.helper.ts'), [mode], {
      execArgv: ['-r', 'ts-node/register/transpile-only'],
      env: {
        ...process.env,
        TS_NODE_PROJECT: path.join(__dirname, '../../../tsconfig.json'),
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        }),
      },
      silent: true,
    });
    let results: PdfExtractionResult[] | undefined;
    let diagnostics = '';
    child.stdout?.on('data', (chunk: Buffer) => (diagnostics += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (diagnostics += chunk.toString()));
    child.on('message', (message: PdfExtractionResult[]) => (results = message));
    child.once('error', reject);
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || results == null) {
        reject(new Error(`PDF subprocess failed (${signal ?? code}): ${diagnostics}`));
        return;
      }
      resolve(results);
    });
  });
}

function expectComplete(results: PdfExtractionResult[]): void {
  for (const result of results) {
    expect(result.error).toBeUndefined();
    const expected = Array.from(
      { length: result.pages },
      (_, index) => `Document ${result.name} page ${index + 1}\n`,
    ).join('');
    expect(result.text).toBe(expected);
    expect(result.bytes).toBe(Buffer.byteLength(expected));
  }
}

describe('real PDF document extraction', () => {
  it('extracts every page from serial uploads', async () => {
    const results = await extractPdfs('serial');
    expect(results).toHaveLength(4);
    expectComplete(results);
  });

  it('preserves complete text for every concurrently extracted PDF', async () => {
    const results = await extractPdfs('concurrent');
    expect(results).toHaveLength(20);
    expectComplete(results);
  });

  it('rejects invalid, textless and oversized PDFs instead of reporting success', async () => {
    const results = await extractPdfs('errors');
    expect(results).toEqual([
      { name: 'blank', pages: 1, error: 'No text found in document' },
      { name: 'invalid', pages: 1, error: expect.stringMatching(/Invalid PDF/) },
      { name: 'oversized', pages: 1, error: expect.stringMatching(/exceeds the 15MB/) },
    ]);
  });
});
