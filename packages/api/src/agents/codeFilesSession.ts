import { Constants } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import type { FileRefs, CodeEnvFile, ToolSessionMap, CodeSessionContext } from '@librechat/agents';
import type { StatefulCodeEnvironment } from 'librechat-data-provider';
import {
  getCodeExecutionRouteKey,
  resolveCodeExecutionContext,
  type CodeExecutionContext,
} from './execution';
import { createCodeDestinationSet, reserveCodeDestination } from '~/files/code/destinations';

/**
 * Minimal shape for an agent that may contribute primed code files to its
 * execution-profile partition. Both `InitializedAgent` and `RunAgent` satisfy it,
 * and the recursive walk in {@link buildInitialToolSessions} traverses
 * legacy child configs and graph-member configs so agents pruned from the
 * top-level `agentConfigs` map still contribute.
 */
export interface CodeFilesAgent {
  id?: string;
  codeEnvAvailable?: boolean;
  codeExecutionContext?: CodeExecutionContext;
  codeSessionKey?: string;
  primedCodeFiles?: CodeEnvFile[];
  statefulCodeSessions?: boolean;
  statefulCodeEnvironment?: StatefulCodeEnvironment;
  subagentAgentConfigs?: CodeFilesAgent[];
  lazySubagentConfigs?: CodeFilesAgent[];
  subagentGraphConfigs?: Array<{ memberConfigs: CodeFilesAgent[] }>;
}

export interface CodeExecutionProfileRoute {
  codeExecutionContext: CodeExecutionContext;
  codeSessionKeys: string[];
}

function enqueueCodeFilesChildren(
  agent: CodeFilesAgent,
  queue: CodeFilesAgent[],
  visited: Set<CodeFilesAgent>,
): void {
  for (const child of [
    ...(agent.subagentAgentConfigs ?? []),
    ...(agent.lazySubagentConfigs ?? []),
  ]) {
    if (child && !visited.has(child)) queue.push(child);
  }
  for (const graph of agent.subagentGraphConfigs ?? []) {
    for (const member of graph.memberConfigs) {
      if (member && !visited.has(member)) queue.push(member);
    }
  }
}

/** Collects the distinct Code API deployments used by a run and every
 * trusted session partition that must receive that deployment's immutable
 * skill-file seed. */
export function collectCodeExecutionProfileRoutes(
  agents: Iterable<CodeFilesAgent | undefined | null>,
  scope?: { userId: string; conversationId?: string | null },
): CodeExecutionProfileRoute[] {
  const routes = new Map<
    string,
    { codeExecutionContext: CodeExecutionContext; codeSessionKeys: Set<string> }
  >();
  const visited = new Set<CodeFilesAgent>();
  const queue: CodeFilesAgent[] = [];
  for (const agent of agents) {
    if (agent) queue.push(agent);
  }
  while (queue.length > 0) {
    const agent = queue.shift()!;
    if (visited.has(agent)) continue;
    visited.add(agent);
    const context =
      agent.codeExecutionContext ??
      (agent.codeEnvAvailable === true && scope
        ? resolveCodeExecutionContext({
            statefulSessions: agent.statefulCodeSessions === true,
            environment: agent.statefulCodeEnvironment,
            userId: scope.userId,
            agentId: agent.id,
            conversationId: scope.conversationId,
          })
        : undefined);
    if (agent.codeEnvAvailable === true && context) {
      const routeKey = getCodeExecutionRouteKey(context);
      const route = routes.get(routeKey) ?? {
        codeExecutionContext: context,
        codeSessionKeys: new Set<string>(),
      };
      route.codeSessionKeys.add(agent.codeSessionKey ?? context.codeSessionKey);
      routes.set(routeKey, route);
    }
    enqueueCodeFilesChildren(agent, queue, visited);
  }
  return Array.from(routes.values(), (route) => ({
    codeExecutionContext: route.codeExecutionContext,
    codeSessionKeys: Array.from(route.codeSessionKeys),
  }));
}

