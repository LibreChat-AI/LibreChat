import type {
  RuntimeJournal,
  RuntimeJournalLease,
  RuntimeJournalSession,
  RuntimeJournalResult,
  RuntimeJournalState,
} from './journal';
import type { RecoveryLog } from './socket';
export function journalValue<T>(result: RuntimeJournalResult<T>): T {
  if (!result.ok) throw new Error(`SDK recovery journal ${result.error.code}`);
  return result.value;
}
export function createJournalRecoveryLog(options: {
  journal: RuntimeJournal;
  session: RuntimeJournalSession;
  lease?: RuntimeJournalLease;
  head: number;
}): RecoveryLog {
  let head = options.head;
  const { journal, session, lease } = options;
  const appendBatch = async (id: string, payloads: string[]) => {
    if (!lease) throw new Error('SDK recovery journal is read only');
    let terminal: Exclude<RuntimeJournalState, 'open'> | undefined;
    for (const payload of payloads) {
      const entry = JSON.parse(payload) as { kind: string; payload: string };
      if (entry.kind !== 'data') continue;
      if (terminal) throw new Error('SDK frames follow a terminal receipt');
      const frame = JSON.parse(entry.payload) as {
        type?: string;
        data?: { interrupt?: { $sdk?: string } };
      };
      if (frame.type === 'error') terminal = 'failed';
      if (frame.type === 'done')
        terminal =
          frame.data?.interrupt != null && frame.data.interrupt.$sdk !== 'undefined'
            ? 'paused'
            : 'completed';
    }
    const range = journalValue(await journal.append(session, lease, id, payloads, terminal));
    head = range.last;
    return range;
  };
  return {
    head: () => head,
    maxBatchFrames: journal.maxBatchBytes ? journal.maxBatchFrames : 1,
    maxBatchBytes: journal.maxBatchBytes,
    appendBatch,
    append: async (id, payload) => (await appendBatch(id, [payload])).last,
    read: async (after) => {
      const page = journalValue(await journal.read(session, after, journal.maxBatchFrames));
      head = page.head;
      return page.frames;
    },
    acknowledge: async (sequence) => {
      if (sequence > head) throw new Error('SDK recovery cursor is ahead');
      if (!lease) return;
      const result = await journal.acknowledge(session, lease, sequence);
      if (!result.ok && result.error.code !== 'closed') journalValue(result);
    },
  };
}
