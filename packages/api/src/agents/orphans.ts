import { EToolResources } from 'librechat-data-provider';
import type { AgentToolResources } from 'librechat-data-provider';

/**
 * Every `EToolResources` member that can carry `file_ids` on an agent document.
 * `code_interpreter` is intentionally omitted — it's part of `EToolResources`
 * for the Assistants API but not a key of the agent-side `AgentToolResources`
 * shape, so including it would be a type lie and generate dead MongoDB clauses.
 */
export const TOOL_RESOURCE_KEYS: ReadonlyArray<keyof AgentToolResources> = [
  EToolResources.execute_code,
  EToolResources.file_search,
  EToolResources.image_edit,
  EToolResources.context,
  EToolResources.ocr,
];

/**
 * Collects every file_id referenced across all tool_resource categories.
 * Duplicates are de-duplicated across categories.
 */
export function collectToolResourceFileIds(
  tool_resources: AgentToolResources | undefined | null,
): string[] {
  if (!tool_resources) {
    return [];
  }
  const seen = new Set<string>();
  for (const key of TOOL_RESOURCE_KEYS) {
    const ids = tool_resources[key]?.file_ids;
    if (!Array.isArray(ids)) {
      continue;
    }
    for (const id of ids) {
      if (typeof id === 'string') {
        seen.add(id);
      }
    }
  }
  return Array.from(seen);
}

/**
 * Converts client-hydrated file objects into identifiers and removes the
 * untrusted object payloads. Runtime file records must always be reloaded from
 * canonical storage after the normal ownership checks.
 */
export function normalizeToolResourceFiles(
  tool_resources: AgentToolResources | undefined | null,
): AgentToolResources | undefined | null {
  if (!tool_resources) {
    return tool_resources;
  }
  for (const key of TOOL_RESOURCE_KEYS) {
    const resource = tool_resources[key];
    if (!resource) {
      continue;
    }
    const ids = new Set(Array.isArray(resource.file_ids) ? resource.file_ids : []);
    if (Array.isArray(resource.files)) {
      for (const file of resource.files) {
        if (typeof file?.file_id === 'string') {
          ids.add(file.file_id);
        }
      }
    }
    if (ids.size > 0 || Array.isArray(resource.file_ids)) {
      resource.file_ids = Array.from(ids);
    }
    delete resource.files;
  }
  return tool_resources;
}

/**
 * Removes the given file_ids from every tool_resource category on the provided
 * tool_resources object. Mutates in place and also returns the same reference
 * for convenience. Returns the count of removed references.
 */
export function stripFileIdsFromToolResources(
  tool_resources: AgentToolResources | undefined | null,
  idsToRemove: Iterable<string>,
): { tool_resources: AgentToolResources | undefined | null; removedCount: number } {
  if (!tool_resources) {
    return { tool_resources, removedCount: 0 };
  }
  const removeSet = idsToRemove instanceof Set ? idsToRemove : new Set(idsToRemove);
  if (removeSet.size === 0) {
    return { tool_resources, removedCount: 0 };
  }
  let removedCount = 0;
  for (const key of TOOL_RESOURCE_KEYS) {
    const resource = tool_resources[key];
    if (!resource || !Array.isArray(resource.file_ids)) {
      continue;
    }
    const before = resource.file_ids.length;
    resource.file_ids = resource.file_ids.filter((id) => !removeSet.has(id));
    removedCount += before - resource.file_ids.length;
  }
  return { tool_resources, removedCount };
}