/**
 * Merges primed code-execution file references into a `ToolSessionMap` so the
 * Graph's `ToolNode` can inject them into the very first `execute_code` tool
 * call as `_injected_files`. Without this seed, `ToolNode.getCodeSessionContext`
 * has no entry to read on call #1, and the agent-side `CodeExecutor` falls back
 * to a `/files/{session_id}` fetch — but `session_id` itself is only populated
 * after the first call returns one, so primed files were silently dropped.
 *
 * Files from `primeFiles` (api/server/services/Files/Code/process.js) carry
 * per-file `storage_session_id`s (the long-lived storage bucket id). The
 * map's representative top-level `session_id` is seeded from the first
 * incoming file's `storage_session_id` (matching `primeInvokedSkills`),
 * since no execution session exists yet at seed time. Per-file ids on the
 * `files` array are what `ToolNode` actually uses
 * (`file.storage_session_id ?? execSessionId`).
 *
 * When an entry already exists (e.g. seeded by `primeInvokedSkills` for skill
 * files), incoming files are appended after the existing ones. The pre-existing
 * representative `session_id` is preserved so a partial-cache/fresh-prime
 * collision doesn't shift which session id `ToolNode` picks for the call.
 *
 * Files are deduplicated by `storage_session_id + id` as the stable
 * identity key. Multiple agents in the same run commonly carry the same
 * primed code-execution resources (shared conversation files), and without
 * dedupe `_injected_files` would grow proportionally to agent count and
 * inflate every `/exec` POST. First-seen wins so the original ordering /
 * source is preserved.
 *
 * Identity dedupe alone cannot keep the seed valid: codeapi rejects the
 * whole `/exec` request when two entries mount at one destination, and a
 * file re-uploaded by one agent but cache-hit by another arrives twice
 * under different `storage_session_id`s with a single `name`. Sources are
 * merged in trust order — skill seed, then primary agent, then the rest —
 * so first-seen also wins the destination, and the later copy of an
 * already-mounted name is dropped rather than renamed to a path nothing
 * told the model about.
 *
 * Each agent resolves destinations over its own candidate set, so this can
 * still drop a genuinely distinct file: two agents whose *private*
 * resources share a filename each claim the bare name locally, and only the
 * first survives here while the second agent's tool context keeps
 * advertising its own file at that path. `sortCodeFilesByDestinationPriority`
 * ranks conversation-scoped files above private ones precisely so the shared
 * majority cannot diverge that way; closing the private-versus-private case
 * needs one assignment across contributors, which means resolving
 * destinations before any agent renders its tool context. Until then this
 * drop is the failure floor — before it, the pair reached codeapi together
 * and took the whole run down with a rejected request.
 */
export function seedCodeFilesIntoSessions(
  files: CodeEnvFile[] | undefined,
  existing: ToolSessionMap | undefined,
  sessionKey: string = Constants.EXECUTE_CODE,
): ToolSessionMap | undefined {
  if (!files || files.length === 0) {
    return existing;
  }

  const sessions: ToolSessionMap = existing ?? new Map();
  const prior = sessions.get(sessionKey) as CodeSessionContext | undefined;
  const merged = mergeCodeFilesIntoContext(prior, files, sessionKey);
  if (!merged) {
    return existing;
  }

  sessions.set(sessionKey, {
    session_id: merged.session_id,
    files: merged.files as FileRefs,
    lastUpdated: Date.now(),
  } satisfies CodeSessionContext);

  return sessions;
}

/**
 * Adds primed or freshly provisioned file refs to one code-session context, keeping
 * the ordering and identity rules the graph seed uses so both entry points agree on
 * what the sandbox receives.
 *
 * Composes `(storage_session_id, id)` as the identity. `name` alone isn't sufficient:
 * two distinct uploads can share a filename across different storage sessions and
 * file_ids. First seen wins, so pre-existing refs keep their position.
 *
 * The representative top-level `session_id` is preserved when one already exists,
 * otherwise it stands in from the first incoming file's `storage_session_id`, since
 * no execution session exists until the first call returns one. ToolNode reads the
 * per-file `storage_session_id` for actual injection, so the representative is
 * informational. Mirrors the convention in `primeInvokedSkills`.
 *
 * Returns undefined when there is nothing usable to record.
 */
export function mergeCodeFilesIntoContext(
  prior: { session_id?: string; files?: CodeEnvFile[] | FileRefs } | undefined,
  files: CodeEnvFile[] | undefined,
  sessionKey?: string,
): { session_id: string; files: CodeEnvFile[] } | undefined {
  if (!files || files.length === 0) {
    return undefined;
  }

  /**
   * Identity is `(storage_session_id, id)`, not `name` — two distinct primed
   * uploads can share a filename across different storage sessions and
   * file_ids, and collapsing those would drop a file the caller resolved to
   * its own mount path. The composite stays cheap to compute and the keys
   * are short uuids. Destination uniqueness is enforced separately below,
   * against the sandbox's one-file-per-path constraint.
   */
  const seenKeys = new Set<string>();
  const destinations = createCodeDestinationSet();
  const mergedFiles: CodeEnvFile[] = [];
  const pushIfFresh = (f: { id?: string; storage_session_id?: string; name?: string }): void => {
    const key = `${f.storage_session_id ?? ''}\0${f.id ?? ''}`;
    if (seenKeys.has(key)) return;
    if (f.name != null && !reserveCodeDestination(destinations, f.name)) {
      logger.debug(
        `[mergeCodeFilesIntoContext] dropped id=${f.id} name=${f.name} ` +
          `reason=destination-taken${sessionKey != null ? ` sessionKey=${sessionKey}` : ''}`,
      );
      return;
    }
    seenKeys.add(key);
    mergedFiles.push(f as CodeEnvFile);
  };
  if (prior?.files) {
    for (const f of prior.files) pushIfFresh(f);
  }
  for (const f of files) pushIfFresh(f);

  const representativeSessionId = prior?.session_id ?? files[0].storage_session_id;
  if (!representativeSessionId) {
    return undefined;
  }

  return { session_id: representativeSessionId, files: mergedFiles };
}

