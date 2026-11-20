import { parentPort } from 'node:worker_threads';
import type { HostEditResult, HostEditWorkLimits } from './matching';
import type { TextEdit } from '../edits';
import { applyTextEdits, HostEditError } from './matching';

export interface HostEditJob {
  content: string;
  edits: TextEdit[];
  limits: HostEditWorkLimits;
}

export type HostEditReply = { ok: true; result: HostEditResult } | { ok: false; message: string };

parentPort?.on('message', (job: HostEditJob) => {
  let reply: HostEditReply;
  try {
    reply = { ok: true, result: applyTextEdits(job.content, job.edits, job.limits) };
  } catch (error) {
    reply = {
      ok: false,
      message:
        error instanceof HostEditError
          ? error.message
          : 'File edit processing failed. Nothing was written.',
    };
  }
  parentPort?.postMessage(reply);
});
