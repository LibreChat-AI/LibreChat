import { imageExtRegex } from 'librechat-data-provider';
import type { TAttachment, TFile } from 'librechat-data-provider';

/** Sources the browser already resolves on its own. */
const ABSOLUTE_SOURCE_PATTERN = /^(?:[a-z][a-z\d+\-.]*:|\/\/)/i;

/**
 * Root-relative paths this app serves itself. One constant because two
 * questions depend on the same answer: which paths need the API base
 * (`toAbsoluteFilePath`), and which markdown sources are already an explicit
 * address rather than a name to look up (`mediaKeyFromSource`). Letting those
 * drift apart is how a source the author addressed exactly gets reduced to its
 * basename and resolved to a different attachment that shares the leaf.
 */
const SERVED_PATH_PATTERN = /^\/(?:images|api)\//i;

/** Shared instance so the overwhelmingly common "no attachments" turn keeps a
 *  referentially stable map, and every consumer memoized on it stays put. */
const EMPTY_ATTACHMENTS_BY_NAME: ReadonlyMap<string, TAttachment> = new Map<string, TAttachment>();

/**
 * Lookup key for a filename: the final path segment, lowercased. The backend
 * stores filenames as forward-slash paths regardless of host OS, so the last
 * segment is all a markdown reference and an attachment need to agree on.
 */
function mediaNameKey(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '';
  }
  const slash = trimmed.lastIndexOf('/');
  return (slash < 0 ? trimmed : trimmed.slice(slash + 1)).toLowerCase();
}

function fileKeyOf(attachment: TAttachment): string | undefined {
  const { file_id, filepath } = attachment as Partial<TFile>;
  return file_id ?? filepath;
}

function ownerOf(attachment: TAttachment): {
  toolCallId?: string;
  agentId?: string;
} {
  const owned = attachment as { toolCallId?: string; agentId?: string };
  return { toolCallId: owned.toolCallId, agentId: owned.agentId };
}

/**
 * Stable identity for an attachment: `file_id ?? filepath` scoped by
 * `toolCallId` and `agentId`, else `type:toolCallId` for unkeyed tool
 * artifacts like file_search citations. `undefined` means the row has no
 * stable identity and must never be compared to another — two entries that
 * cannot be told apart are two entries, not one.
 *
 * The ownership dimensions are not decoration. Sibling code calls can share a
 * claimed `file_id` for the same filename and handoff agents can repeat
 * provider tool ids, so `file_id` alone collapses attachments the merge in
 * `useAttachments` deliberately keeps as separate cards — which is why that
 * merge is the caller this lives next to, rather than a second definition.
 */
export function attachmentIdentity(attachment: TAttachment): string | undefined {
  const { type } = attachment as { type?: string };
  const { toolCallId, agentId } = ownerOf(attachment);
  const fileKey = fileKeyOf(attachment);
  if (fileKey) {
    if (toolCallId == null) {
      return fileKey;
    }
    return agentId ? `${fileKey}::${toolCallId}::${agentId}` : `${fileKey}::${toolCallId}`;
  }
  if (type != null && toolCallId != null) {
    return `${type}:${toolCallId}`;
  }
  return undefined;
}

/**
 * Identity for deciding whether two records render as the SAME artifact, which
 * is `attachmentIdentity` plus the host run step.
 *
 * The extra dimension is the difference between merging and rendering. The
 * merge in `useAttachments` reconciles DB rows against live SSE records, whose
 * `stepId` may not have arrived yet, so it matches wildcard-tolerantly and
 * must not split on a field one side can lack. A rendered row has no such
 * excuse: `filterAttachmentsForPart` deliberately routes records to their
 * owning part BY run step, so two executions that reuse a provider tool-call
 * id and claim the same `file_id` are two artifacts. Collapsing them would
 * drop one from the media row, which — once the fold hides the parts' own
 * copies — is the only place it appears.
 *
 * A record with no `stepId` keeps the plain identity, so a legacy row never
 * splits away from itself.
 */
export function attachmentRenderKey(attachment: TAttachment): string | undefined {
  const identity = attachmentIdentity(attachment);
  if (identity == null) {
    return undefined;
  }
  const { stepId } = attachment as { stepId?: string };
  return stepId == null ? identity : `${identity}::step:${stepId}`;
}

