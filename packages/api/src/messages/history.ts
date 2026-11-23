import { Constants } from 'librechat-data-provider';

/** Fields the history read selects beyond the default projection. */
const HISTORY_SELECT = '+privateTextTokens';

/**
 * Share of a conversation's rows a branch-only read must skip to be worth issuing. The narrowed
 * query sends every branch id to the database, so a long conversation with one regenerated answer
 * would send thousands of ids to skip a single row: measured locally, that read is no faster than
 * the whole-conversation one until about a tenth of the rows are off the branch.
 */
const MIN_SKIPPED_SHARE = 0.1;

/** One message reduced to the fields the branch walks read. */
export interface BranchLinkRow {
  messageId: string;
  parentMessageId?: string | null;
  isCreatedByUser?: boolean;
  reasoningOverride?: unknown;
}

/**
 * The link rows a request read for `user` and `conversationId`, with the head of the branch the
 * turn extends. They ride on the request so the same turn's history read can fetch that branch
 * alone instead of reading the conversation a second time in full.
 */
export interface BranchLinks {
  user: string;
  conversationId: string;
  parentMessageId: string;
  rows: readonly BranchLinkRow[];
}

/** The part of a request the history read consumes. */
export interface BranchLinksCarrier {
  branchLinks?: BranchLinks;
}

export interface HistoryFilter {
  conversationId: string;
  user?: string | null;
  messageId?: { $in: string[] };
}

/**
 * The rows on the branch that ends at `head`, newest first. This is the parent walk the history
 * builder makes, run to the branch root: it never stops at a checkpoint summary. It ends at a
 * missing parent, at the root sentinel, or when a row repeats.
 */
export function walkBranch(rows: readonly BranchLinkRow[], head: string): BranchLinkRow[] {
  const byId = new Map<string, BranchLinkRow>();
  for (const row of rows) {
    if (!byId.has(row.messageId)) {
      byId.set(row.messageId, row);
    }
  }
  const branch: BranchLinkRow[] = [];
  const visited = new Set<string>();
  let id: string | null | undefined = head;
  while (id != null && id !== Constants.NO_PARENT && !visited.has(id)) {
    visited.add(id);
    const row = byId.get(id);
    if (row == null) {
      break;
    }
    branch.push(row);
    id = row.parentMessageId;
  }
  return branch;
}

/**
 * The ids to fetch when the links describe this read and enough of the conversation is on other
 * branches. `undefined` means read the conversation in full: the links are for another read, the
 * head is not among them (it was saved after they were read), or the branch is all or nearly all
 * of the rows, so narrowing gains nothing.
 */
function selectBranchIds(
  links: BranchLinks | undefined,
  user: string | null | undefined,
  conversationId: string,
  parentMessageId: string | null | undefined,
): string[] | undefined {
  if (
    links == null ||
    parentMessageId == null ||
    links.user !== user ||
    links.conversationId !== conversationId ||
    links.parentMessageId !== parentMessageId
  ) {
    return undefined;
  }
  const branch = walkBranch(links.rows, parentMessageId);
  const skipped = links.rows.length - branch.length;
  if (branch.length === 0 || skipped < links.rows.length * MIN_SKIPPED_SHARE) {
    return undefined;
  }
  return branch.map((row) => row.messageId);
}

/**
 * Reads the rows a turn's history walk starts from. When the request middleware already read this
 * conversation's link rows for the same head, a conversation with enough rows on other branches
 * fetches only the active branch; every other case is the whole-conversation read it always was. The fetch runs to
 * the branch root so the retained-answer scan, which reads past a checkpoint summary, still finds
 * every row it walks.
 *
 * The stash is consumed here, matched or not, so a long-lived streaming request does not keep it.
 */
export async function loadHistoryRows<T>({
  getMessages,
  user,
  conversationId,
  parentMessageId,
  request,
}: {
  getMessages: (filter: HistoryFilter, select: string) => Promise<T[] | null | undefined>;
  user?: string | null;
  conversationId: string;
  parentMessageId?: string | null;
  request?: BranchLinksCarrier | null;
}): Promise<T[]> {
  const links = request?.branchLinks;
  if (request != null) {
    delete request.branchLinks;
  }
  const ids = selectBranchIds(links, user, conversationId, parentMessageId);
  const filter: HistoryFilter =
    ids == null ? { conversationId, user } : { conversationId, user, messageId: { $in: ids } };
  return (await getMessages(filter, HISTORY_SELECT)) ?? [];
}
