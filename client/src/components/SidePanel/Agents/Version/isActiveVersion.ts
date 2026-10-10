import isEqual from 'lodash/isEqual';
import type {
  GraphEdge,
  AgentInstructionsPrompt,
  RestrictedAgentInstructionsPrompt,
} from 'librechat-data-provider';
import type { AgentState, VersionRecord } from './types';
import { isRestrictedInstructionsPrompt } from '../instructionsPromptUtils';

const edgesMatch = (versionEdges?: GraphEdge[], currentEdges?: GraphEdge[]): boolean =>
  isEqual(versionEdges ?? [], currentEdges ?? []);

/** Compares the linked-prompt field: source, `groupId`, and `selection`. A restricted
 * stub hides the linked group from this editor, so the client cannot deep-compare its
 * shape against the other side. Instead it trusts the server-computed `matchesCurrent`
 * flag the stub carries (set by comparing the raw, unredacted links server-side — see
 * `presentForEditor`/`presentVersionsForEditor`): a restricted stub matches only
 * another restricted stub whose `matchesCurrent` is `true`, and never matches a
 * visible link on either side, because a visible link's group is unknown to the
 * restricted side. Two visible links still compare by value. */
const instructionsPromptMatch = (
  versionPrompt: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
  currentPrompt: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
): boolean => {
  if (isRestrictedInstructionsPrompt(versionPrompt)) {
    return isRestrictedInstructionsPrompt(currentPrompt) && versionPrompt.matchesCurrent === true;
  }
  if (isRestrictedInstructionsPrompt(currentPrompt)) {
    return false;
  }
  return isEqual(versionPrompt ?? null, currentPrompt ?? null);
};

/** Compares two versions' linked-prompt fields directly, with no `currentAgent` to
 * resolve `matchesCurrent` against. A restricted stub on either side hides its group,
 * so two stubs never match here even if their `matchesCurrent` flags happen to agree —
 * that flag only says how each one compares to the current agent, not to each other. */
const instructionsPromptMatchStrict = (
  versionPrompt: AgentInstructionsPrompt | RestrictedAgentInstructionsPrompt | null | undefined,
  otherVersionPrompt:
    | AgentInstructionsPrompt
    | RestrictedAgentInstructionsPrompt
    | null
    | undefined,
): boolean => {
  if (
    isRestrictedInstructionsPrompt(versionPrompt) ||
    isRestrictedInstructionsPrompt(otherVersionPrompt)
  ) {
    return false;
  }
  return isEqual(versionPrompt ?? null, otherVersionPrompt ?? null);
};

export const isActiveVersion = (
  version: VersionRecord,
  currentAgent: AgentState,
  versions: VersionRecord[],
): boolean => {
  if (!versions || versions.length === 0) {
    return false;
  }

  if (!currentAgent) {
    const versionIndex = versions.findIndex(
      (v) =>
        v.name === version.name &&
        v.instructions === version.instructions &&
        v.artifacts === version.artifacts &&
        instructionsPromptMatchStrict(v.instructionsPrompt, version.instructionsPrompt),
    );
    return versionIndex === 0;
  }

  const matchesName = version.name === currentAgent.name;
  const matchesDescription = version.description === currentAgent.description;
  const matchesInstructions = version.instructions === currentAgent.instructions;
  const matchesInstructionsPrompt = instructionsPromptMatch(
    version.instructionsPrompt,
    currentAgent.instructionsPrompt,
  );
  const matchesArtifacts = version.artifacts === currentAgent.artifacts;
  const matchesEdges = edgesMatch(version.edges, currentAgent.edges);

  const toolsMatch = () => {
    if (!version.tools && !currentAgent.tools) return true;
    if (!version.tools || !currentAgent.tools) return false;
    if (version.tools.length !== currentAgent.tools.length) return false;

    const sortedVersionTools = [...version.tools].sort();
    const sortedCurrentTools = [...currentAgent.tools].sort();

    return sortedVersionTools.every((tool, i) => tool === sortedCurrentTools[i]);
  };

  const capabilitiesMatch = () => {
    if (!version.capabilities && !currentAgent.capabilities) return true;
    if (!version.capabilities || !currentAgent.capabilities) return false;
    if (version.capabilities.length !== currentAgent.capabilities.length) return false;

    const sortedVersionCapabilities = [...version.capabilities].sort();
    const sortedCurrentCapabilities = [...currentAgent.capabilities].sort();

    return sortedVersionCapabilities.every(
      (capability, i) => capability === sortedCurrentCapabilities[i],
    );
  };

  return (
    matchesName &&
    matchesDescription &&
    matchesInstructions &&
    matchesInstructionsPrompt &&
    matchesArtifacts &&
    matchesEdges &&
    toolsMatch() &&
    capabilitiesMatch()
  );
};
