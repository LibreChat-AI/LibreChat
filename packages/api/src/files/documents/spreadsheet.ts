import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import type { SpreadsheetReply } from './spreadsheet-worker';
import { SPREADSHEET_LIMITS, SpreadsheetLimitError } from './workbook';

/** No queue or main-thread fallback: even read() runs under a heap and time ceiling. */
export function createSpreadsheetParser(workerPath: string): (filePath: string) => Promise<string> {
  let active = 0;
  return async (filePath): Promise<string> => {
    if (active >= SPREADSHEET_LIMITS.concurrent) {
      throw new Error('Spreadsheet processing is busy; retry later.');
    }
    active++;
    try {
      const deadline = performance.now() + SPREADSHEET_LIMITS.timeoutMs;
      let worker: Worker;
      try {
        worker = new Worker(workerPath, {
          workerData: filePath,
          execArgv: [],
          resourceLimits: {
            maxOldGenerationSizeMb: SPREADSHEET_LIMITS.heapMb,
            maxYoungGenerationSizeMb: 16,
            stackSizeMb: 4,
          },
        });
      } catch {
        throw new Error('Spreadsheet processing failed.');
      }
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = async (error?: Error, text?: string): Promise<void> => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Keep admission occupied until the worker and its input/output are gone.
          await worker.terminate().catch(() => undefined);
          if (error) reject(error);
          else resolve(text ?? '');
        };
        const failed = (): void => {
          void finish(new Error('Spreadsheet processing failed.'));
        };
        const timer = setTimeout(
          () => {
            void finish(new SpreadsheetLimitError());
          },
          Math.max(0, deadline - performance.now()),
        );
        worker.once('error', failed);
        worker.once('exit', failed);
        worker.once('message', (reply: SpreadsheetReply) => {
          if (performance.now() >= deadline) {
            void finish(new SpreadsheetLimitError());
          } else if (!reply.ok) {
            void finish(
              reply.limited
                ? new SpreadsheetLimitError()
                : new Error('Spreadsheet processing failed.'),
            );
          } else if (
            typeof reply.text !== 'string' ||
            reply.text.length > SPREADSHEET_LIMITS.outputBytes ||
            Buffer.byteLength(reply.text, 'utf8') > SPREADSHEET_LIMITS.outputBytes
          ) {
            void finish(new SpreadsheetLimitError());
          } else {
            void finish(undefined, reply.text);
          }
        });
      });
    } finally {
      active--;
    }
  };
}

let parser: ReturnType<typeof createSpreadsheetParser> | undefined;

export function spreadsheetToText(file: Express.Multer.File): Promise<string> {
  parser ??= createSpreadsheetParser(
    path.join(
      path.dirname(require.resolve('@librechat/api')),
      'files/documents/spreadsheet-worker.cjs',
    ),
  );
  return parser(file.path);
}
