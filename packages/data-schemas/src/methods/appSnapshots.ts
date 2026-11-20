import mongoose from 'mongoose';
import {
  Tools,
  isMcpAppMimeType,
  DEFAULT_MCP_APP_MESSAGE_BYTES,
  MAX_MCP_APP_MESSAGE_BYTES,
} from 'librechat-data-provider';

/** Leave 4 MiB for timestamps, metadata, later receipts and other non-App message fields. */
export const MAX_MCP_APP_MESSAGE_BSON_BYTES: number = DEFAULT_MCP_APP_MESSAGE_BYTES;
/** Separate canonical-only ceiling; an App target must not reject otherwise persistable text. */
const CANONICAL_MESSAGE_BSON_BYTES = 16 * 1024 * 1024 - 16 * 1024;

type Resource = Record<string, unknown>;
type Attachment = Record<string, unknown>;

function isBoundAppResource(value: unknown): value is Resource {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const resource = value as Resource;
  return (
    typeof resource.uri === 'string' &&
    typeof resource.serverBinding === 'string' &&
    typeof resource.mimeType === 'string' &&
    isMcpAppMimeType(resource.mimeType)
  );
}

function appResources(attachment: unknown): unknown[] | undefined {
  if (attachment == null || typeof attachment !== 'object' || Array.isArray(attachment)) return;
  const value = attachment as Attachment;
  return value.type === Tools.ui_resources && Array.isArray(value[Tools.ui_resources])
    ? value[Tools.ui_resources]
    : undefined;
}

export function hasBoundAppSnapshots(attachments: unknown): boolean {
  return (
    Array.isArray(attachments) &&
    attachments.some((attachment) => appResources(attachment)?.some(isBoundAppResource))
  );
}

/** Preserve result, arguments, URI, identity and binding; remove only the optional View document. */
function uriOnly(resource: Resource): Resource {
  const descriptor = { ...resource };
  delete descriptor.text;
  delete descriptor.blob;
  delete descriptor.csp;
  delete descriptor.permissions;
  delete descriptor._meta;
  return descriptor;
}

/**
 * Called only for messages containing a bound App. The caller supplies BSON size of the ENTIRE
 * candidate document, not just its attachments. Work on copies, so a later full-row save with the
 * original in-memory attachments cannot sneak an oversized document back into storage.
 *
 * Estimates are used only to pick the largest documents to drop first. The final BSON calculation
 * is exact; if the candidate still exceeds the budget we omit all optional Apps or fail explicitly
 * when the canonical message / non-App attachments alone are too large.
 */
export function fitBoundAppSnapshots(
  attachments: unknown[],
  bsonSize: (attachments: unknown[]) => number,
  maxBytes: number = MAX_MCP_APP_MESSAGE_BSON_BYTES,
): unknown[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_MCP_APP_MESSAGE_BYTES) {
    throw new Error('Invalid deployment MCP App message budget');
  }
  const size = bsonSize(attachments);
  if (size <= maxBytes) return attachments;

  const result: unknown[] = attachments.slice();
  const changes: Array<{ attachment: number; resource: number; saving: number }> = [];
  for (let i = 0; i < attachments.length; i++) {
    const resources = appResources(attachments[i]);
    if (!resources) continue;
    for (let j = 0; j < resources.length; j++) {
      const resource = resources[j];
      if (!isBoundAppResource(resource)) continue;
      const descriptor = uriOnly(resource);
      const saving =
        mongoose.mongo.BSON.calculateObjectSize({ resource }) -
        mongoose.mongo.BSON.calculateObjectSize({ resource: descriptor });
      changes.push({ attachment: i, resource: j, saving });
    }
  }
  changes.sort((a, b) => b.saving - a.saving);

  let remaining = size;
  for (const { attachment, resource, saving } of changes) {
    if (remaining <= maxBytes) break;
    if (saving <= 0) continue;
    const original = result[attachment] as Attachment;
    const resources = appResources(original);
    if (!resources) continue;
    const next = resources.slice();
    next[resource] = uriOnly(next[resource] as Resource);
    result[attachment] = { ...original, [Tools.ui_resources]: next };
    remaining -= saving;
  }
  if (bsonSize(result) <= maxBytes) return result;

  // The descriptor can itself contain a large tool result or args. Remove only bound Apps;
  // ordinary/legacy resources and unrelated attachments are never sacrificed.
  for (let i = 0; i < result.length; i++) {
    const original = result[i] as Attachment;
    const resources = appResources(original);
    if (!resources?.some(isBoundAppResource)) continue;
    const keep = resources.filter((value) => !isBoundAppResource(value));
    result[i] = keep.length ? { ...original, [Tools.ui_resources]: keep } : null;
  }
  const withoutApps = result.filter((attachment) => attachment != null);
  if (bsonSize(withoutApps) <= CANONICAL_MESSAGE_BSON_BYTES) return withoutApps;

  throw new Error('Message exceeds the BSON budget without optional MCP App snapshots');
}
