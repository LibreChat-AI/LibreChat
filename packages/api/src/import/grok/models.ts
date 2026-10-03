const SUFFIX_LABELS: Record<string, string> = {
  thinking: 'Thinking',
  reasoning: 'Reasoning',
  mini: 'mini',
  auto: 'Auto',
  fast: 'Fast',
  heavy: 'Heavy',
};

const DEFAULT_SENDER = 'Grok';

/**
 * Turns a Grok slug into a display name.
 *
 * A real export's slugs carry build noise the reader has no use for: a build
 * date (`-1129`, `-1108b`), a revision (`-v2`), a rollout size (`-s320`), a
 * codename (`-tahoe`) or an internal flag (`-w-tool`, `-memory`). Only labelled
 * segments survive, so `grok-4-1-thinking-1129` and `grok-4-1-thinking-1108b`
 * both read as "Grok 4.1 Thinking" while the raw slug stays on the message.
 *
 * Minor versions arrive in two encodings, hyphenated like ChatGPT's
 * (`grok-4-1` is Grok 4.1) and with a `p` separator (`grok-4p3` is Grok 4.3),
 * and `non-thinking` marks the base model rather than a variant, so both of its
 * segments are dropped.
 */
function prettifyGrokSlug(rest: string): string {
  const [head, ...tail] = rest.split('-');
  const version = head.replace(/^(\d+)p(\d+)$/, '$1.$2');

  const foldsMinor = tail.length > 0 && /^\d+$/.test(head) && /^\d+$/.test(tail[0]);
  const label = foldsMinor ? `${version}.${tail[0]}` : version;

  const suffixes: string[] = [];
  for (let index = foldsMinor ? 1 : 0; index < tail.length; index++) {
    if (tail[index] === 'non') {
      index += 1;
      continue;
    }
    const suffix = SUFFIX_LABELS[tail[index]];
    if (suffix) {
      suffixes.push(suffix);
    }
  }

  return suffixes.length > 0
    ? `${DEFAULT_SENDER} ${label} ${suffixes.join(' ')}`
    : `${DEFAULT_SENDER} ${label}`;
}

/**
 * Resolves the model to persist and the sender to display for one response.
 *
 * A blank `model` is not a user-turn marker: a real export leaves it blank on
 * 156 assistant responses (149 of which carry text) while stamping a real slug
 * on 210 human ones, so it falls back to the endpoint's default model and the
 * plain provider name rather than being read as a role.
 */
export function resolveGrokModel(
  slug: string | null | undefined,
  fallback: string,
): { model: string; sender: string } {
  if (!slug) {
    return { model: fallback, sender: DEFAULT_SENDER };
  }

  const match = slug.match(/^grok-(.+)$/i);
  if (!match) {
    return { model: slug, sender: /^grok$/i.test(slug) ? DEFAULT_SENDER : slug };
  }

  return { model: slug, sender: prettifyGrokSlug(match[1]) };
}
