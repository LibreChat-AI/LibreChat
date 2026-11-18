import {
  getRoutingMimeType,
  hasFileToolConsumer,
  Tools,
  EToolResources,
  isTextOnlyRecord,
  decideFileReading,
  categorizeForReading,
  getCodeEnvRefForProfile,
  resolveLLMDeliveryPolicy,
  hasToolResourceProvisioning,
} from 'librechat-data-provider';
import type {
  FileReading,
  FiltersConfig,
  ReadingReason,
  TurnDeliveryRouting,
} from 'librechat-data-provider';
import type { CodeFileAgent, ProvisionToolContext } from '~/files/code/queued';
import type { SearchPreparationState, TurnReadingFile } from './turn';
import type { CodeFileLocation } from '~/files/code/priming';
import { CODE_FILE_CONTEXT_ROOTS, getCodeFileLocation } from '~/files/code/priming';
import { assertModelBoundContent } from '~/middleware/modelBoundContent';
import { prepareQueuedCodeFileContext } from '~/files/code/queued';
import { getCodeExecutionRouteKey } from '~/agents/execution';
import { getTurnReadingContext } from './turn';

/** The fields of an initialized agent the file inventory reads. */
export interface ReadingAgent
  extends Pick<
    CodeFileAgent,
    'id' | 'fileConsumers' | 'provisionState' | 'codeExecutionContext' | 'dynamicToolContextMap'
  > {
  deliveryRouting?: TurnDeliveryRouting;
  currentRequestAttachments?: readonly TurnReadingFile[];
  /** Files the File Search advert listed on this turn; unknown when absent. */
  primedSearchFileIds?: readonly string[];
}

/** A file the File Search advert listed, as the tool loader primed it. */
export interface PrimedSearchFile {
  file_id: string;
  filename: string;
  fromAgent: boolean;
}

/** The fields one file's reading and code location are decided from. */
type DecidingAgent = Pick<
  ReadingAgent,
  'deliveryRouting' | 'fileConsumers' | 'provisionState' | 'codeExecutionContext'
>;

/** Where Run Code can open a file on this turn. */
export type CodeFileState =
  | { state: 'queued'; path: string; location: CodeFileLocation }
  | { state: 'live' }
  | { state: 'not_prepared' };

type QueuedCodeFile = Extract<CodeFileState, { state: 'queued' }>;

/** Why a classic provider reading was not delivered, from the turn's encoder evidence. */
type WithheldReason = Extract<ReadingReason, 'native_rejected' | 'native_unsupported'>;

/** One inventory line's inputs: a file with its reading, or a file the endpoint refused. */
export type InventoryEntry =
  | {
      kind: 'read';
      file: TurnReadingFile;
      reading: FileReading;
      code?: CodeFileState;
      search?: SearchPreparationState;
      withheld?: WithheldReason;
    }
  | { kind: 'dropped'; file: TurnReadingFile };

type ReadEntry = Extract<InventoryEntry, { kind: 'read' }>;

export interface AgentFileContextOptions {
  /** The content policy the rendered inventory must pass before it reaches the model. */
  filters?: FiltersConfig;
  /**
   * Whether the agent's messages carry the request and its attachments. A subagent child
   * receives only its task, so nothing sent with the request is described as sent to it.
   */
  receivesRequest?: boolean;
}

/** Whose messages the rendered lines describe. */
export interface InventoryView {
  receivesRequest: boolean;
}

const REQUEST_VIEW: InventoryView = { receivesRequest: true };

const INVENTORY_KEY = 'file_inventory';

const INVENTORY_HEADER =
  '- Attached files and how you can read them on this turn (file contents are not listed here):';

const LEFT_OUT_HEADER =
  '- Shared files left out of this message (file contents are not listed here):';

const REASON_PHRASES: Readonly<Partial<Record<ReadingReason, string>>> = {
  native_capacity: 'too large to send directly',
  native_unsupported: 'this model cannot read this type directly',
  native_rejected: 'the model could not accept it',
  text_exceeds: 'too long to include',
  aggregate_overflow: 'did not fit with the other attachments',
};

const NOT_READ = 'Say so if asked; do not claim to have read it.';
const NOT_IN_TASK =
  'not sent with your task. Do not claim to have read it unless it is shared with you.';
const TEXT_ONLY = 'only an extracted-text copy was kept, so Run Code cannot open the original.';
const SEARCH_EXCERPTS = 'Results are excerpts, not the whole document.';
const CODE_FILE_LIST = "(see the code tool's file list)";

