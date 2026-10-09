import type { CodeEnvRef, CodeEnvRefMap } from 'librechat-data-provider';
import type { Document, Types } from 'mongoose';

/**
 * Skill — the single source of truth for a LibreChat skill.
 * Each document is the full SKILL.md body plus structured frontmatter and metadata.
 * The `version` field is an integer monotonic counter used for optimistic concurrency.
 */
export interface ISkill {
  /**
   * Machine-readable kebab-case identifier. This is what Claude sees in the
   * system-prompt skill manifest and what slash-command integrations key off.
   * Unique per `(author, tenantId)`. Must be stable across edits — a rename
   * invalidates any external reference to the skill.
   */
  name: string;
  /**
   * Human-readable label shown only in the LibreChat UI (skill list, detail
   * header, sharing dialogs). NOT sent to Claude and NOT part of the trigger
   * path — `name` + `description` drive triggering. Purely cosmetic: lets an
   * author keep a stable kebab-case `name` while showing something prettier
   * in the UI.
   */
  displayTitle?: string;
  /**
   * "When to use this skill" sentence. This is the highest-leverage field for
   * Claude's triggering decision — vague or missing descriptions cause
   * undertriggering. Denormalized from the YAML frontmatter onto its own
   * column so listings can filter/sort on it without loading `body`.
   */
  description: string;
  /** The SKILL.md body (markdown after the YAML frontmatter). */
  body: string;
  /**
   * Structured YAML frontmatter (excluding `name` and `description`, which live as
   * top-level columns). Stored as Mongoose Mixed so callers can extend without schema
   * churn; validated in strict mode via `validateSkillFrontmatter` — unknown keys
   * are rejected so expanding the allowed set is an intentional code change.
   */
  frontmatter: Record<string, unknown>;
  /**
   * Mirrors the `disable-model-invocation` frontmatter field. `true` removes
   * the skill from the model's catalog and rejects model-side `skill` tool
   * calls; manual `$` invocation is unaffected. Defaults to `false`.
   */
  disableModelInvocation?: boolean;
  /**
   * Mirrors the `user-invocable` frontmatter field. `false` hides the skill
   * from the `$` popover and rejects manual invocation. Defaults to `true`.
   */
  userInvocable?: boolean;
  /**
   * Skill-declared tool allowlist (mirrors the `allowed-tools` frontmatter
   * field). When the skill is invoked **manually** (via `$` popover, or
   * always-apply once Phase 5 lands), these tools are unioned into the
   * agent's effective tool set for the turn. Tolerant of unknown names —
   * the runtime intersects against the loaded tool registry and silently
   * drops anything missing, so cross-ecosystem skills authored against
   * unimplemented tools import without breaking.
   *
   * Note: model-invoked skills (via the `skill` tool mid-turn) do NOT
   * trigger tool union at execution time — adding tools after the graph
   * has started would require a rebuild. Agents that need a tool when
   * the model picks a skill should add it to `agent.tools` directly.
   */
  allowedTools?: string[];
  category?: string;
  author: Types.ObjectId;
  authorName: string;
  version: number;
  /**
   * Provenance of this skill's canonical definition.
   * - `inline` — authored inside LibreChat.
   * - `github` — mirrored from a configured GitHub skill sync source.
   * - `notion` — reserved for future external sync integrations.
   */
  source: 'inline' | 'github' | 'notion';
  /**
   * Provenance payload keyed by `source`, including upstream identifiers
   * such as GitHub source id, path, and commit/blob SHAs.
   */
  sourceMetadata?: Record<string, unknown>;
  /** Denormalized count of associated `SkillFile` rows. Kept in sync by skill methods. */
  fileCount: number;
  /**
   * When `true`, the skill is auto-primed into every turn — no user `$`
   * invocation or model discretion required. Mirrors the `always-apply` YAML
   * frontmatter field; indexed so the per-turn "always-apply" query stays
   * cheap as the catalog grows.
   */
  alwaysApply: boolean;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  /** Computed from ACL at read time, never persisted. */
  isPublic?: boolean;
}

export interface ISkillDocument extends ISkill, Document {}

/**
 * Lean summary projection returned by `listSkillsByAccess`. The list query
 * uses a narrow `.select()` that omits `body` and `frontmatter` to keep
 * payloads small, so those fields are truthfully absent on summary rows.
 */
export type ISkillSummary = Omit<ISkill, 'body' | 'frontmatter'>;

/**
 * SkillFile — metadata for a file bundled inside a skill.
 * Blob content lives in the existing file storage layer (local/S3/etc.) and is
 * addressed via `source` + `filepath` + `file_id` (mirroring the File schema).
 * `(skillId, relativePath)` is unique per skill.
 */
export interface ISkillFile {
  skillId: Types.ObjectId;
  relativePath: string;
  file_id: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  source: string;
  sourceMetadata?: Record<string, unknown>;
  mimeType: string;
  bytes: number;
  category: 'script' | 'reference' | 'asset' | 'other';
  isExecutable: boolean;
  author: Types.ObjectId;
  tenantId?: string;
  /** Lazily cached text content (≤ 512 KB). Populated on first read; cleared on re-upload. */
  content?: string;
  /** Set on first read. `true` prevents repeated storage reads for non-text files. */
  isBinary?: boolean;
  /**
   * Code-environment cache pointer. Set after uploading the file to
   * codeapi, used to check freshness on subsequent primes. Cleared
   * when the skill file is re-uploaded to storage.
   */
  codeEnvRef?: CodeEnvRef;
  codeEnvRefs?: CodeEnvRefMap;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ISkillFileDocument extends ISkillFile, Document {}
