import { Constants } from '@librechat/agents';
import type { CodeEnvFile, CodeSessionContext, ToolSessionMap } from '@librechat/agents';
import {
  buildAgentInitialToolSessions,
  mergeCodeFilesIntoContext,
  buildInitialToolSessions,
  collectCodeExecutionProfileRoutes,
  seedCodeFilesIntoSessions,
  type CodeFilesAgent,
} from './codeFilesSession';

const file = (id: string, storage_session_id: string, name: string): CodeEnvFile => ({
  id,
  /* `resource_id` is informational for `kind: 'user'` (codeapi derives
   * the sessionKey from the auth-context user, not this field) but
   * still required by the type for shape uniformity. The id stand-in
   * is fine here because no test asserts on its value. */
  resource_id: id,
  storage_session_id,
  name,
  /* `kind` drives codeapi's sessionKey shape; defaults to `'user'` for
   * primed code-execution attachments at the test boundary (most are
   * chat uploads). Tests that need shared kinds set it explicitly. */
  kind: 'user',
});

describe('mergeCodeFilesIntoContext', () => {
  it('adds a freshly provisioned file to an existing session context', () => {
    const prior: CodeSessionContext = {
      session_id: 'exec-1',
      files: [file('a', 'store-1', 'a.csv')],
      lastUpdated: 1,
    };

    const merged = mergeCodeFilesIntoContext(prior, [file('b', 'store-1', 'b.csv')]);

    expect(merged?.session_id).toBe('exec-1');
    expect(merged?.files.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('builds a context when the batch had none', () => {
    const merged = mergeCodeFilesIntoContext(undefined, [file('b', 'store-2', 'b.csv')]);

    expect(merged?.session_id).toBe('store-2');
    expect(merged?.files.map((f) => f.id)).toEqual(['b']);
  });

  it('does not duplicate a file the context already carries', () => {
    const prior: CodeSessionContext = {
      session_id: 'exec-1',
      files: [file('a', 'store-1', 'a.csv')],
      lastUpdated: 1,
    };

    const merged = mergeCodeFilesIntoContext(prior, [file('a', 'store-1', 'a.csv')]);

    expect(merged?.files.map((f) => f.id)).toEqual(['a']);
  });

  it('drops a provisioned file whose destination the context already claimed', () => {
    /**
     * The destination constraint has to hold on this path too. Lazy provisioning
     * folds its uploads into a context the graph seeded at run start, so a name
     * the seed already claimed reaches codeapi as a duplicate destination and
     * takes the whole `/exec` call down, exactly as in the seeding path.
     */
    const prior: CodeSessionContext = {
      session_id: 'exec-1',
      files: [file('id-A', 'sess-A', 'data.csv')],
      lastUpdated: 1,
    };

    const merged = mergeCodeFilesIntoContext(prior, [file('id-B', 'sess-B', 'data.csv')]);

    expect(merged?.files.map((f) => f.id)).toEqual(['id-A']);
  });

  it('reports nothing to record when there are no files', () => {
    expect(mergeCodeFilesIntoContext({ session_id: 'exec-1' }, [])).toBeUndefined();
  });
});

describe('seedCodeFilesIntoSessions', () => {
  it('returns existing map untouched when files is undefined', () => {
    const existing: ToolSessionMap = new Map();
    expect(seedCodeFilesIntoSessions(undefined, existing)).toBe(existing);
  });

  it('returns existing map untouched when files is empty', () => {
    const existing: ToolSessionMap = new Map();
    expect(seedCodeFilesIntoSessions([], existing)).toBe(existing);
  });

  it('returns undefined when no files and no existing map', () => {
    expect(seedCodeFilesIntoSessions(undefined, undefined)).toBeUndefined();
  });

  it('creates a new sessions map seeded with EXECUTE_CODE entry on first call', () => {
    const files = [file('f1', 'sess-1', 'data.csv')];
    const result = seedCodeFilesIntoSessions(files, undefined);

    expect(result).toBeDefined();
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.session_id).toBe('sess-1');
    expect(entry.files).toEqual(files);
    expect(typeof entry.lastUpdated).toBe('number');
  });

  it('mutates the passed-in map (in-place seeding so caller can pass to createRun)', () => {
    const existing: ToolSessionMap = new Map();
    const result = seedCodeFilesIntoSessions([file('f1', 'sess-1', 'a.csv')], existing);
    expect(result).toBe(existing);
    expect(existing.has(Constants.EXECUTE_CODE)).toBe(true);
  });

  it('appends incoming files to a prior EXECUTE_CODE entry without dropping skill files', () => {
    const skillFile = file('skill-1', 'skill-sess', 'skill/util.py');
    const codeFile = file('user-1', 'user-sess', 'data.csv');

    const existing: ToolSessionMap = new Map();
    existing.set(Constants.EXECUTE_CODE, {
      session_id: 'skill-sess',
      files: [skillFile],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = seedCodeFilesIntoSessions([codeFile], existing);
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toEqual([skillFile, codeFile]);
    expect(entry.session_id).toBe('skill-sess');
  });

  it('preserves prior representative session_id when merging', () => {
    const existing: ToolSessionMap = new Map();
    existing.set(Constants.EXECUTE_CODE, {
      session_id: 'skill-sess',
      files: [file('skill-1', 'skill-sess', 'a.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = seedCodeFilesIntoSessions([file('user-1', 'different-sess', 'b.csv')], existing);
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.session_id).toBe('skill-sess');
  });

  it('skips seeding when incoming files have no storage_session_id (defensive)', () => {
    const fileWithoutSession = {
      id: 'x',
      storage_session_id: '',
      name: 'orphan.csv',
      kind: 'user',
    } as CodeEnvFile;
    const result = seedCodeFilesIntoSessions([fileWithoutSession], undefined);
    expect(result).toBeUndefined();
  });

  it('dedupes incoming files that share storage_session_id + id with existing entries', () => {
    /**
     * Regression for Codex review #2: shared conversation files commonly
     * appear in multiple agents' `primedCodeFiles`. Without dedupe,
     * `_injected_files` would grow proportionally to agent count and
     * inflate every `/exec` POST.
     */
    const shared = file('f1', 'sess-S', 'shared.csv');
    const result = seedCodeFilesIntoSessions([shared, shared, shared], undefined);
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(1);
    expect(entry.files![0].id).toBe('f1');
  });

  it('dedupes incoming files against pre-existing entries on merge', () => {
    const existing: ToolSessionMap = new Map();
    existing.set(Constants.EXECUTE_CODE, {
      session_id: 'skill-sess',
      files: [file('skill-1', 'skill-sess', 'a.py'), file('shared-1', 'sess-S', 'shared.csv')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = seedCodeFilesIntoSessions(
      [
        file('shared-1', 'sess-S', 'shared.csv'), // duplicate of prior entry
        file('new-1', 'sess-N', 'new.csv'),
      ],
      existing,
    );
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    /* prior 2 + 1 new (the duplicate is dropped). */
    expect(entry.files).toHaveLength(3);
    expect(entry.files!.map((f) => f.id).sort()).toEqual(['new-1', 'shared-1', 'skill-1']);
  });

  it('keeps distinct identities that mount at distinct destinations', () => {
    /**
     * The dedupe key is `(session_id, id)` — not `name` alone. Two primed
     * uploads are separate files even when one was re-uploaded into a new
     * sandbox session, and both belong in the seed as long as the caller
     * resolved them to different mount paths.
     */
    const a = file('id-A', 'sess-A', 'data.csv');
    const b = file('id-B', 'sess-B', 'data-2.csv');
    const result = seedCodeFilesIntoSessions([a, a, b], undefined);
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(2);
    expect(entry.files!.map((f) => f.storage_session_id).sort()).toEqual(['sess-A', 'sess-B']);
  });

  it('drops a distinct identity that would mount at an already-claimed destination', () => {
    /**
     * Regression for #15443. The identity key cannot see this: one file
     * re-uploaded by one agent and cache-hit by another arrives twice with
     * different `storage_session_id`s under a single `name`. Codeapi rejects
     * the whole `/exec` request on the duplicate destination, and because the
     * call never reaches the sandbox nothing comes back to collapse the pair
     * — every later turn re-primes it and fails the same way.
     */
    const primed = file('id-A', 'sess-A', 'data.csv');
    const reuploaded = file('id-B', 'sess-B', 'data.csv');
    const result = seedCodeFilesIntoSessions([primed, reuploaded], undefined);
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(1);
    expect(entry.files![0].storage_session_id).toBe('sess-A');
  });

  it('lets the prior partition keep a destination an incoming file also wants', () => {
    const existing: ToolSessionMap = new Map();
    existing.set(Constants.EXECUTE_CODE, {
      session_id: 'skill-sess',
      files: [file('skill-1', 'skill-sess', 'skills/report/run.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = seedCodeFilesIntoSessions(
      [file('user-1', 'user-sess', 'skills/report/run.py'), file('user-2', 'user-sess', 'ok.csv')],
      existing,
    );
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files!.map((f) => f.id)).toEqual(['skill-1', 'user-2']);
  });

  it('rejects an incoming file whose destination is a directory of a claimed one', () => {
    const result = seedCodeFilesIntoSessions(
      [file('id-A', 'sess-A', 'data/rows.csv'), file('id-B', 'sess-B', 'data')],
      undefined,
    );
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files!.map((f) => f.id)).toEqual(['id-A']);
  });

  it('seeds only the requested code-session partition', () => {
    const statefulKey = 'execute_code:stateful:v1:user';
    const existing: ToolSessionMap = new Map();
    existing.set(Constants.EXECUTE_CODE, {
      session_id: 'stateless-session',
      files: [file('s1', 'stateless-session', 'stateless.txt')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = seedCodeFilesIntoSessions(
      [file('w1', 'stateful-session', 'stateful.txt')],
      existing,
      statefulKey,
    );

    expect(result!.get(Constants.EXECUTE_CODE)?.files?.map((f) => f.id)).toEqual(['s1']);
    expect(result!.get(statefulKey)?.files?.map((f) => f.id)).toEqual(['w1']);
  });
});

describe('buildAgentInitialToolSessions', () => {
  it('clones only the agent partition and merges files resolved after the run seed', () => {
    const statefulKey = 'execute_code:stateful:v2:user:user-1';
    const statelessFile = file('stateless', 'stateless-session', 'stateless.txt');
    const skillFile = file('skill', 'stateful-skill-session', 'skills/tool.py');
    const lazyAttachment = file('attachment', 'stateful-user-session', 'input.csv');
    const runSessions: ToolSessionMap = new Map([
      [
        Constants.EXECUTE_CODE,
        {
          session_id: statelessFile.storage_session_id,
          files: [statelessFile],
          lastUpdated: 1,
        } satisfies CodeSessionContext,
      ],
      [
        statefulKey,
        {
          session_id: skillFile.storage_session_id,
          files: [skillFile],
          lastUpdated: 2,
        } satisfies CodeSessionContext,
      ],
    ]);

    const result = buildAgentInitialToolSessions(
      { codeSessionKey: statefulKey, primedCodeFiles: [lazyAttachment] },
      runSessions,
    );

    expect(result?.has(Constants.EXECUTE_CODE)).toBe(false);
    expect(result?.get(statefulKey)?.files?.map((entry) => entry.id)).toEqual([
      'skill',
      'attachment',
    ]);
    expect(result).not.toBe(runSessions);
    expect(runSessions.get(statefulKey)?.files?.map((entry) => entry.id)).toEqual(['skill']);
  });
});

describe('buildInitialToolSessions', () => {
  const agent = (
    name: string,
    primedCodeFiles?: CodeEnvFile[],
    subagents?: CodeFilesAgent[],
    codeSessionKey?: string,
  ): CodeFilesAgent & { __label: string } => ({
    __label: name,
    codeSessionKey,
    primedCodeFiles,
    subagentAgentConfigs: subagents,
  });

  it('returns the skill sessions untouched when no agent contributes files', () => {
    const skillSessions: ToolSessionMap = new Map();
    skillSessions.set(Constants.EXECUTE_CODE, {
      session_id: 'skill-sess',
      files: [file('s1', 'skill-sess', 'a.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = buildInitialToolSessions({
      skillSessions,
      agents: [agent('primary'), agent('handoff')],
    });

    expect(result).toBe(skillSessions);
    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(1);
  });

  it('returns undefined when no skills and no agents have primed files', () => {
    const result = buildInitialToolSessions({
      skillSessions: undefined,
      agents: [agent('primary')],
    });
    expect(result).toBeUndefined();
  });

  it('merges primary + handoff agents into one EXECUTE_CODE entry', () => {
    const primary = agent('primary', [file('p1', 'sess-P', 'data.csv')]);
    const handoff = agent('handoff', [file('h1', 'sess-H', 'report.md')]);

    const result = buildInitialToolSessions({
      agents: [primary, handoff],
    });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(2);
    expect(entry.files!.map((f) => f.name).sort()).toEqual(['data.csv', 'report.md']);
  });

  it('walks recursively into subagentAgentConfigs (P2 fix)', () => {
    /**
     * Pure subagents are pruned out of `agentConfigs` after init but
     * retained on the parent's `subagentAgentConfigs`. The recursive
     * walk picks them up so their primed code files seed the same
     * shared `Graph.sessions[EXECUTE_CODE]` entry.
     */
    const grandchild = agent('grandchild', [file('g1', 'sess-G', 'nested.txt')]);
    const child = agent('child', [file('c1', 'sess-C', 'mid.txt')], [grandchild]);
    const primary = agent('primary', [file('p1', 'sess-P', 'top.txt')], [child]);

    const result = buildInitialToolSessions({
      agents: [primary],
    });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    const names = entry.files!.map((f) => f.name).sort();
    expect(names).toEqual(['mid.txt', 'nested.txt', 'top.txt']);
  });

  it('includes graph-subagent members pruned from the top-level agent map', () => {
    const member = agent('graph-member', [file('g1', 'sess-G', 'team.txt')]);
    const primary = agent('primary');
    primary.subagentGraphConfigs = [{ memberConfigs: [member] }];

    const result = buildInitialToolSessions({ agents: [primary] });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files!.map((item) => item.name)).toEqual(['team.txt']);
  });

  it('preserves the skill side representative session_id when merging', () => {
    const skillSessions: ToolSessionMap = new Map();
    skillSessions.set(Constants.EXECUTE_CODE, {
      session_id: 'skill-sess',
      files: [file('s1', 'skill-sess', 'a.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = buildInitialToolSessions({
      skillSessions,
      agents: [agent('primary', [file('p1', 'agent-sess', 'b.csv')])],
    });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.session_id).toBe('skill-sess');
    expect(entry.files).toHaveLength(2);
  });

  it('does not infinite-loop on a cycle in the subagent graph', () => {
    /**
     * Defensive: a misconfigured subagent graph can have A → B → A.
     * The visited Set keyed on object identity must terminate the walk.
     */
    const a = agent('A', [file('a1', 'sess-A', 'a.txt')]);
    const b = agent('B', [file('b1', 'sess-B', 'b.txt')]);
    a.subagentAgentConfigs = [b];
    b.subagentAgentConfigs = [a];

    const result = buildInitialToolSessions({ agents: [a] });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files!.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('skips undefined / null entries in the agents iterable (defensive)', () => {
    const result = buildInitialToolSessions({
      agents: [undefined, agent('primary', [file('p1', 'sess-P', 'x.txt')]), null] as Array<
        CodeFilesAgent | undefined | null
      >,
    });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(1);
    expect(entry.files![0].name).toBe('x.txt');
  });

  it('walks primary-first so the primary supplies the representative session_id (no skill seed)', () => {
    /**
     * Regression: a LIFO stack would visit the last top-level agent
     * first, flipping which agent's first file becomes the
     * representative `session_id` written to the EXECUTE_CODE entry.
     * The walk is FIFO so the primary always lands first.
     */
    const primary = agent('primary', [file('p1', 'sess-PRIMARY', 'top.txt')]);
    const handoffA = agent('handoff-A', [file('a1', 'sess-A', 'a.txt')]);
    const handoffB = agent('handoff-B', [file('b1', 'sess-B', 'b.txt')]);

    const result = buildInitialToolSessions({
      agents: [primary, handoffA, handoffB],
    });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.session_id).toBe('sess-PRIMARY');
    /* All three agents still contributed their files into the merged set. */
    expect(entry.files!.map((f) => f.name).sort()).toEqual(['a.txt', 'b.txt', 'top.txt']);
    /* And the per-file storage_session_ids are preserved (ToolNode injects per-file). */
    const byName = new Map(entry.files!.map((f) => [f.name, f.storage_session_id]));
    expect(byName.get('top.txt')).toBe('sess-PRIMARY');
    expect(byName.get('a.txt')).toBe('sess-A');
    expect(byName.get('b.txt')).toBe('sess-B');
  });

  it('dedupes shared conversation files across multiple run agents (Codex review #2)', () => {
    /**
     * The realistic case: a conversation with a primary + handoff +
     * subagent all sharing the SAME `tool_resources.execute_code`
     * file_ids. Without dedupe, the same file ref would land in
     * `_injected_files` 3 times and bloat the `/exec` POST. With
     * dedupe, exactly one ref reaches the sandbox.
     */
    const sharedFile = file('shared-id', 'sess-shared', 'data.csv');
    const result = buildInitialToolSessions({
      agents: [
        agent('primary', [sharedFile, file('p1', 'sess-P', 'private.csv')]),
        agent('handoff', [sharedFile]),
        agent('subagent', [sharedFile, file('s1', 'sess-S', 'sub.csv')]),
      ],
    });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(3);
    expect(entry.files!.map((f) => f.id).sort()).toEqual(['p1', 's1', 'shared-id']);
  });

  it('deduplicates a single agent referenced as both primary and a subagent', () => {
    /**
     * `agentConfigs` may include an agent that is also a subagent of
     * another. Visiting it twice would double-merge its files. The
     * visited Set prevents that.
     */
    const shared = agent('shared', [file('s1', 'sess-S', 'shared.csv')]);
    const primary = agent('primary', [file('p1', 'sess-P', 'top.csv')], [shared]);

    const result = buildInitialToolSessions({
      agents: [primary, shared],
    });

    const entry = result!.get(Constants.EXECUTE_CODE) as CodeSessionContext;
    expect(entry.files).toHaveLength(2);
    expect(entry.files!.map((f) => f.name).sort()).toEqual(['shared.csv', 'top.csv']);
  });

  it('keeps stateless and stateful agent files in separate partitions', () => {
    const statefulKey = 'execute_code:stateful:v1:user';
    const skillSessions: ToolSessionMap = new Map();
    skillSessions.set(Constants.EXECUTE_CODE, {
      session_id: 'skill-sess',
      files: [file('skill-1', 'skill-sess', 'skill.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);
    skillSessions.set(statefulKey, {
      session_id: 'stateful-skill-sess',
      files: [file('stateful-skill-1', 'stateful-skill-sess', 'skill.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = buildInitialToolSessions({
      skillSessions,
      agents: [
        agent('stateless', [file('s1', 'stateless-sess', 'stateless.txt')]),
        agent('stateful', [file('w1', 'stateful-sess', 'stateful.txt')], undefined, statefulKey),
      ],
    });

    expect(result!.get(Constants.EXECUTE_CODE)?.files?.map((f) => f.id)).toEqual(['skill-1', 's1']);
    expect(result!.get(statefulKey)?.files?.map((f) => f.id)).toEqual(['stateful-skill-1', 'w1']);
  });

  it('shares user-scoped stateful files but isolates agent-user scopes', () => {
    const userKey = 'execute_code:stateful:v1:user';
    const firstAgentKey = 'execute_code:stateful:v1:agent-user:agent-a';
    const secondAgentKey = 'execute_code:stateful:v1:agent-user:agent-b';

    const result = buildInitialToolSessions({
      agents: [
        agent('user-a', [file('u1', 'user-a-sess', 'a.txt')], undefined, userKey),
        agent('user-b', [file('u2', 'user-b-sess', 'b.txt')], undefined, userKey),
        agent('agent-a', [file('a1', 'agent-a-sess', 'private-a.txt')], undefined, firstAgentKey),
        agent('agent-b', [file('b1', 'agent-b-sess', 'private-b.txt')], undefined, secondAgentKey),
      ],
    });

    expect(result!.get(userKey)?.files?.map((f) => f.id)).toEqual(['u1', 'u2']);
    expect(result!.get(firstAgentKey)?.files?.map((f) => f.id)).toEqual(['a1']);
    expect(result!.get(secondAgentKey)?.files?.map((f) => f.id)).toEqual(['b1']);
    expect(result!.has(Constants.EXECUTE_CODE)).toBe(false);
  });

  it('preserves a profile-local stateful skill seed without agent files', () => {
    const statefulKey = 'execute_code:stateful:v1:user';
    const skillSessions: ToolSessionMap = new Map();
    skillSessions.set(statefulKey, {
      session_id: 'skill-sess',
      files: [file('skill-1', 'skill-sess', 'skill.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = buildInitialToolSessions({
      skillSessions,
      agents: [agent('stateful', undefined, undefined, statefulKey)],
    });

    expect(result!.get(statefulKey)?.files?.map((f) => f.id)).toEqual(['skill-1']);
  });

  it('never copies a default-profile skill pointer into a stateful partition', () => {
    const statefulKey = 'execute_code:stateful:v1:user';
    const skillSessions: ToolSessionMap = new Map();
    skillSessions.set(Constants.EXECUTE_CODE, {
      session_id: 'default-skill-sess',
      files: [file('skill-1', 'default-skill-sess', 'skill.py')],
      lastUpdated: 1,
    } satisfies CodeSessionContext);

    const result = buildInitialToolSessions({
      skillSessions,
      agents: [agent('stateful', undefined, undefined, statefulKey)],
    });

    expect(result!.has(statefulKey)).toBe(false);
  });
});

describe('collectCodeExecutionProfileRoutes', () => {
  it('groups reachable code agents by deployment and retains each trusted partition', () => {
    const statelessContext = {
      baseUrl: 'https://code.example.com/v1',
      codeSessionKey: Constants.EXECUTE_CODE,
      executionProfile: 'default' as const,
      statefulSessions: false,
    };
    const statefulContext = (key: string) => ({
      baseUrl: 'https://stateful.example.com/v1',
      codeSessionKey: key,
      executionProfile: 'stateful' as const,
      runtimeSessionHint: key.slice('execute_code:stateful:'.length),
      statefulSessions: true,
    });
    const childKey = 'execute_code:stateful:v2:agent-user:child';
    const parentKey = 'execute_code:stateful:v2:user:shared';
    const child: CodeFilesAgent = {
      codeEnvAvailable: true,
      codeExecutionContext: statefulContext(childKey),
      codeSessionKey: childKey,
    };

    const routes = collectCodeExecutionProfileRoutes([
      {
        codeEnvAvailable: true,
        codeExecutionContext: statelessContext,
        codeSessionKey: Constants.EXECUTE_CODE,
      },
      {
        codeEnvAvailable: true,
        codeExecutionContext: statefulContext(parentKey),
        codeSessionKey: parentKey,
        subagentAgentConfigs: [child],
      },
      { codeEnvAvailable: false, codeExecutionContext: statefulContext('ignored') },
    ]);

    expect(routes).toEqual([
      {
        codeExecutionContext: statelessContext,
        codeSessionKeys: [Constants.EXECUTE_CODE],
      },
      {
        codeExecutionContext: statefulContext(parentKey),
        codeSessionKeys: [parentKey, childKey],
      },
    ]);
  });

  it('includes execution routes used only by graph-subagent members', () => {
    const graphKey = 'execute_code:stateful:v2:user:graph-member';
    const graphContext = {
      baseUrl: 'https://stateful.example.com/v1',
      codeSessionKey: graphKey,
      executionProfile: 'stateful' as const,
      runtimeSessionHint: 'v2:user:graph-member',
      statefulSessions: true,
    };

    const routes = collectCodeExecutionProfileRoutes([
      {
        id: 'parent',
        codeEnvAvailable: false,
        subagentGraphConfigs: [
          {
            memberConfigs: [
              {
                id: 'graph-member',
                codeEnvAvailable: true,
                codeExecutionContext: graphContext,
                codeSessionKey: graphKey,
              },
            ],
          },
        ],
      },
    ]);

    expect(routes).toEqual([{ codeExecutionContext: graphContext, codeSessionKeys: [graphKey] }]);
  });

  it('keeps configured stateful deployments in separate routing namespaces', () => {
    const context = (executionRouteKey: string, baseUrl: string) => ({
      baseUrl,
      codeSessionKey: `execute_code:stateful:${executionRouteKey}`,
      executionProfile: 'stateful' as const,
      executionRouteKey,
      runtimeSessionHint: `v3:${executionRouteKey}:user:scope`,
      statefulSessions: true,
    });
    const first = context('stateful:first', 'https://first.example/v1');
    const second = context('stateful:second', 'https://second.example/v1');

    const routes = collectCodeExecutionProfileRoutes([
      { codeEnvAvailable: true, codeExecutionContext: first },
      { codeEnvAvailable: true, codeExecutionContext: second },
    ]);

    expect(routes).toEqual([
      { codeExecutionContext: first, codeSessionKeys: [first.codeSessionKey] },
      { codeExecutionContext: second, codeSessionKeys: [second.codeSessionKey] },
    ]);
  });

  it('derives and includes the trusted profile for a lazy subagent descriptor', () => {
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://stateful.example.com/v1';
    const routes = collectCodeExecutionProfileRoutes(
      [
        {
          id: 'parent',
          codeEnvAvailable: false,
          lazySubagentConfigs: [
            {
              id: 'lazy-child',
              codeEnvAvailable: true,
              statefulCodeSessions: true,
              statefulCodeEnvironment: 'agent-user',
            },
          ],
        },
      ],
      { userId: 'user-1', conversationId: 'conversation-1' },
    );

    expect(routes).toHaveLength(1);
    expect(routes[0].codeExecutionContext).toEqual(
      expect.objectContaining({
        executionProfile: 'stateful',
        statefulSessions: true,
      }),
    );
    expect(routes[0].codeSessionKeys).toEqual([
      expect.stringMatching(/^execute_code:stateful:v2:agent-user:/),
    ]);
    delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
  });
});