const READABLE_CLASSIC_READERS: ReadonlySet<FileReading['reader']> = new Set([
  'provider',
  'text',
  'search',
  'code',
]);

/** Readers whose content travels inside the request's own message. */
const MESSAGE_READERS: ReadonlySet<FileReading['reader']> = new Set(['provider', 'text']);

/** Line separators JSON leaves raw, which some renderers still break a line on. */
const RAW_LINE_BREAKS = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');

const NOT_PREPARED: CodeFileState = { state: 'not_prepared' };

const capitalize = (sentence: string): string =>
  sentence.charAt(0).toUpperCase() + sentence.slice(1);

const codeRouteKey = (agent: DecidingAgent): string =>
  agent.codeExecutionContext == null
    ? 'default'
    : getCodeExecutionRouteKey(agent.codeExecutionContext);

/**
 * Queued paths come only from the destinations the planner just wrote, so the inventory and the
 * lazy upload name the same path (#16578).
 */
function locateCodeFile(agent: DecidingAgent, file: TurnReadingFile): CodeFileState {
  const destination = agent.provisionState?.codeEnvDestinations?.get(file.file_id);
  if (destination != null) {
    const location = getCodeFileLocation(agent.codeExecutionContext);
    return {
      state: 'queued',
      path: `${CODE_FILE_CONTEXT_ROOTS[location]}/${destination}`,
      location,
    };
  }
  if (getCodeEnvRefForProfile(file.metadata, codeRouteKey(agent)) != null) {
    return { state: 'live' };
  }
  return NOT_PREPARED;
}

/**
 * A classic provider reading names no other reader, so the turn's encoder evidence is what says
 * whether the file went out: a recorded rejection, or a type the encoder never emits.
 */
function findWithheldReason(
  agent: DecidingAgent,
  file: TurnReadingFile,
  reading: FileReading,
): WithheldReason | undefined {
  if (reading.automatic || reading.reader !== 'provider') {
    return undefined;
  }
  const evidence = getTurnReadingContext(agent.deliveryRouting)?.judge(file);
  if (evidence?.rejected != null) {
    return evidence.rejected === 'unsupported' ? 'native_unsupported' : 'native_rejected';
  }
  return evidence?.native === 'unsupported' ? 'native_unsupported' : undefined;
}

function readEntry(agent: DecidingAgent, file: TurnReadingFile): ReadEntry {
  const reading = decideFileReading({
    routing: agent.deliveryRouting,
    file,
    consumers: agent.fileConsumers,
  });
  const withheld = findWithheldReason(agent, file, reading);
  const search =
    reading.reader === 'search'
      ? getTurnReadingContext(agent.deliveryRouting)?.searchState(file.file_id)
      : undefined;
  return {
    kind: 'read',
    file,
    reading,
    ...(reading.code === 'eligible' && { code: locateCodeFile(agent, file) }),
    ...(search != null && { search }),
    ...(withheld != null && { withheld }),
  };
}

/** Classic routes are listed only where they name a reader; the automatic walk always does. */
const isListed = ({ file, reading }: ReadEntry): boolean =>
  reading.automatic || isTextOnlyRecord(file) || READABLE_CLASSIC_READERS.has(reading.reader);

const isAutomaticSearch = ({ reading }: ReadEntry): boolean =>
  reading.automatic && reading.reader === 'search';

/** The files not in `seen`, once each and in order. */
function selectUnseen(
  files: readonly TurnReadingFile[],
  seen: ReadonlySet<string>,
): TurnReadingFile[] {
  const selected = new Map<string, TurnReadingFile>();
  for (const file of files) {
    if (!seen.has(file.file_id) && !selected.has(file.file_id)) {
      selected.set(file.file_id, file);
    }
  }
  return [...selected.values()];
}

/**
 * Decides each file the inventory lists once, from the turn's current evidence: the request's
 * attachments, files queued for File Search that the automatic policy leaves to it, and request
 * attachments the endpoint refused.
 */
export function collectInventoryEntries(agent: ReadingAgent): InventoryEntry[] {
  const currentFiles = selectUnseen(agent.currentRequestAttachments ?? [], new Set());
  const seen = new Set(currentFiles.map(({ file_id }) => file_id));
  const pendingSearch = selectUnseen(agent.provisionState?.vectorDBFiles ?? [], seen)
    .map((file) => readEntry(agent, file))
    .filter(isAutomaticSearch);
  pendingSearch.forEach(({ file }) => seen.add(file.file_id));
  const dropped = selectUnseen(getTurnReadingContext(agent.deliveryRouting)?.dropped() ?? [], seen);
  return [
    ...currentFiles.map((file) => readEntry(agent, file)).filter(isListed),
    ...pendingSearch,
    ...dropped.map((file): InventoryEntry => ({ kind: 'dropped', file })),
  ];
}

