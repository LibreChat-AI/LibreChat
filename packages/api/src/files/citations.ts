export interface FileCitationSource {
  fileId: string;
  relevance: number;
}

export interface FileCitationSelectionConfig {
  maxCitations?: number;
  maxCitationsPerFile?: number;
  minRelevanceScore?: number;
}

export function applyCitationLimits<TSource extends FileCitationSource>(
  sources: readonly TSource[],
  maxCitations: number,
  maxCitationsPerFile: number,
): TSource[] {
  const byFile = new Map<string, TSource[]>();
  for (const source of sources) {
    const fileSources = byFile.get(source.fileId) ?? [];
    fileSources.push(source);
    byFile.set(source.fileId, fileSources);
  }

  const representatives: TSource[] = [];
  for (const fileSources of byFile.values()) {
    representatives.push(
      ...fileSources.sort((a, b) => b.relevance - a.relevance).slice(0, maxCitationsPerFile),
    );
  }

  return representatives.sort((a, b) => b.relevance - a.relevance).slice(0, maxCitations);
}

/** Selects the passages shared by model anchors and browser citation attachments. */
export function selectFileCitationSources<TSource extends FileCitationSource>(
  sources: readonly TSource[] | null | undefined,
  config?: FileCitationSelectionConfig,
): TSource[] {
  return applyCitationLimits(
    (sources ?? []).filter((source) => source.relevance >= (config?.minRelevanceScore ?? 0.45)),
    config?.maxCitations ?? 30,
    config?.maxCitationsPerFile ?? 5,
  );
}
