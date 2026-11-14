import { logger } from '@librechat/data-schemas';
import { decideFileReading } from 'librechat-data-provider';
import type {
  FileReading,
  TurnDeliveryFile,
  TurnFileConsumers,
  TurnDeliveryRouting,
} from 'librechat-data-provider';
import { getTurnReadingContext } from './turn';

/** Which reading the line describes: initialization's first or final decision, or a run's. */
export type ReadingPass = 'init' | 'final' | 'run';

/** Whether an allocation covered the request alone or the request after its history. */
export type AllocationScope = 'request' | 'history';

/** The fields of an initialized agent the turn's reading diagnostics read. */
export interface TurnReadingAgent {
  id?: string;
  deliveryRouting?: TurnDeliveryRouting;
  fileConsumers?: TurnFileConsumers;
  requestAttachments?: readonly TurnDeliveryFile[];
  currentRequestAttachments?: readonly TurnDeliveryFile[];
}

const SUMMARY_READERS = ['provider', 'text', 'search', 'code', 'unavailable'] as const;

type ReaderCounts = Record<(typeof SUMMARY_READERS)[number], number>;

const formatSkipped = ({ skipped }: FileReading): string =>
  skipped.length === 0
    ? 'none'
    : skipped.map(({ reader, reason }) => `${reader}:${reason}`).join(',');

const formatFileReading = (fileId: string | undefined, reading: FileReading): string =>
  [
    `[fileReading] file_id=${fileId ?? 'unknown'}`,
    `category=${reading.category}`,
    `reader=${reading.reader}`,
    `path=${reading.path ?? 'unset'}`,
    `classic=${reading.classicPath ?? 'unset'}`,
    `reason=${reading.reason}`,
    `skipped=${formatSkipped(reading)}`,
    `code=${reading.code}`,
    ...(reading.needsText ? ['text=derive'] : []),
  ].join(' ');

/**
 * Logs how the automatic policy reads the agent's current request attachments: one summary line
 * at info and one line per file at debug. Lines carry file ids, codes and provider names only.
 * Silent under the classic policy.
 */
export function logTurnReading(agent: TurnReadingAgent, pass: ReadingPass): void {
  const routing = agent.deliveryRouting;
  const context = getTurnReadingContext(routing);
  if (routing == null || context == null || context.policy !== 'automatic') {
    return;
  }
  const files = agent.currentRequestAttachments ?? agent.requestAttachments ?? [];
  const stats = context.stats();
  if (files.length === 0 && stats.dropped === 0) {
    return;
  }
  const counts: ReaderCounts = { provider: 0, text: 0, search: 0, code: 0, unavailable: 0 };
  const lines: string[] = [];
  for (const file of files) {
    const reading = decideFileReading({ routing, file, consumers: agent.fileConsumers });
    if (reading.reader !== 'unresolved') {
      counts[reading.reader] += 1;
    }
    lines.push(formatFileReading(file.file_id, reading));
  }
  logger.info(
    [
      `[fileReading] agent=${agent.id ?? 'unknown'} policy=automatic pass=${pass}`,
      `files=${files.length}`,
      ...SUMMARY_READERS.map((reader) => `${reader}=${counts[reader]}`),
      `overflow=${stats.overflow} derived=${stats.derived}`,
      `rejected=${stats.rejected} dropped=${stats.dropped}`,
    ].join(' '),
  );
  for (const line of lines) {
    logger.debug(line);
  }
}

/** Logs one first-fit allocation of direct model content. */
export function logAllocation({
  agentId,
  scope,
  candidates,
  overflow,
}: {
  agentId?: string;
  scope: AllocationScope;
  candidates: number;
  overflow: number;
}): void {
  logger.debug(
    `[allocation] agent=${agentId ?? 'unknown'} scope=${scope} candidates=${candidates} overflow=${overflow}`,
  );
}
