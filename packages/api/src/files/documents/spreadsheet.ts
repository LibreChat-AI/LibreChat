import path from 'node:path';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { spreadsheetParsingSchema } from 'librechat-data-provider';
import type { SpreadsheetParsing } from 'librechat-data-provider';
import type { ChildProcess } from 'node:child_process';
import type { SpreadsheetReply } from './spreadsheet-worker';
import { SPREADSHEET_LIMITS, SpreadsheetLimitError } from './workbook';
import { SpreadsheetBusyError } from '../upload/errors';

/** No queue or in-process fallback: read() shares neither the API heap nor its event loop. */
export function createSpreadsheetParser(
  workerPath: string,
): (filePath: string, configured?: Partial<SpreadsheetParsing>) => Promise<string> {
  let active = 0;
  return async (filePath, configured): Promise<string> => {
    const parsed = spreadsheetParsingSchema.safeParse(configured ?? {});
    if (!parsed.success) throw new Error('Spreadsheet processing configuration is invalid.');
    const limits = parsed.data;
    if (active >= limits.maxConcurrent) {
      throw new SpreadsheetBusyError();
    }
    active++;
    try {
      const deadline = performance.now() + limits.timeoutMs;
      let worker: ChildProcess;
      try {
        worker = fork(workerPath, [filePath], {
          // Worker-thread resourceLimits are overridden by the parent's V8 flags.
          execArgv: [
            `--max-old-space-size=${SPREADSHEET_LIMITS.heapMb}`,
            '--max-semi-space-size=8',
            '--stack-size=1024',
          ],
          env: { ...process.env, NODE_OPTIONS: '' },
          serialization: 'advanced',
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        });
      } catch {
        throw new Error('Spreadsheet processing failed.');
      }
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const closed = new Promise<void>((done) => worker.once('close', () => done()));
        const finish = async (error?: Error, text?: string): Promise<void> => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // Kill even synchronous parser stalls. Hold admission until the process is reaped.
          worker.kill('SIGKILL');
          await closed;
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
        worker.on('error', failed);
        worker.once('close', failed);
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

export function spreadsheetToText(
  file: Express.Multer.File,
  configured?: Partial<SpreadsheetParsing>,
): Promise<string> {
  parser ??= createSpreadsheetParser(
    path.join(
      path.dirname(require.resolve('@librechat/api')),
      'files/documents/spreadsheet-worker.cjs',
    ),
  );
  return parser(file.path, configured);
}
