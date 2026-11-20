import {
  Tools,
  EModelEndpoint,
  CODE_APPROVAL_MODES,
  getAllowedCodeApprovalModes,
} from 'librechat-data-provider';
import type {
  Agent,
  TConfig,
  TConversation,
  CodeApprovalMode,
  CodeEnvironmentMode,
  TPublicCodeEnvironment,
  CodeWorkspaceSelection,
} from 'librechat-data-provider';
import type { ReachableAgents } from './routing';
import { findExecutionEnvironment } from './routing';

type CodeSessionsConfig = TConfig['statefulCodeSessions'];

export interface CodeApprovalEnvironments {
  /** One entry per reachable coding agent; `undefined` when its machine cannot be resolved. */
  codeEnvironments: Array<TPublicCodeEnvironment | undefined>;
  attachedEnvironments: TPublicCodeEnvironment[];
}

export interface CodeApprovalAvailability {
  supported: boolean;
  available: boolean;
}

export interface CodeApprovalModes {
  available: boolean;
  modes: CodeApprovalMode[];
  selected?: CodeApprovalMode;
}

export interface CodeApprovalModeInputs {
  conversation: TConversation | null;
  /** The mode the composer resolved for the next turn (`useCodeWorkspace`'s `mode`). */
  codeEnvironmentMode?: CodeEnvironmentMode;
  statefulCodeSessions?: CodeSessionsConfig;
  reachable: ReachableAgents;
  /** The reader's last pick in this browser, used when the conversation carries no mode. */
  preferred?: CodeApprovalMode;
}

/** A turn sent without attached workspaces opts every agent out of its attached machine on the
 *  server, so no attached mode applies to it, whatever the agents' defaults are. */
export function isWithoutAttachedApproval(
  conversation: TConversation | null,
  codeEnvironmentMode?: CodeEnvironmentMode,
): boolean {
  return (codeEnvironmentMode ?? conversation?.codeEnvironmentMode) === 'without_attached';
}

/** Approval modes intersect every machine an agent could run on, including a subagent's own
 *  default it may no longer use once it follows its parent: offering fewer modes is safe. */
export function resolveCodeApprovalEnvironments({
  agents,
  environments,
  allowEnvironmentSelection,
  selections,
  withoutAttached,
}: {
  agents: Agent[];
  environments?: TPublicCodeEnvironment[];
  allowEnvironmentSelection?: boolean;
  selections?: CodeWorkspaceSelection[];
  withoutAttached: boolean;
}): CodeApprovalEnvironments {
  const codeEnvironments = agents
    .filter(
      (agent) => agent.stateful_code_sessions === true && agent.tools?.includes(Tools.execute_code),
    )
    .map((agent) =>
      findExecutionEnvironment(agent, environments, allowEnvironmentSelection, selections),
    );
  const attachedEnvironments = withoutAttached
    ? []
    : codeEnvironments.filter(
        (environment): environment is TPublicCodeEnvironment => environment?.type === 'attached',
      );
  return { codeEnvironments, attachedEnvironments };
}

export function resolveCodeApprovalAvailability({
  conversation,
  statefulCodeSessions,
  attachedEnvironments,
}: {
  conversation: TConversation | null;
  statefulCodeSessions?: CodeSessionsConfig;
  attachedEnvironments: TPublicCodeEnvironment[];
}): CodeApprovalAvailability {
  const supported =
    (conversation?.endpointType ?? conversation?.endpoint) === EModelEndpoint.agents &&
    statefulCodeSessions?.approvalsEnabled === true;
  const available =
    supported &&
    statefulCodeSessions?.approvalModes?.includes('ask') === true &&
    attachedEnvironments.length > 0;
  return { supported, available };
}