const isPendingSearch = (entry: InventoryEntry): boolean =>
  entry.kind === 'read' &&
  entry.reading.reader === 'search' &&
  !hasToolResourceProvisioning(entry.file, EToolResources.file_search);

/**
 * With nothing primed, the File Search advert can only be its "no files are currently loaded"
 * note, which a file awaiting indexing contradicts; the inventory lists that file instead.
 */
function reconcileSearchAdvert(agent: ReadingAgent, entries: readonly InventoryEntry[]): void {
  if (agent.primedSearchFileIds?.length !== 0 || agent.dynamicToolContextMap == null) {
    return;
  }
  if (entries.some(isPendingSearch)) {
    delete agent.dynamicToolContextMap[Tools.file_search];
  }
}

function describeType(
  file: TurnReadingFile,
  category: FileReading['category'] = categorizeForReading(getRoutingMimeType(file)),
): string {
  const mimeType = getRoutingMimeType(file);
  if (category === 'tabular') {
    return 'spreadsheet';
  }
  if (category === 'media') {
    return mimeType.split('/', 1)[0].toLowerCase();
  }
  if (mimeType === 'application/pdf') {
    return 'PDF';
  }
  return mimeType.startsWith('text/') ? 'text' : 'document';
}

/** Primed files on an attached workspace reach only scripts run by programmatic Bash. */
const describeQueuedReader = (code: QueuedCodeFile, also = ''): string =>
  code.location === 'programmatic'
    ? `scripts run by the programmatic Bash tool can${also} read it at ${code.path}`
    : `Run Code can${also} open it at ${code.path}`;

function describeCodeReader(code: CodeFileState): string {
  if (code.state === 'queued' && code.location === 'programmatic') {
    return `${describeQueuedReader(code)}. It is copied when such a script first runs.`;
  }
  if (code.state === 'queued') {
    return `read it with Run Code at ${code.path}. It is copied when code first runs.`;
  }
  if (code.state === 'live') {
    return `read it with Run Code; it is already in the code environment ${CODE_FILE_LIST}.`;
  }
  return 'Run Code is available, but this file could not be prepared on this turn. Do not claim to have read it.';
}

function describeAlsoInCode(code?: CodeFileState): string | undefined {
  if (code?.state === 'queued') {
    return `${capitalize(describeQueuedReader(code, ' also'))}.`;
  }
  return code?.state === 'live' ? `Run Code can also open it ${CODE_FILE_LIST}.` : undefined;
}

const withAlsoInCode = (lead: string, code?: CodeFileState): string => {
  const alsoInCode = describeAlsoInCode(code);
  return alsoInCode == null ? lead : `${lead} ${alsoInCode}`;
};

function describeSearch(file: TurnReadingFile, state?: SearchPreparationState): string {
  if (state === 'failed') {
    return `File Search could not prepare it on this turn. Retry ${Tools.file_search} to try indexing again. ${NOT_READ}`;
  }
  const indexed =
    state === 'ready' || hasToolResourceProvisioning(file, EToolResources.file_search);
  const pending = indexed ? '' : '; it is indexed when you first search';
  return `search it with ${Tools.file_search}${pending}. ${SEARCH_EXCERPTS}`;
}

function describeUnavailable(reading: FileReading): string {
  if (reading.reason === 'code_unavailable') {
    return `cannot be read on this turn because Run Code is not available. ${NOT_READ}`;
  }
  const phrase = REASON_PHRASES[reading.reason];
  return `cannot be read on this turn${phrase == null ? '' : ` (${phrase})`}. ${NOT_READ}`;
}

function describeReader(
  file: TurnReadingFile,
  reading: FileReading,
  code: CodeFileState = NOT_PREPARED,
  search?: SearchPreparationState,
): string {
  switch (reading.reader) {
    case 'provider':
      return 'sent with this message.';
    case 'text':
      return reading.automatic
        ? 'its complete extracted text is included in this message.'
        : 'its extracted text is included in this message.';
    case 'search':
      return describeSearch(file, search);
    case 'code':
      return describeCodeReader(code);
    default:
      return describeUnavailable(reading);
  }
}

