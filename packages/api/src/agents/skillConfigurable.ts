/**
 * Augments a loadTools result with skill-specific configurable properties.
 *
 * `codeEnvAvailable` is threaded as a boolean (true when the agent's
 * `execute_code` capability is enabled). Downstream skill consumers —
 * the skill-tool handler (for file priming) and `primeInvokedSkills`
 * (for history re-priming) — gate sandbox uploads on this flag so no
 * sandbox traffic occurs for agents that lack code-execution capability.
 *
 * `skillPrimedIdsByName` maps each primed skill name (manual `$` or
 * always-apply) to the `_id` of the exact doc whose body was primed
 * into the turn. Skill-tool handlers consult it to:
 *   1. Relax the `disable-model-invocation` gate on `read_file` for
 *      any primed skill (so a `disable-model-invocation: true` skill
 *      whose body is in context can still load its `references/*` /
 *      `scripts/*` files). Without this, a user manually invoking —
 *      or auto-priming — a disabled skill would get a body that
 *      references files the model is forbidden to open.
 *   2. Constrain the lookup to the primed `_id` on same-name
 *      collisions, so `read_file` reads from the same doc whose body
 *      got primed (otherwise a newer same-name duplicate could shadow
 *      the resolver's pick and cause body/file mismatch within a
 *      single turn).
 * Empty/missing → no exception, the gate applies as normal and the
 * lookup uses the full ACL set.
 */
export interface SkillConfigurableContext {
  req: { user?: { id?: string } };
  accessibleSkillIds?: unknown[];
  codeEnvAvailable: boolean;
  /**
   * `{ [skillName]: skillIdString }` for every skill primed this turn
   * (manual or always-apply). The id pins same-name collision lookups to
   * the exact doc the resolver primed and relaxes the disable-model gate.
   */
  skillPrimedIdsByName?: Record<string, string>;
  /**
   * Names of skills the runtime can resolve, captured at agent init by
   * `injectSkillCatalog`. Lets `read_file` decide whether a
   * `{firstSegment}/...` path is a real skill reference vs. a code-env path
   * that should fall back to bash, without an extra `getSkillByName`
   * round-trip just to discover the name doesn't resolve. Empty/undefined
   * ⇒ skills aren't effectively in scope for this agent (admin capability
   * off, ephemeral badge off, or persisted `skills_enabled !== true`),
   * which is the same signal as `accessibleSkillIds.length === 0`.
   */
  activeSkillNames?: Set<string>;
  /** True when skills/{skillName}/... write paths are enabled for this run. */
  skillAuthoringAvailable?: boolean;
  /** Host file-authoring names registered by initializeAgent for this run. */
  fileAuthoringToolNames?: Set<string>;
}

export interface SkillConfigurableLoadResult {
  loadedTools: unknown[];
  configurable?: Record<string, unknown>;
}

export interface EnrichWithSkillConfigurableParams {
  result: SkillConfigurableLoadResult;
  context: SkillConfigurableContext;
}

export function enrichWithSkillConfigurable(params: EnrichWithSkillConfigurableParams): {
  loadedTools: unknown[];
  configurable: Record<string, unknown>;
};
export function enrichWithSkillConfigurable(
  result: SkillConfigurableLoadResult,
  req: { user?: { id?: string } },
  accessibleSkillIds: unknown[] | undefined,
  codeEnvAvailable: boolean,
  skillPrimedIdsByName?: Record<string, string>,
  activeSkillNames?: Set<string>,
  skillAuthoringAvailable?: boolean,
  fileAuthoringToolNames?: Set<string>,
): { loadedTools: unknown[]; configurable: Record<string, unknown> };
export function enrichWithSkillConfigurable(
  first: EnrichWithSkillConfigurableParams | SkillConfigurableLoadResult,
  req?: { user?: { id?: string } },
  accessibleSkillIds?: unknown[],
  codeEnvAvailable?: boolean,
  skillPrimedIdsByName?: Record<string, string>,
  activeSkillNames?: Set<string>,
  skillAuthoringAvailable?: boolean,
  fileAuthoringToolNames?: Set<string>,
): { loadedTools: unknown[]; configurable: Record<string, unknown> } {
  const { result, context } =
    'result' in first && 'context' in first
      ? first
      : {
          result: first,
          context: {
            req: req ?? {},
            accessibleSkillIds,
            codeEnvAvailable: codeEnvAvailable === true,
            skillPrimedIdsByName,
            activeSkillNames,
            skillAuthoringAvailable,
            fileAuthoringToolNames,
          },
        };

  return {
    ...result,
    configurable: {
      ...result.configurable,
      req: context.req,
      codeEnvAvailable: context.codeEnvAvailable,
      accessibleSkillIds: context.accessibleSkillIds,
      skillPrimedIdsByName: context.skillPrimedIdsByName,
      activeSkillNames: context.activeSkillNames,
      skillAuthoringAvailable: context.skillAuthoringAvailable,
      fileAuthoringToolNames: context.fileAuthoringToolNames,
    },
  };
}
