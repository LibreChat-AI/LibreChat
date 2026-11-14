import { Tools } from 'librechat-data-provider';
import type { SearchResultData, TAttachment, ValidSource } from 'librechat-data-provider';

/** Host of a result link, without the scheme or a leading `www.`. */
export function getCleanDomain(url: string): string {
  const domain = url.replace(/(^\w+:|^)\/\//, '').split('/')[0];
  return domain.startsWith('www.') ? domain.substring(4) : domain;
}

/** Every distinct source across the given search turns, last write wins per link. */
export function collectSources(results: Record<string, SearchResultData>): ValidSource[] {
  const sourceMap = new Map<string, ValidSource>();
  for (const result of Object.values(results)) {
    if (!result) {
      continue;
    }
    result.organic?.forEach((source) => {
      if (source.link) {
        sourceMap.set(source.link, source);
      }
    });
    result.topStories?.forEach((source) => {
      if (source.link) {
        sourceMap.set(source.link, source);
      }
    });
  }
  return Array.from(sourceMap.values());
}

/** The first `max` sources with distinct domains, in result order. */
export function getUniqueDomainSources(sources: ValidSource[], max: number): ValidSource[] {
  const seen = new Set<string>();
  const result: ValidSource[] = [];
  for (const source of sources) {
    const domain = getCleanDomain(source.link);
    if (seen.has(domain)) {
      continue;
    }
    seen.add(domain);
    result.push(source);
    if (result.length >= max) {
      break;
    }
  }
  return result;
}

const NO_DOMAINS: string[] = [];

/**
 * The domains a collapsed header can show in place of the generic search
 * glyph. A header stands for rows it hides, so it should carry the most
 * specific glyph those rows show. For a web search, that is the sites it read.
 * Only ownership-filtered attachments qualify, including live SSE snapshots.
 * Message-wide search context is derived from those same attachments but loses
 * call, agent and step ownership. Repeated turn numbers are local to each owner.
 * Returns a shared empty array when there are none, so a memoized consumer
 * does not see a new value on every attachment churn.
 */
export function getSourceDomains(attachments: TAttachment[] | undefined, max: number): string[] {
  const turns: Record<string, SearchResultData> = {};
  for (const attachment of attachments ?? []) {
    const data = attachment.type === Tools.web_search ? attachment[Tools.web_search] : undefined;
    if (data != null) {
      const owner = JSON.stringify([
        attachment.toolCallId,
        attachment.agentId,
        attachment.stepId,
        data.turn ?? 0,
      ]);
      turns[owner] = data;
    }
  }
  const sources = getUniqueDomainSources(collectSources(turns), max);
  return sources.length === 0 ? NO_DOMAINS : sources.map((source) => getCleanDomain(source.link));
}