function describeRead(
  { file, reading, code, search, withheld }: ReadEntry,
  { receivesRequest }: InventoryView,
): string {
  if (!receivesRequest && MESSAGE_READERS.has(reading.reader)) {
    return withAlsoInCode(NOT_IN_TASK, code);
  }
  if (withheld != null) {
    return withAlsoInCode(
      `cannot be read on this turn (${REASON_PHRASES[withheld]}). ${NOT_READ}`,
      code,
    );
  }
  if (isTextOnlyRecord(file)) {
    return reading.reader === 'text'
      ? `its extracted text is included in this message. ${capitalize(TEXT_ONLY)}`
      : TEXT_ONLY;
  }
  const status = describeReader(file, reading, code, search);
  if (reading.reader === 'search' && search === 'failed') {
    return withAlsoInCode(status, code);
  }
  if (reading.reader === 'unavailable' || reading.reader === 'unresolved') {
    return status;
  }
  const phrase = REASON_PHRASES[reading.reason];
  const lead = phrase == null ? status : `${phrase}. ${capitalize(status)}`;
  return reading.reader === 'code' ? lead : withAlsoInCode(lead, code);
}

const escapeLineBreak = (separator: string): string =>
  `\\u${separator.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** A file name as one quoted token: JSON escapes plus the line separators JSON leaves raw. */
const quoteFilename = (filename?: string | null): string =>
  JSON.stringify(filename ?? 'attachment').replace(RAW_LINE_BREAKS, escapeLineBreak);

function renderEntry(entry: InventoryEntry, view: InventoryView): string {
  const { file } = entry;
  const name = quoteFilename(file.filename);
  if (entry.kind === 'dropped') {
    return `${name} (${describeType(file)}): not available with this model (its type or size is not allowed here).`;
  }
  const { reading, code } = entry;
  const type = describeType(file, reading.category);
  const queuedForCode = reading.reader === 'code' && code?.state === 'queued';
  const label = queuedForCode ? `${type}, file_id ${file.file_id}` : type;
  return `${name} (${label}): ${describeRead(entry, view)}`;
}

const renderLines = (
  header: string,
  entries: readonly InventoryEntry[],
  view: InventoryView,
): string =>
  entries.length === 0
    ? ''
    : [header, ...entries.map((entry) => `\t- ${renderEntry(entry, view)}`)].join('\n');

/**
 * The model's view of how each attachment is read on this turn. Pending preparation is worded
 * apart from delivery, and no line carries file contents. Empty when nothing is listed.
 */
export function renderFileInventory(
  entries: readonly InventoryEntry[],
  view: InventoryView = REQUEST_VIEW,
): string {
  return renderLines(INVENTORY_HEADER, entries, view);
}

/**
 * Names the shared files a message left out once the turn's evidence for them is recorded, and
 * how each can still be read, so none disappears unnoticed. Empty without such files.
 */
export function renderLeftOutFiles(
  agent: DecidingAgent,
  files: readonly TurnReadingFile[],
): string {
  return renderLines(
    LEFT_OUT_HEADER,
    selectUnseen(files, new Set()).map((file) => readEntry(agent, file)),
    REQUEST_VIEW,
  );
}

/**
 * Plans the agent's queued code files, then lists how the automatic policy reads each attachment
 * as `file_inventory`. The planner runs first in the same call, so the inventory restates its
 * destinations and a re-plan re-renders both. Classic routing, and a turn that loads no file
 * tool, write no inventory and leave the File Search advert alone.
 */
export function prepareAgentFileContext(
  agent: CodeFileAgent & ReadingAgent,
  contexts: Iterable<ProvisionToolContext>,
  userId?: string,
  useAdvertisedNames = false,
  { filters, receivesRequest = true }: AgentFileContextOptions = {},
): void {
  prepareQueuedCodeFileContext(agent, contexts, userId, useAdvertisedNames);
  if (agent.dynamicToolContextMap) {
    delete agent.dynamicToolContextMap[INVENTORY_KEY];
  }
  if (
    resolveLLMDeliveryPolicy(agent.deliveryRouting?.endpointConfig) !== 'automatic' ||
    !hasFileToolConsumer(agent.fileConsumers)
  ) {
    return;
  }
  const entries = collectInventoryEntries(agent);
  reconcileSearchAdvert(agent, entries);
  const inventory = renderFileInventory(entries, { receivesRequest });
  if (!inventory) {
    return;
  }
  if (filters) {
    assertModelBoundContent({ filters, files: [{ content: inventory }] });
  }
  agent.dynamicToolContextMap ??= {};
  agent.dynamicToolContextMap[INVENTORY_KEY] = inventory;
}
