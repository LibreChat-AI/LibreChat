import type { TPlugin, TSkillSummary, Action, AgentCapabilities } from 'librechat-data-provider';
import type { MCPServerInfo } from '~/common';

export type AgentItemKind = 'builtin' | 'tool' | 'mcp' | 'skill' | 'action';

/**
 * Literal IDs for the built-in agent capabilities surfaced in the catalog.
 * Derived from `AgentCapabilities` so a renamed or removed enum member breaks
 * the build here instead of drifting silently.
 */
export type BuiltinId =
  | `${AgentCapabilities.execute_code}`
  | `${AgentCapabilities.web_search}`
  | `${AgentCapabilities.file_search}`
  | `${AgentCapabilities.artifacts}`
  | `${AgentCapabilities.memory}`
  | `${AgentCapabilities.context}`
  /**
   * Native tool, not a capability: PRESENTED with the builtins (it ships with
   * the app and pauses the run, like a first-class feature), but selection and
   * toggling ride `agent.tools` exactly like a plugin — see the special cases
   * in `selectors.ts` / `mutations.ts`.
   */
  | 'ask_user_question'
  | `${AgentCapabilities.subagents}`
  | 'handoffs';

export type AgentItemStatus = 'needs_setup';

interface ItemBase {
  id: string;
  name: string;
  description: string;
  iconKey: string;
  status?: AgentItemStatus;
  /**
   * True when the catalog item was authored by the current user. Drives the
   * "Made by you" sidebar view. Only kinds carrying an author signal can set
   * this (today: skills, via `TSkillSummary.author`); all other kinds default
   * to `false` since they expose no per-user ownership.
   */
  ownedByUser?: boolean;
}

export interface BuiltinItem extends ItemBase {
  kind: 'builtin';
  id: BuiltinId;
  /**
   * True when `web_search` auth is USER_PROVIDED (a user-managed key exists to
   * configure). Undefined/false means SYSTEM_DEFINED — nothing to configure, so
   * the card/row shows an info icon instead of a settings cog.
   */
  userProvidedAuth?: boolean;
}

export interface ToolItem extends ItemBase {
  kind: 'tool';
  plugin: TPlugin;
}

export interface McpItem extends ItemBase {
  kind: 'mcp';
  server: MCPServerInfo;
  toolCount: number;
}

export interface SkillItem extends ItemBase {
  kind: 'skill';
  skill: TSkillSummary;
}

export interface ActionItem extends ItemBase {
  kind: 'action';
  /**
   * The persisted action. Absent for the marketplace "create new action" flow,
   * which is discriminated by a sentinel `id` (see `NEW_ACTION_ID`); the editor
   * never reads `action` in that mode.
   */
  action?: Action;
  endpointCount: number;
}

export type AgentItem = BuiltinItem | ToolItem | McpItem | SkillItem | ActionItem;

/** A live state shown beside an item, such as an MCP server's connection. */
export interface ItemStatus {
  label: string;
  /** Semantic `bg-status-*` fill for the dot that accompanies the label. */
  tone: string;
}

export type ItemFilter = {
  search?: string;
  kind?: AgentItemKind | 'all';
  category?: string | 'all';
  view?: 'marketplace' | 'favorites' | 'mine';
};

/**
 * Sentinel `ActionItem.id` marking the ItemDialog as a create-new-action flow:
 * the marketplace opens the dialog with this id and no `action`, and
 * `ActionSection` renders an empty editor for it.
 */
export const NEW_ACTION_ID = '__new_action__';