/**
 * Indexes a turn's attachments by the filename a markdown image would name
 * them with.
 *
 * A basename naming more than one STORED FILE is ambiguous and is dropped.
 * Nothing in `![...](output.png)` says which one the author meant, and picking
 * either renders one file under the other's caption — the only outcome worse
 * than not rendering. Dropping the name costs little: the reference renders as
 * it does today, and the media row, which never lost either file, is where
 * both stay visible.
 *
 * Only files an `<img>` can display are indexed — an image extension and a
 * fetchable path. Deliberately NOT `isImageAttachment`, which additionally
 * demands width and height: those exist so `<Image>` can reserve layout space,
 * and a markdown `<img>` needs neither. Requiring them would drop the
 * download-fallback an oversized output produces, which carries an image name
 * and a working URL and displays perfectly well.
 *
 * Identity is the stored file (`file_id ?? filepath`), not the call that
 * emitted it. One file surfacing under two calls — inherited across steps, or
 * a regeneration that updated the record in place — is one file and still
 * resolves. Two different files are ambiguous no matter who wrote them: an
 * earlier version read a same-author collision as supersession and let the
 * later file win, but a regeneration and two sibling calls that both wrote
 * `output.png` are indistinguishable from the metadata, so that guess could
 * only ever have been right by luck.
 */
export function buildAttachmentsByName(
  attachments: ReadonlyArray<TAttachment> | undefined,
): ReadonlyMap<string, TAttachment> {
  const byName = new Map<string, TAttachment>();
  const ambiguous = new Set<string>();
  for (const attachment of attachments ?? []) {
    if (!attachment?.filepath || !imageExtRegex.test(attachment.filename ?? '')) {
      continue;
    }
    const key = mediaNameKey(attachment.filename ?? '');
    if (!key || ambiguous.has(key)) {
      continue;
    }
    const claimed = byName.get(key);
    if (claimed != null && fileKeyOf(claimed) !== fileKeyOf(attachment)) {
      ambiguous.add(key);
      byName.delete(key);
      continue;
    }
    /** New, or a fresher record of the SAME file — a tool rewriting one path
     *  reuses its `file_id` and the later record carries the newer URL, so
     *  keeping the first would resolve to a stale one. Matches what
     *  `collectPhaseAttachments` and the attachment renderer both do. */
    byName.set(key, attachment);
  }
  return byName.size === 0 ? EMPTY_ATTACHMENTS_BY_NAME : byName;
}

/**
 * Absolute URL for a stored file path.
 *
 * Root-relative paths the app serves itself — `/images/…` uploads and `/api/…`
 * downloads, which is what every code-execution artifact resolves to — must
 * carry the API base or the browser requests them against the origin root and
 * they 404 under a subpath deployment. Shared with `Image` so a rendered
 * attachment and an inline reference to that same attachment cannot disagree
 * about which paths need the prefix.
 */
export function toAbsoluteFilePath(path: string, baseUrl: string): string {
  if (!path || path.startsWith('http') || path.startsWith('data:')) {
    return path;
  }
  return SERVED_PATH_PATTERN.test(path) ? `${baseUrl}${path}` : path;
}

/**
 * Lookup key for a markdown image destination, or `''` when the source is
 * already an address rather than a name — anything carrying a scheme, or a
 * root-relative path this app serves.
 *
 * A scheme is never looked up, `sandbox:` included. react-markdown's default
 * `urlTransform` allows only http/https/irc/mailto/xmpp, so a `sandbox:`
 * source is blanked before the image component ever sees it; treating it as a
 * name here would claim a file the renderer cannot display. Supporting that
 * form needs a `urlTransform` on the markdown pipeline first. The last case matters: an author writing
 * `/api/files/…/chart.png` addressed one specific file, and reducing that to
 * `chart.png` could resolve it to a different attachment sharing the leaf and
 * display the wrong image.
 */
function mediaKeyFromSource(src: string): string {
  if (ABSOLUTE_SOURCE_PATTERN.test(src) || SERVED_PATH_PATTERN.test(src)) {
    return '';
  }
  let decoded = src;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    /* A malformed escape is not a reference we can resolve; match the raw form. */
  }
  return mediaNameKey(decoded.split(/[?#]/, 1)[0]);
}

/**
 * The attachment a markdown image source refers to, or `undefined` when the
 * source is already resolvable or names nothing this turn produced — in which
 * case the caller keeps its existing behavior.
 */
export function resolveInlineMedia(
  src: string | undefined,
  byName: ReadonlyMap<string, TAttachment> | undefined,
): TAttachment | undefined {
  if (!src || byName == null || byName.size === 0) {
    return undefined;
  }
  const key = mediaKeyFromSource(src);
  return key ? byName.get(key) : undefined;
}
