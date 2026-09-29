import {
  Constants,
  splitMCPToolKey,
  normalizeServerName,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { Action } from 'librechat-data-provider';
import type { AgentItem, AgentItemKind } from './types';
import { isFileBackedCapabilityEnabled } from './capabilities';

export interface FormSelection {
  execute_code: boolean;
  web_search: boolean;
  file_search: boolean;
  memory: boolean;
  artifacts: string | undefined;
  tools: string[];
  skills: string[];
  context_files: Array<[string, unknown]>;
  knowledge_files: Array<[string, unknown]>;
  code_files: Array<[string, unknown]>;
}

const KIND_ORDER: AgentItemKind[] = ['builtin', 'mcp', 'tool', 'skill', 'action'];
const MCP_PREFIX = 'mcp_';

/**
 * Stable identity for a catalog item across kinds. IDs come from disjoint
 * namespaces (capability ids, MCP server names, pluginKeys, skill ids, action
 * ids), so selection sets must key on `kind:id` to avoid cross-kind collisions.
 */
export function itemKey(item: Pick<AgentItem, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

function isBuiltinSelected(item: AgentItem, form: FormSelection): boolean {
  if (item.kind !== 'builtin') return false;
  switch (item.id) {
    /** File-backed built-ins share their on/off rule with removal and persistence
     *  (see `capabilities.ts`), so the three cannot drift apart again. */
    case 'execute_code':
      return isFileBackedCapabilityEnabled(form.execute_code, form.code_files.length);
    case 'web_search':
      return form.web_search;
    case 'file_search':
      return isFileBackedCapabilityEnabled(form.file_search, form.knowledge_files.length);
    case 'memory':
      return form.memory;
    case 'artifacts':
      return Boolean(form.artifacts);
    case 'context':
      return form.context_files.length > 0;
    case 'ask_user_question':
      // Native tool presented as a builtin — selection lives in agent.tools.
      return form.tools.includes('ask_user_question');
    default:
      return false;
  }
}

function isToolSelected(item: AgentItem, form: FormSelection): boolean {
  if (item.kind !== 'tool') return false;
  return form.tools.includes(item.id);
}

/**
 * Server-level placeholder token (`sys__server__sys_mcp_<serverName>`). It pins
 * the server's attachment independently of tool selection, so a server stays
 * attached even with zero tools selected (deselect-all keeps the token); only
 * an explicit remove strips it.
 */
export function mcpServerToken(serverName: string): string {
  return `${Constants.mcp_server}${Constants.mcp_delimiter}${serverName}`;
}

/**
 * Server-wide wildcard token (`sys__all__sys_mcp_<serverName>`). Unlike the
 * UI-only `mcp_server` placeholder (skipped at runtime), `mcp_all` is resolved
 * by the backend into ALL of the server's tools at chat-turn time. Used for
 * ready servers whose catalog is unavailable without user credentials or chat
 * fields. Per-tool selection is unavailable, so the server attaches as a whole.
 */
export function mcpAllToken(serverName: string): string {
  return `${Constants.mcp_all}${Constants.mcp_delimiter}${serverName}`;
}

/**
 * Whether a form `tools` token references the given MCP server, across every
 * format ever persisted: the server placeholder token, the raw server name,
 * the exact `mcp_<server>` pluginKey form, and delimiter-suffixed per-tool
 * ids (`<tool>_mcp_<server>`) — in both the raw spelling (legacy documents)
 * and the normalized spelling model-facing tool ids carry
 * (`normalizeServerName`). All checks are exact or delimiter-bounded —
 * server names may contain underscores, so a bare prefix match would claim
 * `mcp_github_extra` for a server named `github`. Selection and removal must
 * share this predicate: anything the selection logic counts as attached, an
 * explicit remove must also strip, or a legacy token leaves the server
 * permanently selected.
 */
export function matchesMcpServer(
  token: string,
  serverName: string,
  allServerNames?: readonly string[],
): boolean {
  const prefixed = `${MCP_PREFIX}${serverName}`;
  const normalized = normalizeServerName(serverName);
  const aliases = allServerNames?.length ? buildServerNameAliases(allServerNames) : undefined;
  if (aliases && allServerNames) {
    /** Exact `mcp_<server>` entries need the same single-owner resolution as
     *  tool-key suffixes. A literal configured name wins over another name
     *  that merely normalizes to it; otherwise the alias registry maps the
     *  normalized spelling back to its raw owner. Without this early global
     *  check, each colliding target could independently satisfy its own exact
     *  comparison and one token would select/remove both servers. */
    if (token.startsWith(MCP_PREFIX)) {
      const exactName = token.slice(MCP_PREFIX.length);
      const exactOwner = allServerNames.includes(exactName) ? exactName : aliases.get(exactName);
      if (exactOwner != null) {
        return exactOwner === serverName;
      }
    }
  }
  if (
    token === mcpServerToken(serverName) ||
    token === serverName ||
    token === prefixed ||
    (normalized !== serverName && token === `${MCP_PREFIX}${normalized}`)
  ) {
    return true;
  }
  if (aliases && allServerNames) {
    /** Boundary-exact: resolve the token ONCE against every configured
     *  server (longest match, both spellings) — a normalized name that
     *  itself contains the delimiter (`foo mcp bar` → `foo_mcp_bar`) must
     *  not ALSO suffix-match a server named `bar`, or both cards select
     *  together and removing one strips the other's tool. */
    const [, parsed] = splitMCPToolKey(token, [...allServerNames, ...aliases.keys()]);
    if (parsed == null) {
      return false;
    }
    return (aliases.get(parsed) ?? parsed) === serverName;
  }
  if (token.endsWith(`_${prefixed}`)) {
    return true;
  }
  return normalized !== serverName && token.endsWith(`_${MCP_PREFIX}${normalized}`);
}

/** All configured MCP server ids in a catalog, for boundary-exact matching. */
export function mcpServerIds(catalog: AgentItem[]): string[] {
  return catalog.filter((item) => item.kind === 'mcp').map((item) => item.id);
}

function isMcpSelected(
  item: AgentItem,
  form: FormSelection,
  allServerNames: readonly string[],
): boolean {
  if (item.kind !== 'mcp') return false;
  return form.tools.some((t) => matchesMcpServer(t, item.id, allServerNames));
}

function isSkillSelected(item: AgentItem, form: FormSelection): boolean {
  if (item.kind !== 'skill') return false;
  return form.skills.includes(item.id);
}

function isActionSelected(item: AgentItem, agentActions: Action[]): boolean {
  if (item.kind !== 'action') return false;
  return agentActions.some((a) => a.action_id === item.id);
}

export function deriveSelectedItems(
  form: FormSelection,
  catalog: AgentItem[],
  agentActions: Action[],
): AgentItem[] {
  const allServerNames = mcpServerIds(catalog);
  const selected = catalog.filter((item) => {
    if (item.kind === 'builtin') return isBuiltinSelected(item, form);
    if (item.kind === 'tool') return isToolSelected(item, form);
    if (item.kind === 'mcp') return isMcpSelected(item, form, allServerNames);
    if (item.kind === 'skill') return isSkillSelected(item, form);
    if (item.kind === 'action') return isActionSelected(item, agentActions);
    return false;
  });

  return selected.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}
