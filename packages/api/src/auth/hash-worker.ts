import { parentPort } from 'node:worker_threads';
import { compareSync, hashSync } from 'bcryptjs';

export type HashJob =
  | { id: number; op: 'hash'; plain: string; rounds: number }
  | { id: number; op: 'compare'; plain: string; hash: string };

export type HashReply =
  | { id: number; ok: true; value: string | boolean }
  | { id: number; ok: false };

parentPort?.on('message', (job: HashJob) => {
  let reply: HashReply;
  try {
    const value =
      job.op === 'hash' ? hashSync(job.plain, job.rounds) : compareSync(job.plain, job.hash);
    reply = { id: job.id, ok: true, value };
  } catch {
    reply = { id: job.id, ok: false };
  }
  parentPort?.postMessage(reply);
});
