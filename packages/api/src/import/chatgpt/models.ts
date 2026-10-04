const EXACT_SENDERS: Record<string, string> = {
  research: 'Deep Research',
};

const SUFFIX_LABELS: Record<string, string> = {
  thinking: 'Thinking',
  pro: 'Pro',
  instant: 'Instant',
  mini: 'mini',
  auto: 'Auto',
  t: 'Thinking',
};

/**
 * ChatGPT encodes minor versions with a hyphen (`gpt-5-5` is GPT-5.5), so the
 * first trailing numeric segment folds into the version with a dot and any
 * remaining segments become a labelled suffix.
 */
function prettifyGptSlug(rest: string): string {
  const segments = rest.split('-');
  const [major, ...tail] = segments;
  let version = major;
  let index = 0;

  if (tail.length > 0 && /^\d+$/.test(tail[0])) {
    version = `${major}.${tail[0]}`;
    index = 1;
  }

  const suffixes = tail
    .slice(index)
    .map((segment) => SUFFIX_LABELS[segment] ?? segment)
    .join(' ');

  return suffixes ? `GPT-${version} ${suffixes}` : `GPT-${version}`;
}

export function resolveModel(
  slug: string | undefined,
  fallback: string,
): { model: string; sender: string } {
  const model = slug || fallback;

  const exact = EXACT_SENDERS[model];
  if (exact) {
    return { model, sender: exact };
  }

  const gptMatch = model.match(/^gpt-(.+)$/i);
  if (!gptMatch) {
    return { model, sender: model };
  }

  return { model, sender: prettifyGptSlug(gptMatch[1]) };
}