export function resolveCodeApprovalModeOptions({
  available,
  complete,
  endpointModes,
  codeEnvironments,
  attachedEnvironments,
}: CodeApprovalEnvironments & {
  available: boolean;
  complete: boolean;
  endpointModes?: readonly CodeApprovalMode[];
}): CodeApprovalMode[] {
  if (!available) return [];
  const allowed = new Set<CodeApprovalMode>(endpointModes?.includes('ask') ? ['ask'] : []);
  let fullAccessAllowed =
    endpointModes?.includes('fullAccess') === true &&
    complete &&
    codeEnvironments.every((environment) => environment != null);
  for (const environment of attachedEnvironments) {
    const environmentModes = getAllowedCodeApprovalModes({
      environment: 'attached',
      allowedModes: CODE_APPROVAL_MODES,
      configSchema: environment.configSchema,
      settings: environment.settings,
    });
    if (endpointModes?.includes('acceptEdits') && environmentModes.includes('acceptEdits')) {
      allowed.add('acceptEdits');
    }
    fullAccessAllowed &&= environmentModes.includes('fullAccess');
  }
  if (fullAccessAllowed) allowed.add('fullAccess');
  return CODE_APPROVAL_MODES.filter((mode) => allowed.has(mode));
}

/**
 * Fail closed while agent/environment metadata is incomplete. An affirmative
 * server capability means `ask` is safe to submit even before an attached
 * environment is discoverable; a turn with no attached target accepts it and
 * keeps the conversation's stored mode. Never preserve `acceptEdits` until
 * current policy authorizes it.
 */
export function selectCodeApprovalMode({
  supported,
  available,
  modes,
  requested,
}: CodeApprovalAvailability & {
  modes: readonly CodeApprovalMode[];
  requested: CodeApprovalMode;
}): CodeApprovalMode | undefined {
  if (!supported) return undefined;
  return available && modes.includes(requested) ? requested : 'ask';
}

/** The whole approval derivation from a plain snapshot of `useCodeApprovalMode`'s inputs. */
export function resolveCodeApprovalModes({
  conversation,
  codeEnvironmentMode,
  statefulCodeSessions,
  reachable,
  preferred,
}: CodeApprovalModeInputs): CodeApprovalModes {
  const environments = resolveCodeApprovalEnvironments({
    agents: reachable.agents,
    environments: statefulCodeSessions?.environments,
    allowEnvironmentSelection: statefulCodeSessions?.allowEnvironmentSelection,
    selections: conversation?.codeWorkspaces,
    withoutAttached: isWithoutAttachedApproval(conversation, codeEnvironmentMode),
  });
  const availability = resolveCodeApprovalAvailability({
    conversation,
    statefulCodeSessions,
    attachedEnvironments: environments.attachedEnvironments,
  });
  const modes = resolveCodeApprovalModeOptions({
    ...environments,
    available: availability.available,
    complete: reachable.complete,
    endpointModes: statefulCodeSessions?.approvalModes,
  });
  /** A conversation that carries no mode of its own opens on the reader's last
   *  pick in this browser. The remembered value is a preference, not a grant. */
  const requested = conversation?.codeApprovalMode ?? preferred ?? 'ask';
  const selected = selectCodeApprovalMode({ ...availability, modes, requested });
  return { available: availability.available, modes, selected };
}

/**
 * The mode a submission carries: the conversation's pick when current policy offers it, else the
 * gated fallback. A turn sent without attached workspaces has no target for a stronger mode to
 * govern, so it carries `ask` even when the composer resolved the decision only at send time.
 */
export function resolveSubmittedCodeApprovalMode({
  requested,
  modes,
  fallback,
  codeEnvironmentMode,
}: {
  requested?: CodeApprovalMode;
  modes: readonly CodeApprovalMode[];
  fallback?: CodeApprovalMode;
  codeEnvironmentMode?: CodeEnvironmentMode;
}): CodeApprovalMode | undefined {
  if (fallback == null) return undefined;
  if (codeEnvironmentMode === 'without_attached') return 'ask';
  return requested != null && modes.includes(requested) ? requested : fallback;
}
