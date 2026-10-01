import { Tools } from 'librechat-data-provider';
import type { SearchResultData } from 'librechat-data-provider';
import type { ClaudeCitation, ImportAttachment } from '~/import/types';
import { safeSourceUrl } from '~/import/url';

type OrganicSource = NonNullable<SearchResultData['organic']>[number];

/** Citation markers the client's markdown plugin (`client/src/utils/citations.ts`)
 * recognises. A highlighted span is `\ue203 … \ue204` followed
 * immediately by one anchor, or by a group of anchors wrapped in
 * `\ue200 … \ue201`. */
const SPAN_OPEN = '\ue203';
const SPAN_CLOSE = '\ue204';
const ANCHOR = '\ue202';
const GROUP_OPEN = '\ue200';
const GROUP_CLOSE = '\ue201';

const FENCE_PATTERN = /^[ \t]*(?:```|~~~)/gm;
const INLINE_CODE_PATTERN = /`[^`\n]+`/g;

/** Per-message source list backing every `turnNsearchI` anchor in that message.
 * Deduplicated by link so a URL cited three times and also returned by
 * `web_search` resolves to one index. */
export interface SourceIndex {
  byLink: Map<string, number>;
  sources: OrganicSource[];
}

interface CodeRegion {
  start: number;
  end: number;
}

interface Insertion {
  position: number;
  marker: string;
}

interface CitationGroup {
  start: number;
  end: number;
  indices: number[];
}

export function createSourceIndex(): SourceIndex {
  return { byLink: new Map(), sources: [] };
}

/**
 * Registers a source and returns its anchor index. A link seen before keeps its
 * original index; a repeat carrying a title or snippet the first sighting
 * lacked upgrades the stored entry, so a bare citation URL is enriched by the
 * `web_search` result for the same page.
 */
export function addSource(index: SourceIndex, source: OrganicSource): number {
  const existingIndex = index.byLink.get(source.link);
  if (existingIndex === undefined) {
    index.byLink.set(source.link, index.sources.length);
    index.sources.push(source);
    return index.sources.length - 1;
  }

  const existing = index.sources[existingIndex];
  if (!existing.title && source.title) {
    existing.title = source.title;
  }
  if (!existing.snippet && source.snippet) {
    existing.snippet = source.snippet;
  }
  if (!existing.attribution && source.attribution) {
    existing.attribution = source.attribution;
  }
  return existingIndex;
}

export function buildSearchAttachment(index: SourceIndex): ImportAttachment | undefined {
  if (index.sources.length === 0) {
    return undefined;
  }
  return {
    type: Tools.web_search,
    [Tools.web_search]: { turn: 0, organic: index.sources },
  };
}

/**
 * Fenced blocks and inline code spans, where the client's citation plugin never
 * runs: it only visits markdown text nodes, so a marker landing inside code is
 * rendered verbatim as a private-use glyph instead of being consumed.
 */
function findCodeRegions(text: string): CodeRegion[] {
  const regions: CodeRegion[] = [];

  FENCE_PATTERN.lastIndex = 0;
  let open: number | null = null;
  let fence: RegExpExecArray | null;
  while ((fence = FENCE_PATTERN.exec(text)) !== null) {
    if (open === null) {
      open = fence.index;
      continue;
    }
    regions.push({ start: open, end: fence.index + fence[0].length });
    open = null;
  }
  if (open !== null) {
    regions.push({ start: open, end: text.length });
  }

  INLINE_CODE_PATTERN.lastIndex = 0;
  let inline: RegExpExecArray | null;
  while ((inline = INLINE_CODE_PATTERN.exec(text)) !== null) {
    const start = inline.index;
    const nested = regions.some((region) => start >= region.start && start < region.end);
    if (!nested) {
      regions.push({ start, end: start + inline[0].length });
    }
  }

  return regions;
}

function isInsideCode(position: number, regions: CodeRegion[]): boolean {
  for (const region of regions) {
    if (position > region.start && position < region.end) {
      return true;
    }
  }
  return false;
}

function sourceOfCitation(citation: ClaudeCitation): OrganicSource | null {
  const url = safeSourceUrl(citation.details?.url);
  if (!url) {
    return null;
  }
  return { link: url };
}

/**
 * Collapses citations onto their spans in one pass. Claude emits one citation
 * per source, so several citations can share identical offsets; those become a
 * single group rendered as a composite anchor list. A citation whose offsets are
 * unusable (out of bounds, empty, or landing inside a code region) still
 * registers its source (so it stays listed in the message's sources) but
 * contributes no marker.
 */
function groupCitations(
  text: string,
  citations: ClaudeCitation[],
  index: SourceIndex,
  regions: CodeRegion[],
): CitationGroup[] {
  const groups = new Map<string, CitationGroup>();

  for (const citation of citations) {
    const source = sourceOfCitation(citation);
    if (!source) {
      continue;
    }
    const anchorIndex = addSource(index, source);
    const { start_index: start, end_index: end } = citation;

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > text.length ||
      start >= end ||
      isInsideCode(start, regions) ||
      isInsideCode(end, regions)
    ) {
      continue;
    }

    const key = `${start}:${end}`;
    const group = groups.get(key);
    if (group) {
      group.indices.push(anchorIndex);
      continue;
    }
    groups.set(key, { start, end, indices: [anchorIndex] });
  }

  return Array.from(groups.values()).sort((a, b) => a.start - b.start);
}

function anchorsOf(indices: number[]): string {
  const anchors = indices.map((index) => `${ANCHOR}turn0search${index}`).join('');
  return indices.length > 1 ? `${GROUP_OPEN}${anchors}${GROUP_CLOSE}` : anchors;
}

/**
 * Drops overlapping groups so every `SPAN_OPEN` is closed by the next
 * `SPAN_CLOSE`. Claude's real offsets never partially overlap, but a nested pair
 * would make the client's non-greedy span regex pair the wrong markers.
 */
function selectDisjoint(groups: CitationGroup[]): CitationGroup[] {
  const selected: CitationGroup[] = [];
  let lastEnd = 0;
  for (const group of groups) {
    if (group.start < lastEnd) {
      continue;
    }
    selected.push(group);
    lastEnd = group.end;
  }
  return selected;
}

/**
 * Wraps each cited range in highlight markers and appends its anchors.
 *
 * Insertions are applied back to front: every offset Claude reports indexes the
 * original string, so splicing at the highest offset first leaves all lower
 * offsets valid. Applying them forwards would shift every later offset by the
 * length of the markers already inserted.
 */
export function applyCitations(
  text: string,
  citations: ClaudeCitation[] | null | undefined,
  index: SourceIndex,
): string {
  if (!citations?.length || text.length === 0) {
    return text;
  }

  const regions = findCodeRegions(text);
  const groups = selectDisjoint(groupCitations(text, citations, index, regions));
  if (groups.length === 0) {
    return text;
  }

  const insertions: Insertion[] = [];
  for (const group of groups) {
    insertions.push({ position: group.start, marker: SPAN_OPEN });
    insertions.push({ position: group.end, marker: `${SPAN_CLOSE}${anchorsOf(group.indices)}` });
  }

  let cited = text;
  for (let i = insertions.length - 1; i >= 0; i--) {
    const { position, marker } = insertions[i];
    cited = `${cited.slice(0, position)}${marker}${cited.slice(position)}`;
  }
  return cited;
}
