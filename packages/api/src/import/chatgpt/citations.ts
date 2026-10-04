import type { SearchResultData } from 'librechat-data-provider';
import type {
  ChatGptMessage,
  ImportedCitations,
  ChatGptSearchEntry,
  ChatGptLegacyCitation,
  ChatGptContentReference,
} from '~/import/types';
import { safeSourceUrl } from '~/import/url';

type OrganicSource = NonNullable<SearchResultData['organic']>[number];

const COMPOSITE_PATTERN = /[\s\S]*?/g;
const ANCHOR_PATTERN = /turn\d+(?:search|image|news|video|ref|file)\d+/g;
const MARKER_PATTERN = /[-]/g;
const LEGACY_MARKER_PATTERN = /【\d+(?::\d+)?†[^【】]*】/g;

const CITABLE_TYPES = new Set([
  'grouped_webpages',
  'grouped_webpages_model_predicted_fallback',
  'webpage',
  'webpage_extended',
  'image_v2',
  'video',
  'file',
]);

interface GroupSpan {
  start: number;
  end: number;
}

function stripMarkers(value: string): string {
  return value
    .replace(ANCHOR_PATTERN, '')
    .replace(MARKER_PATTERN, '')
    .replace(LEGACY_MARKER_PATTERN, '');
}

/**
 * Composites are matched first and their spans then exclude any standalone
 * anchors nested inside them, so each citation is counted exactly once.
 */
function findGroups(text: string): GroupSpan[] {
  const groups: GroupSpan[] = [];

  COMPOSITE_PATTERN.lastIndex = 0;
  let composite: RegExpExecArray | null;
  while ((composite = COMPOSITE_PATTERN.exec(text)) !== null) {
    groups.push({ start: composite.index, end: composite.index + composite[0].length });
  }

  ANCHOR_PATTERN.lastIndex = 0;
  let anchor: RegExpExecArray | null;
  while ((anchor = ANCHOR_PATTERN.exec(text)) !== null) {
    const start = anchor.index;
    const nested = groups.some((group) => start >= group.start && start < group.end);
    if (!nested) {
      groups.push({ start, end: start + anchor[0].length });
    }
  }

  return groups.sort((a, b) => a.start - b.start);
}

function findLegacyGroups(text: string): GroupSpan[] {
  const groups: GroupSpan[] = [];
  LEGACY_MARKER_PATTERN.lastIndex = 0;
  let marker: RegExpExecArray | null;
  while ((marker = LEGACY_MARKER_PATTERN.exec(text)) !== null) {
    groups.push({ start: marker.index, end: marker.index + marker[0].length });
  }
  return groups;
}

function fromEntry(entry: ChatGptSearchEntry): OrganicSource | null {
  const link = safeSourceUrl(entry.url);
  if (!link) {
    return null;
  }
  return {
    link,
    title: entry.title ?? undefined,
    snippet: entry.snippet ?? undefined,
    attribution: entry.attributions ?? undefined,
  };
}

function sourcesOfReference(reference: ChatGptContentReference): OrganicSource[] {
  const items = reference.items ?? reference.sources;
  if (items?.length) {
    return items.map(fromEntry).filter((source): source is OrganicSource => source !== null);
  }
  const link = safeSourceUrl(reference.url);
  if (!link) {
    return [];
  }
  return [
    {
      link,
      title: reference.title ?? undefined,
      snippet: reference.snippet ?? undefined,
      attribution: reference.attribution ?? undefined,
    },
  ];
}

function citableReferences(message: ChatGptMessage): ChatGptContentReference[] {
  const references = message.metadata?.content_references ?? [];
  return references.filter((reference) => CITABLE_TYPES.has(reference.type));
}

function legacyReferences(message: ChatGptMessage): ChatGptContentReference[] {
  const citations = message.metadata?.citations ?? [];
  return [...citations]
    .filter(
      (
        citation,
      ): citation is ChatGptLegacyCitation & {
        metadata: NonNullable<ChatGptLegacyCitation['metadata']>;
      } => citation.metadata != null,
    )
    .sort((a, b) => (a.start_ix ?? 0) - (b.start_ix ?? 0))
    .map(({ metadata }) => ({
      type: metadata.type ?? 'webpage',
      alt: null,
      url: metadata.url,
      title: metadata.title,
      snippet: metadata.text,
      pub_date: metadata.pub_date,
    }));
}

function appendSources(text: string, references: ChatGptContentReference[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const reference of references) {
    for (const source of sourcesOfReference(reference)) {
      if (seen.has(source.link)) {
        continue;
      }
      seen.add(source.link);
      lines.push(`- [${source.title ?? source.attribution ?? source.link}](${source.link})`);
    }
  }

  if (lines.length === 0) {
    return text;
  }

  return `${text}\n\n**Sources**\n${lines.join('\n')}`;
}

function renumber(
  text: string,
  groups: GroupSpan[],
  references: ChatGptContentReference[],
): { text: string; sources: OrganicSource[] } {
  const sources: OrganicSource[] = [];
  const segments: string[] = [];
  let cursor = 0;

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index];
    segments.push(stripMarkers(text.slice(cursor, group.start)));
    cursor = group.end;

    const groupSources = sourcesOfReference(references[index]);
    if (groupSources.length === 0) {
      continue;
    }

    const anchors = groupSources
      .map((source) => {
        sources.push(source);
        return `turn0search${sources.length - 1}`;
      })
      .join('');

    segments.push(groupSources.length > 1 ? `${anchors}` : anchors);
  }

  segments.push(stripMarkers(text.slice(cursor)));
  return { text: segments.join(''), sources };
}

/**
 * Anchors are renumbered against a freshly built source array rather than
 * trusting the exported indices, which do not address any array present in the
 * export. Renumbering only runs when the group and reference counts match; any
 * other shape falls back to a plain sources list so no claim is ever attributed
 * to a source ChatGPT did not cite.
 */
export function buildCitations(
  message: ChatGptMessage,
  text: string,
): { text: string; citations: ImportedCitations[] } {
  const groups = findGroups(text);
  const references = citableReferences(message);

  if (groups.length === 0) {
    const legacyGroups = findLegacyGroups(text);
    if (legacyGroups.length > 0) {
      const legacy = legacyReferences(message);
      if (legacyGroups.length !== legacy.length) {
        return { text: appendSources(stripMarkers(text), legacy), citations: [] };
      }
      const { text: rewritten, sources } = renumber(text, legacyGroups, legacy);
      return sources.length > 0
        ? { text: rewritten, citations: [{ turn: 0, data: { turn: 0, organic: sources } }] }
        : { text: rewritten, citations: [] };
    }
    return { text: stripMarkers(text), citations: [] };
  }

  if (groups.length !== references.length) {
    return { text: appendSources(stripMarkers(text), references), citations: [] };
  }

  const { text: rewritten, sources } = renumber(text, groups, references);
  if (sources.length === 0) {
    return { text: rewritten, citations: [] };
  }

  return { text: rewritten, citations: [{ turn: 0, data: { turn: 0, organic: sources } }] };
}