/** Builds an isolated child-graph seed from the run's exact trusted partition
 * plus files resolved specifically for that agent. Lazy subagents are resolved
 * after the run-wide seed is built, so their attachments must be copied here
 * when `AgentInputs` is created. */
export function buildAgentInitialToolSessions(
  agent: CodeFilesAgent,
  runSessions: ToolSessionMap | undefined,
): ToolSessionMap | undefined {
  const sessionKey = agent.codeSessionKey ?? Constants.EXECUTE_CODE;
  const runContext = runSessions?.get(sessionKey) as CodeSessionContext | undefined;
  let sessions: ToolSessionMap | undefined;
  if (runContext) {
    sessions = new Map([
      [
        sessionKey,
        {
          ...runContext,
          files: runContext.files ? [...runContext.files] : undefined,
        },
      ],
    ]);
  }
  return seedCodeFilesIntoSessions(agent.primedCodeFiles, sessions, sessionKey);
}

/**
 * Builds the run-wide `ToolSessionMap` for `Graph.sessions`, partitioned by
 * each agent's trusted `codeSessionKey`. The legacy `execute_code` partition
 * remains shared by stateless agents. Stateful agents share only when their
 * configured environment resolves to the same key.
 *
 * Skill files are immutable input resources for the run, but their storage
 * pointers are deployment-local. Callers therefore pre-seed each exact
 * profile partition; this helper never copies a pointer across partitions.
 *
 * **Walk order:** primary first, then `agentConfigs` (handoff/addedConvo)
 * in iteration order, then recurse through legacy children and graph members
 * breadth-first. Order matters because when no
 * skill sessions exist, the FIRST agent's first file supplies the
 * representative `session_id` written to `Graph.sessions[EXECUTE_CODE]`.
 * `ToolNode` ultimately uses per-file `session_id`s for injection so
 * the representative is informational rather than load-bearing, but
 * primary-first keeps it predictable and matches the existing
 * `loadSubagentsFor` walk pattern in `Endpoints/agents/initialize.js`.
 *
 * The visited set is keyed by object identity (`Set<CodeFilesAgent>`)
 * so cycles in a malformed agent graph (a subagent that points back at
 * its parent) can't infinite-loop the seed.
 *
 * @param skillSessions - Output of `primeInvokedSkills` — already
 *   contains an `EXECUTE_CODE` entry when skill files were primed; new
 *   files from this walk merge into it (representative `session_id`
 *   from the skill side is preserved).
 * @param agents - The complete set of code-execution-capable agents in
 *   the run. Caller passes `[primaryConfig, ...agentConfigs.values()]`;
 *   this function recurses into every reachable subagent configuration.
 */
export function buildInitialToolSessions(params: {
  skillSessions?: ToolSessionMap;
  agents: Iterable<CodeFilesAgent | undefined | null>;
}): ToolSessionMap | undefined {
  const { skillSessions, agents } = params;
  let sessions = skillSessions;
  const visited = new Set<CodeFilesAgent>();
  /**
   * FIFO queue: primary lands at index 0 and gets visited first, so its
   * first file is what `seedCodeFilesIntoSessions` records as the
   * representative `session_id` (when no skill seed exists). A LIFO
   * stack (`pop()`) would visit the last top-level agent first and
   * silently flip which agent supplies that id. `Array.shift()` is
   * O(n); the agent set is small (handoff + subagents, typically <20)
   * so the overhead is negligible vs. the readability win.
   */
  const queue: CodeFilesAgent[] = [];
  for (const a of agents) {
    if (a) queue.push(a);
  }
  while (queue.length > 0) {
    const agent = queue.shift()!;
    if (visited.has(agent)) continue;
    visited.add(agent);
    const sessionKey = agent.codeSessionKey ?? Constants.EXECUTE_CODE;
    if (agent.primedCodeFiles && agent.primedCodeFiles.length > 0) {
      sessions = seedCodeFilesIntoSessions(agent.primedCodeFiles, sessions, sessionKey);
    }
    enqueueCodeFilesChildren(agent, queue, visited);
  }
  return sessions;
}
