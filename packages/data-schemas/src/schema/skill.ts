import { Schema } from 'mongoose';
import type { ISkillDocument } from '~/types/skill';

/** Max length for a skill `name` (kebab-case identifier). */
const SKILL_NAME_MAX_LENGTH = 64;

/** Max length for a skill `description`. */
const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** Max length for the skill `body` (the SKILL.md content). */
const SKILL_BODY_MAX_LENGTH = 100_000;

/** Max length for the human-friendly `displayTitle`. */
const SKILL_DISPLAY_TITLE_MAX_LENGTH = 128;

const skillNamePattern = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Brand namespaces reserved for first-party skills. Matched as prefixes —
 * `anthropic-helper` is rejected but `my-helper` is fine. Keep this in sync
 * with `RESERVED_NAME_PREFIXES` in `methods/skill.ts`.
 */
const RESERVED_NAME_PREFIXES = ['anthropic-', 'claude-'];

/**
 * Slash-command names that collide with LibreChat / Claude Code CLI commands.
 * Matched exactly against the full skill name. Keep this in sync with
 * `RESERVED_NAME_WORDS` in `methods/skill.ts`.
 */
const RESERVED_NAME_WORDS = new Set([
  'help',
  'clear',
  'compact',
  'model',
  'exit',
  'quit',
  'settings',
  'anthropic',
  'claude',
]);

const skillSchema: Schema<ISkillDocument> = new Schema(
  {
    /**
     * Machine-readable identifier. Kebab-case, max 64 chars, unique per
     * (author, tenantId). This is what Claude sees in its system prompt when
     * deciding to trigger the skill, and what slash-command integrations key
     * off — so it must be stable, concise, and ASCII-friendly. User-facing
     * labels live on `displayTitle` instead.
     */
    name: {
      type: String,
      required: true,
      index: true,
      maxlength: [SKILL_NAME_MAX_LENGTH, `Name cannot exceed ${SKILL_NAME_MAX_LENGTH} characters`],
      validate: {
        validator: function (value: string): boolean {
          if (!skillNamePattern.test(value)) {
            return false;
          }
          const lowered = value.toLowerCase();
          if (RESERVED_NAME_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
            return false;
          }
          if (RESERVED_NAME_WORDS.has(lowered)) {
            return false;
          }
          return true;
        },
        message:
          'Name must be kebab-case (lowercase letters, digits, hyphens), cannot start with "anthropic-" or "claude-", and cannot be a reserved CLI word.',
      },
    },
    /**
     * Human-readable label shown in the LibreChat UI (skill list, detail
     * header, sharing dialogs). NOT sent to Claude and NOT used to trigger
     * the skill — `name` + `description` drive triggering. Purely cosmetic:
     * useful when the author wants a prettier label than the kebab-case
     * identifier while keeping the identifier stable.
     */
    displayTitle: {
      type: String,
      maxlength: [
        SKILL_DISPLAY_TITLE_MAX_LENGTH,
        `Display title cannot exceed ${SKILL_DISPLAY_TITLE_MAX_LENGTH} characters`,
      ],
    },
    /**
     * "When to use this skill" sentence that Claude reads from the system
     * prompt to decide whether to invoke the skill. This is the highest-
     * leverage field for triggering accuracy — a vague description causes
     * undertriggering. Denormalized from the YAML frontmatter for indexed
     * querying.
     */
    description: {
      type: String,
      required: true,
      maxlength: [
        SKILL_DESCRIPTION_MAX_LENGTH,
        `Description cannot exceed ${SKILL_DESCRIPTION_MAX_LENGTH} characters`,
      ],
    },
    /** The SKILL.md body (markdown after the YAML frontmatter). */
    body: {
      type: String,
      default: '',
      maxlength: [SKILL_BODY_MAX_LENGTH, `Body cannot exceed ${SKILL_BODY_MAX_LENGTH} characters`],
    },
    /**
     * Structured YAML frontmatter bag (everything except `name`/`description`,
     * which live as first-class columns). `validateSkillFrontmatter` type-checks
     * recognized keys and bounds tolerated extension values before write.
     */
    frontmatter: {
      type: Schema.Types.Mixed,
      default: {},
    },
    /**
     * When `true`, the model cannot invoke this skill via the `skill` tool
     * and the skill is excluded from the catalog injected into the agent's
     * additional_instructions. Manual `$` invocation is unaffected. Mirrors
     * the `disable-model-invocation` frontmatter field. Filtering currently
     * happens application-side after `listSkillsByAccess` returns, so no
     * index — add one if/when a query starts filtering by this column at
     * the DB level.
     */
    disableModelInvocation: {
      type: Boolean,
      default: false,
    },
    /**
     * When `false`, the skill is hidden from the `$` popover and rejected
     * by the manual-invocation resolver. Defaults to `true` so existing
     * skills remain user-invocable without a migration. Mirrors the
     * `user-invocable` frontmatter field.
     */
    userInvocable: {
      type: Boolean,
      default: true,
    },
    /**
     * Skill-declared tool allowlist forwarded verbatim from frontmatter.
     * Surfaced on resolved skill primes so the agent's effective tool set
     * for the turn can union these in alongside the agent-configured tools.
     * `default: undefined` (not `[]`) preserves the distinction between
     * "author declared no extras" and "author explicitly declared none".
     *
     * Phase 6 wires this in for **manually-primed** skills (Phase 5's
     * always-apply primes will pass through the same union once that
     * resolver lands). Model-invoked skills (via the `skill` tool
     * mid-turn) do NOT trigger tool union at execution time — adding a
     * tool partway through a turn would require a graph rebuild that
     * isn't worth the complexity for v1. If the author wants the model
     * to have access to extra tools when the model picks the skill, they
     * should add those tools to the agent directly.
     */
    allowedTools: {
      type: [String],
      default: undefined,
    },
    category: {
      type: String,
      default: '',
      index: true,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    authorName: {
      type: String,
      required: true,
    },
    version: {
      type: Number,
      default: 1,
      min: 1,
    },
    /**
     * Provenance of this skill's canonical definition.
     *
     * - `inline` — authored directly inside LibreChat.
     * - `github` — mirrored from a configured GitHub skill sync source.
     * - `notion` — reserved for future external sync integrations.
     */
    source: {
      type: String,
      enum: ['inline', 'github', 'notion'],
      default: 'inline',
    },
    /**
     * Arbitrary JSON provenance payload keyed by `source`. GitHub sync stores
     * source id, upstream path, commit/blob SHAs, and sync status here.
     */
    sourceMetadata: {
      type: Schema.Types.Mixed,
    },
    fileCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /**
     * When `true`, the skill's SKILL.md body is auto-primed into every turn
     * without user `$` invocation or model discretion. Mirrors the
     * always-apply YAML frontmatter field and is kept as a first-class
     * column so the `listAlwaysApplySkills` query at the top of every
     * request is an indexed lookup, not a frontmatter scan.
     */
    alwaysApply: {
      type: Boolean,
      default: false,
      index: true,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

skillSchema.index({ author: 1, tenantId: 1 });
skillSchema.index({ category: 1, updatedAt: -1 });
skillSchema.index({ updatedAt: -1, _id: 1 });
skillSchema.index({ name: 1, author: 1, tenantId: 1 }, { unique: true });
skillSchema.index({ source: 1, 'sourceMetadata.upstreamId': 1, tenantId: 1 });
skillSchema.index({ source: 1, 'sourceMetadata.sourceId': 1, tenantId: 1 });

export default skillSchema;
