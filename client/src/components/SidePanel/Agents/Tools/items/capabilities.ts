import { AgentCapabilities, EToolResources, Tools } from 'librechat-data-provider';
import type { AgentForm, TAgentOption } from '~/common';

/**
 * Built-in capabilities whose selection is backed by attached files. These are on
 * while they hold files: the builder routes their removal to the file manager rather
 * than the capability flag, so "flag off while files remain" is a state the UI cannot
 * show and the user cannot reach deliberately.
 *
 * Display, removal and persistence all derive from this table. They used to encode the
 * rule separately and drifted — the builder showed File Search as selected off the file
 * count while the save wrote it off the flag alone, so the tool was silently dropped
 * from an agent that still listed its knowledge files.
 */
export const FILE_BACKED_CAPABILITIES = [
  {
    capability: AgentCapabilities.file_search,
    tool: Tools.file_search,
    files: 'knowledge_files',
    resource: EToolResources.file_search,
  },
  {
    capability: AgentCapabilities.execute_code,
    tool: Tools.execute_code,
    files: 'code_files',
    resource: EToolResources.execute_code,
  },
] as const;

export type FileBackedCapability = (typeof FILE_BACKED_CAPABILITIES)[number];

/** Built-in capabilities that are a plain on/off flag, with no files behind them. */
const FLAG_ONLY_CAPABILITIES = [
  { capability: AgentCapabilities.web_search, tool: Tools.web_search },
  { capability: AgentCapabilities.memory, tool: Tools.memory },
] as const;

/**
 * How many files an agent holds for a file-backed capability. Prefers the hydrated
 * form entries and falls back to the persisted ids, which are all that exist before
 * the file map hydrates — a save during that window must not read "no files" and
 * drop the tool.
 */
export function countCapabilityFiles(
  agent: TAgentOption | undefined,
  { files, resource }: Pick<FileBackedCapability, 'files' | 'resource'>,
): number {
  const entries = agent?.[files];
  if (entries != null) {
    return entries.length;
  }
  return agent?.tool_resources?.[resource]?.file_ids?.length ?? 0;
}

/** Whether a file-backed capability is on, given its flag and the files it holds. */
export function isFileBackedCapabilityEnabled(flag: boolean | undefined, fileCount: number) {
  return flag === true || fileCount > 0;
}

/** File counts per capability, supplied by the caller from its best source. */
export type CapabilityFileCounts = Record<FileBackedCapability['files'], number>;

/**
 * Whether removing this built-in has to go through the file manager. A capability
 * holding files cannot be switched off by clearing its flag — the row would stay
 * selected and the save would disagree with it — so the caller opens the dialog
 * where the files themselves are managed.
 *
 * Takes counts rather than the agent so a component can pass the hydrated entries it
 * already watches, while `resolveCapabilityTools` reads the form on submit where no
 * hook is available. The rule is shared; the source of the count need not be.
 */
export function requiresFileManagerRemoval(itemId: string, counts: CapabilityFileCounts): boolean {
  if (itemId === EToolResources.context) {
    return true;
  }
  const entry = FILE_BACKED_CAPABILITIES.find(({ capability }) => capability === itemId);
  if (entry == null) {
    return false;
  }
  return counts[entry.files] > 0;
}

/**
 * The built-in capability tools a submission should persist, resolved with the same
 * rule the builder displays. Returned separately from `data.tools` so the caller
 * decides how to merge them.
 */
export function resolveCapabilityTools(data: AgentForm): string[] {
  const tools: string[] = [];

  for (const entry of FILE_BACKED_CAPABILITIES) {
    const enabled = isFileBackedCapabilityEnabled(
      data[entry.capability],
      countCapabilityFiles(data.agent, entry),
    );
    if (enabled) {
      tools.push(entry.tool);
    }
  }

  for (const { capability, tool } of FLAG_ONLY_CAPABILITIES) {
    if (data[capability] === true) {
      tools.push(tool);
    }
  }

  return tools;
}
