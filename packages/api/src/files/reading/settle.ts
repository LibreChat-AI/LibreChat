import { decideFileReading, allocateDirectContent } from 'librechat-data-provider';
import type {
  DirectContentEntry,
  TurnFileConsumers,
  DirectContentLimits,
  TurnDeliveryRouting,
} from 'librechat-data-provider';
import type { TurnReadingFile, TurnReader } from './turn';
import type { AllocationScope } from './diagnostics';
import {
  withDerivedText,
  needsDerivedText,
  deriveRequestedText,
  getTurnReadingContext,
} from './turn';
import { applyTurnDelivery } from '~/agents/files/delivery';
import { logAllocation } from './diagnostics';

/** First-fit allocation of the request's direct model content against the turn's limits. */
export interface DirectContentAllocation<T extends TurnReadingFile> {
  /** The request's attachments in submission order; earlier files are admitted first. */
  requestFileIds: readonly string[];
  limits: DirectContentLimits;
  /**
   * The direct content one file puts on the model path, as the matching admission check charges
   * it. A file that is not model-bound measures as zero.
   */
  measure: (file: T) => DirectContentEntry;
  /** Content already charged against the same limits, such as replayed history. */
  committedExtra?: readonly T[];
  /**
   * Content already charged that the caller measured itself, such as replayed history, which
   * spends the context budgets but counts as the checks on it count repeated copies.
   */
  committedEntries?: readonly DirectContentEntry[];
  agentId?: string;
  scope?: AllocationScope;
}

export interface SettleTurnFilesParams<T extends TurnReadingFile> {
  routing?: TurnDeliveryRouting;
  consumers?: TurnFileConsumers;
  files: T[];
  allocation?: DirectContentAllocation<T>;
  /**
   * Save the derivations the context queued before returning. Derived text was already
   * content-inspected at derivation, and a policy refusal throws instead of saving; this decides
   * only whether the save waits for the caller's later checks, as initialization's does.
   */
  flush?: boolean;
  signal?: AbortSignal;
}

interface SettleStep extends TurnReader {
  signal?: AbortSignal;
}

const route = <T extends TurnReadingFile>(files: T[], { routing, consumers }: SettleStep): T[] =>
  applyTurnDelivery(files, { routing, consumers });

/**
 * Derives text for every copy whose reading needs it. Failures are recorded on the context, so the
 * next decision passes text over for the rest of the request. Returns null when no copy needed text.
 * A derive-only classic context decides only the records the automatic policy marked.
 */
async function deriveNeededText<T extends TurnReadingFile>(
  files: T[],
  step: SettleStep,
): Promise<T[] | null> {
  const { context, signal } = step;
  const needed = files.filter((file) => needsDerivedText(file, step));
  if (needed.length === 0) {
    return null;
  }
  signal?.throwIfAborted();
  const texts = await deriveRequestedText(
    needed.map((file) => ({ file, contexts: [context] as const })),
    signal,
  );
  if (texts.size === 0) {
    return files;
  }
  return files.map((file) => {
    const derived = texts.get(file.file_id);
    return derived == null ? file : withDerivedText(file, derived);
  });
}

const isDirectReading = (file: TurnReadingFile, { routing, consumers }: SettleStep): boolean => {
  const reading = decideFileReading({ routing, file, consumers });
  return reading.automatic && (reading.reader === 'provider' || reading.reader === 'text');
};

/** The request's files in submission order, once each, among those still on the turn. */
function selectRequestFiles<T extends TurnReadingFile>(
  files: readonly T[],
  requestFileIds: readonly string[],
): T[] {
  const byId = new Map<string, T>();
  for (const file of files) {
    if (!byId.has(file.file_id)) {
      byId.set(file.file_id, file);
    }
  }
  const selected: T[] = [];
  for (const fileId of new Set(requestFileIds)) {
    const file = byId.get(fileId);
    if (file != null) {
      selected.push(file);
    }
  }
  return selected;
}

/**
 * Charges what the automatic policy cannot move first, measured exactly as admission measures it,
 * then admits each request file it reads directly in submission order while it fits. A file that does not fit is recorded as overflow,
 * so the next decision moves it to another reader or leaves it unavailable.
 */
function allocate<T extends TurnReadingFile>(
  files: T[],
  allocation: DirectContentAllocation<T>,
  step: SettleStep,
): T[] {
  const { measure, limits, committedExtra = [], committedEntries = [] } = allocation;
  const candidates: DirectContentEntry[] = [];
  const committed: DirectContentEntry[] = [...committedEntries, ...committedExtra.map(measure)];
  for (const file of selectRequestFiles(files, allocation.requestFileIds)) {
    (isDirectReading(file, step) ? candidates : committed).push(measure(file));
  }
  const overflow = allocateDirectContent(committed, candidates, limits);
  logAllocation({
    agentId: allocation.agentId,
    scope: allocation.scope ?? 'request',
    candidates: candidates.length,
    overflow: overflow.size,
  });
  if (overflow.size === 0) {
    return files;
  }
  step.context.addOverflow(overflow);
  return route(files, step);
}

/**
 * Settles how a turn reads its files: applies the turn route, derives text the reading needs and
 * decides again, then, with an allocation under the automatic policy, moves direct content that
 * does not fit the turn's limits to another reader. Returns the input array when nothing changed.
 * Without a reading context on the routing this is exactly {@link applyTurnDelivery}.
 */
export async function settleTurnFiles<T extends TurnReadingFile>({
  routing,
  consumers,
  files,
  allocation,
  flush = false,
  signal,
}: SettleTurnFilesParams<T>): Promise<T[]> {
  const resolved = applyTurnDelivery(files, { routing, consumers });
  const context = getTurnReadingContext(routing);
  if (routing == null || context == null) {
    return resolved;
  }
  const step: SettleStep = { routing, consumers, context, signal };
  const derived = await deriveNeededText(resolved, step);
  const decided = derived == null ? resolved : route(derived, step);
  const settled =
    allocation != null && context.policy === 'automatic'
      ? allocate(decided, allocation, step)
      : decided;
  if (flush) {
    await context.flush();
  }
  return settled;
}

/**
 * {@link settleTurnFiles} without allocation, saving its derivations before returning: for readers
 * outside initialization, such as history replay, steering and the run-file encoder. Those saves
 * happen before the caller's endpoint filter and model-bound admission; the text they keep passed
 * the `extracted_text` inspection when it was derived, and a refusal throws without saving.
 */
export function prepareTurnFiles<T extends TurnReadingFile>({
  flush = true,
  ...params
}: Omit<SettleTurnFilesParams<T>, 'allocation'>): Promise<T[]> {
  return settleTurnFiles({ ...params, flush });
}
