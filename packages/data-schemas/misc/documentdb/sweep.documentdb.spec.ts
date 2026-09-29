import mongoose from 'mongoose';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import fs from 'fs';
import { MongoServerError } from 'mongodb';
import type { Collection } from 'mongodb';
import type { ConnectOptions } from 'mongoose';
import {
  Permissions,
  PermissionBits,
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionTypes,
} from 'librechat-data-provider';
import {
  createMCPAuthorityBootRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityDatabaseSourceRevision,
} from '~/methods/mcpAuthority';
import type { MCPOptions } from 'librechat-data-provider';
import { tenantStorage } from '~/config/tenantContext';
import type { AllMethods } from '~/methods';
import { createMethods } from '~/methods';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

/**
 * Method sweep: drives EVERY exported data-schemas method against a real
 * engine and records, per method, how many driver queries it issued and
 * whether the engine rejected any of them.
 *
 * This exists because hand-picked probe lists inherit the auditor's blind
 * spots: every DocumentDB incompatibility found so far (pipeline updates,
 * `$$REMOVE`, `$facet`, the transaction probe, the Mongoose-compiled mixed
 * projection) was invisible until someone thought to look for its class. The
 * sweep flips that: the engine itself adjudicates every query each method
 * emits. Query shapes are parsed before they are matched, so even an empty
 * database adjudicates most entry paths.
 *
 * The sweep is honest about its limits instead of quietly green:
 * - `not-driven` — the method issued zero driver queries (input validation
 *   rejected the synthesized arguments, or a guard early-returned). NOT
 *   adjudicated; add an override in `ARG_OVERRIDES` to drive it.
 * - `queries: N` — how many driver calls the engine actually saw. Deep branches
 *   behind state the sweep did not seed remain uncovered; the number makes the
 *   partiality visible.
 *
 * Runs in two modes with identical mechanics, so matrices diff cleanly:
 *   SWEEP_BASELINE=true            → in-memory real MongoDB (free; CI-able)
 *   DOCUMENTDB_URI=...             → live Amazon DocumentDB (see
 *                                    audit.documentdb.spec.ts for the
 *                                    connection recipe; every parameter is
 *                                    load-bearing through a tunnel)
 * SWEEP_REPORT_PATH writes the matrix as JSON for machine diffing.
 * DOCUMENTDB_STRICT=true fails the suite on any engine rejection.
 */
const DOCUMENTDB_URI = process.env.DOCUMENTDB_URI ?? '';
const BASELINE = process.env.SWEEP_BASELINE === 'true';
const STRICT = process.env.DOCUMENTDB_STRICT === 'true';
const REPORT_PATH = process.env.SWEEP_REPORT_PATH ?? '';
const describeSweep = DOCUMENTDB_URI || BASELINE ? describe : describe.skip;

const METHOD_TIMEOUT_MS = 20_000;
const runId = randomUUID().slice(0, 8);

interface MethodVerdict {
  queries: number;
  engineError?: string;
  outcome: 'ok' | 'engine-rejected' | 'not-driven' | 'no-queries' | 'threw' | 'timeout';
  detail?: string;
}

const verdicts: Record<string, MethodVerdict> = {};
const stragglers: Array<Promise<unknown>> = [];
/** Attribution rides the method's own async context: a straggler that
 * outlives its timeout keeps issuing queries under ITS label instead of
 * corrupting whichever row the sweep has moved on to. */
const sweepContext = new AsyncLocalStorage<string>();
const activeLabel = (): string | null => sweepContext.getStore() ?? null;

const DRIVER_OPS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
  'insertOne',
  'insertMany',
  'deleteOne',
  'deleteMany',
  'aggregate',
  'countDocuments',
  'distinct',
  'bulkWrite',
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'listIndexes',
] as const;

/** Server errors that are not engine incompatibilities: duplicate keys prove
 * the write REACHED the engine and hit a constraint, and `NamespaceExists`
 * (48) is the expected outcome of the authority path's idempotent namespace
 * preflight when a collection is already present. */
const BENIGN_SERVER_CODES = new Set([11000, 11001, 48]);

function recordEngineError(label: string | null, error: unknown): void {
  if (label == null) return;
  const err = error as { name?: string; message?: string; code?: number };
  /** `instanceof` covers the driver's server-error subclasses
   * (MongoWriteConcernError, MongoBulkWriteError, ...) whose `name` differs
   * from the base class — a write-concern rejection at commit must not slip
   * through as a mere domain throw. */
  if (!(error instanceof MongoServerError)) return;
  if (err.code != null && BENIGN_SERVER_CODES.has(err.code)) return;
  if (/E11000/.test(String(err.message))) return;
  const verdict = (verdicts[label] ??= { queries: 0, outcome: 'ok' });
  if (verdict.engineError == null) {
    verdict.engineError = String(err.message).replace(/\s+/g, ' ').slice(0, 160);
  }
}

/** Cursor-returning ops surface parse errors on consumption, not on the call,
 * so the cursor's promise-returning members are wrapped with the label that
 * was current when the cursor was created. */
function wrapCursor<T extends object>(cursor: T, label: string | null): T {
  return new Proxy(cursor, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return function wrapped(this: unknown, ...args: unknown[]) {
        const result = value.apply(target, args);
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            recordEngineError(label, error);
            throw error;
          });
        }
        return result;
      };
    },
  });
}

function instrumentDriver(): void {
  const sample = mongoose.connection.db?.collection(`sweep_probe_${runId}`);
  if (sample == null) throw new Error('no database handle to instrument');
  const proto = Object.getPrototypeOf(sample) as Collection & Record<string, unknown>;
  for (const op of DRIVER_OPS) {
    const original = proto[op] as (...args: unknown[]) => unknown;
    if (typeof original !== 'function' || (original as { __swept?: boolean }).__swept) continue;
    const wrapped = function (this: Collection, ...args: unknown[]) {
      const label = activeLabel();
      if (label != null) {
        (verdicts[label] ??= { queries: 0, outcome: 'ok' }).queries += 1;
      }
      const result = original.apply(this, args);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          recordEngineError(label, error);
          throw error;
        });
      }
      if (op === 'find' || op === 'aggregate' || op === 'listIndexes') {
        return wrapCursor(result as object, label);
      }
      return result;
    };
    (wrapped as { __swept?: boolean }).__swept = true;
    (proto as Record<string, unknown>)[op] = wrapped;
  }
}

/** Namespace DDL goes through `Db`, not the `Collection` prototype: the
 * authority path's `Model.createCollection()` preflight delegates to
 * `Db.createCollection`. Without this, a DocumentDB rejection of that DDL is
 * laundered by `asMCPError` into `proof_unavailable`, the row reads as a mere
 * `threw`, and STRICT passes despite an engine rejection. */
function instrumentDatabase(): void {
  const db = mongoose.connection.db;
  if (db == null) throw new Error('no database handle to instrument');
  const proto = Object.getPrototypeOf(db) as Record<string, unknown>;
  for (const op of ['createCollection', 'dropCollection', 'renameCollection']) {
    const original = proto[op] as (...args: unknown[]) => unknown;
    if (typeof original !== 'function' || (original as { __swept?: boolean }).__swept) continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const label = activeLabel();
      if (label != null) {
        (verdicts[label] ??= { queries: 0, outcome: 'ok' }).queries += 1;
      }
      const result = original.apply(this, args);
      if (result instanceof Promise) {
        return result.catch((error: unknown) => {
          recordEngineError(label, error);
          throw error;
        });
      }
      return result;
    };
    (wrapped as { __swept?: boolean }).__swept = true;
    proto[op] = wrapped;
  }
}

/** Transaction-lifecycle rejections surface from the session, not from a
 * collection operation, and several methods convert them into domain errors —
 * without this, a real `commitTransaction` engine rejection classifies as a
 * mere `threw` and STRICT passes. */
async function instrumentSessions(): Promise<void> {
  const session = await mongoose.startSession();
  try {
    const proto = Object.getPrototypeOf(session) as Record<string, unknown>;
    for (const op of ['commitTransaction', 'abortTransaction', 'withTransaction']) {
      const original = proto[op] as (...args: unknown[]) => unknown;
      if (typeof original !== 'function' || (original as { __swept?: boolean }).__swept) continue;
      const wrapped = function (this: unknown, ...args: unknown[]) {
        const label = activeLabel();
        if (label != null) {
          (verdicts[label] ??= { queries: 0, outcome: 'ok' }).queries += 1;
        }
        const result = original.apply(this, args);
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            recordEngineError(label, error);
            throw error;
          });
        }
        return result;
      };
      (wrapped as { __swept?: boolean }).__swept = true;
      proto[op] = wrapped;
    }
  } finally {
    await session.endSession();
  }
}

const objectId = () => new mongoose.Types.ObjectId();
const OBJECT_ID_PARAMS =
  /^(user|author|owner|principalId|targetId|granteeId|grantedById|revokedBy|agentId)$/;
const DATE_PARAMS = /(At|Until|Before|After|Date|Cutoff)$|^(now|date|fenceStartedAt)$/;
const NUMBER_PARAMS =
  /^(limit|count|page|pageSize|size|amount|n|attempt|sequence|version|epoch|tokenCount|priority|expiredMessageRetentionDays)$|(Limit|Count|Ms|Bytes|Days)$/;
const BOOLEAN_PARAMS = /^(is|has|should|include|mark|force|replay|dry)/;
const ARRAY_PARAMS =
  /(Ids|Keys|ids|keys|Names)$|^(tags|conversations|files|messages|targets|principals|entries|updates|operations|roles|values)$/;

function valueFor(name: string): unknown {
  if (name === 'mongoose') return mongoose;
  if (name === 'kind') return 'manual';
  /** Typed-criteria parameters (`utils/criteria.ts`) are validated key by key
   * and fail closed, so a synthesized string is read as a criteria object and
   * rejected at index '0'. An empty criteria object is valid, builds an empty
   * filter, and still reaches the engine. `searchMessages` is the sole method
   * whose `query` parameter is a genuine string (verified across
   * `src/methods`); it carries an `ARG_OVERRIDES` entry so it keeps one. A
   * future string-valued `query`/`criteria`/`filter` parameter would need the
   * same treatment — the symptom is a method reporting `threw` on a type
   * error rather than reaching the database. */
  if (/^(query|criteria|filter)$/.test(name)) return {};
  if (/pipeline/i.test(name)) return [{ $match: { _id: objectId() } }];
  if (OBJECT_ID_PARAMS.test(name)) return objectId();
  if (ARRAY_PARAMS.test(name)) return [`sweep-${name}-${runId}`];
  if (/Until$/.test(name)) return new Date(Date.now() + 60_000);
  if (DATE_PARAMS.test(name)) return new Date();
  if (NUMBER_PARAMS.test(name) || /limit/i.test(name)) return 2;
  if (BOOLEAN_PARAMS.test(name)) return false;
  if (/tenantId/i.test(name)) return undefined;
  if (name === 'conversationId' || name === 'threadId') return randomUUID();
  if (name === 'email') return `sweep-${runId}@sweep.test`;
  return `sweep-${name}-${runId}`;
}

/** Walks the argument tree replacing every exact occurrence of a value. */
function replaceValue(node: unknown, target: string, replacement: unknown): unknown {
  if (typeof node === 'string') return node === target ? replacement : node;
  if (Array.isArray(node)) return node.map((item) => replaceValue(item, target, replacement));
  if (node != null && typeof node === 'object' && !(node instanceof Date)) {
    if (node instanceof mongoose.Types.ObjectId) return node;
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, replaceValue(value, target, replacement)]),
    );
  }
  return node;
}

/** Repairs synthesized arguments from a validation error's own message, so the
 * retry reaches the database instead of being reported `not-driven`. Returns
 * the repaired arguments, or null when the error is not machine-repairable. */
function adaptArgs(args: unknown[], error: unknown, paramNames: string[] = []): unknown[] | null {
  const message = String((error as { message?: string })?.message ?? '');
  let match = /Cast to (?:\[)?ObjectId(?:\])? failed for value "+?\[?'?"?([^"'\]]+)/.exec(message);
  if (match != null) {
    return args.map((arg) => replaceValue(arg, match![1], objectId())) as unknown[];
  }
  match = /Cast to (?:\[)?Number(?:\])? failed for value "([^"]+)"/.exec(message);
  if (match != null) {
    return args.map((arg) => replaceValue(arg, match![1], 2)) as unknown[];
  }
  match = /Cast to (?:\[)?date(?:\])? failed for value "([^"]+)"/i.exec(message);
  if (match != null) {
    return args.map((arg) => replaceValue(arg, match![1], new Date())) as unknown[];
  }
  match = /Cast to (?:Embedded|\[Embedded\]|Map|Mixed) failed for value "([^"]+)"/.exec(message);
  if (match != null) {
    return args.map((arg) => replaceValue(arg, match![1], {})) as unknown[];
  }
  if (/must be an object/.test(message)) {
    const repaired = args.map((arg) => {
      if (Array.isArray(arg)) return arg.map((item) => (typeof item === 'string' ? {} : item));
      if (typeof arg === 'string') return {};
      return arg;
    });
    return JSON.stringify(repaired) === JSON.stringify(args) ? null : repaired;
  }
  const requiredPaths = [
    ...message.matchAll(/Path `([A-Za-z_$][A-Za-z0-9_$.]*)` is required/g),
  ].map((m) => m[1]);
  if (requiredPaths.length > 0) {
    const objectIndex = args.findIndex((arg) => arg != null && typeof arg === 'object');
    const target = (objectIndex >= 0 ? { ...(args[objectIndex] as object) } : {}) as Record<
      string,
      unknown
    >;
    for (const path of requiredPaths) {
      target[path.split('.')[0]] = valueFor(path.split('.')[0]);
    }
    const repaired = [...args];
    if (objectIndex >= 0) repaired[objectIndex] = target;
    else repaired.push(target);
    return repaired;
  }
  return null;
}

interface SweepCase {
  args: unknown[];
  /** Optional execution wrapper, e.g. to run the call in tenant context. */
  within?: <T>(run: () => Promise<T>) => Promise<T>;
}

/** Per-method cases where name-pattern synthesis cannot produce a shape that
 * reaches the database (validation rejects it, a guard early-returns, or the
 * interesting path needs seeded prerequisite records). Grow this whenever the
 * matrix reports `not-driven` for a path worth adjudicating. */
const ARG_OVERRIDES: Record<string, () => SweepCase | Promise<SweepCase>> = {
  /** Positional (searchParameter, id): a synthesized string for the first
   * parameter lands inside a `$match` and malforms it on both engines. */
  getAgentWithVersionCount: () => ({ args: [{ id: `agent-sweep-${runId}` }] }),
  /** Takes a genuine search string, not typed criteria: the criteria-shaped
   * synthesis above would hand it an object, which a Meili-enabled deployment
   * forwards verbatim into `meiliSearch` and adjudicates a harness-generated
   * request instead of the method's real behavior. */
  searchMessages: () => ({ args: [`sweep-search-${runId}`, { page: 1, limit: 2 }, false] }),
  /** The bounded authority snapshot is the one production path that COMMITS a
   * transaction; generic synthesis dies on target validation before a session
   * ever starts, which would leave the session instrumentation exercising
   * nothing. Seeds the full fixture (ported from compat.documentdb.spec.ts)
   * and runs the call in the same tenant context. */
  resolveMCPAuthorityProof: async () => {
    const tenantId = `sweep-authority-${runId}`;
    const roleName = `SWEEP_AUTHORITY_${runId}`;
    const serverName = `sweep-authority-server-${runId}`;
    const models = mongoose.models;
    const userId = new mongoose.Types.ObjectId();
    const serverId = new mongoose.Types.ObjectId();
    const context = { tenantId, userId: userId.toHexString() };
    await tenantStorage.run(context, async () => {
      await models.User.create({
        _id: userId,
        name: 'Sweep authority probe',
        email: `sweep-authority-${runId}@sweep.test`,
        provider: 'local',
        role: roleName,
      });
      await models.Role.create({
        name: roleName,
        permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } },
      });
      await models.MCPServer.create({
        _id: serverId,
        serverName,
        config: { type: 'sse', url: `https://${serverName}.example/mcp` },
        author: userId,
      });
      await models.Agent.create({
        id: `sweep-authority-agent-${runId}`,
        name: 'Sweep authority probe agent',
        provider: 'openAI',
        model: 'probe-model',
        author: userId,
        mcpServerNames: [serverName],
      });
      await models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: userId,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.MCPSERVER,
        resourceId: serverId,
        permBits: PermissionBits.VIEW,
        grantedBy: userId,
      });
      /** The proof transaction READS PluginAuth, Token, Group, and Config;
       * with `autoCreate: false` on a fresh run-scoped database those
       * collections do not exist, and DocumentDB rejects any statement in a
       * transaction that touches a non-existent collection — surfacing as
       * `proof_unavailable` before the commit is ever reached. Materialize
       * every transaction-read collection outside the transaction. */
      await models.PluginAuth.createCollection();
      await models.Token.createCollection();
      await models.Group.createCollection();
      await models.Config.createCollection();
    });
    const server = await tenantStorage.run(context, () =>
      models.MCPServer.findById(serverId).lean<{
        _id: mongoose.Types.ObjectId;
        serverName: string;
        author: mongoose.Types.ObjectId;
        config: MCPOptions;
        createdAt: Date;
        updatedAt: Date;
      }>(),
    );
    if (server == null) {
      throw new Error('sweep authority fixture server was not created');
    }
    const sourceRevision = createMCPAuthorityDatabaseSourceRevision({
      databaseId: server._id.toHexString(),
      serverName: server.serverName,
      author: server.author.toString(),
      config: server.config,
      createdAt: server.createdAt,
      updatedAt: server.updatedAt,
    });
    return {
      args: [
        {
          userId: userId.toHexString(),
          tenantId,
          boot: createMCPAuthorityBootRevision(`sweep-${runId}`, { mcpServers: {} }),
          targets: [
            {
              serverName,
              source: 'database',
              databaseId: serverId.toHexString(),
              sourceRevision,
              expectedCredentialRevision: createMCPAuthorityCredentialRevision([], []),
              expectedOAuthGrantGeneration: null,
              resolvedConfig: server.config,
            },
          ],
        },
      ],
      within: (run) => tenantStorage.run(context, run),
    };
  },
};

/** Parses the function source just enough to synthesize a plausible call:
 * either one destructured options object or a positional list. */
function synthesizeArgs(fn: (...args: unknown[]) => unknown): unknown[] {
  const source = fn.toString();
  const header = source.slice(0, source.indexOf(')') + 1);
  const paramList = header.slice(header.indexOf('(') + 1, -1).trim();
  if (paramList.length === 0) return [];
  if (paramList.startsWith('{')) {
    const keys = [...paramList.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*[,:=}]/g)].map((m) => m[1]);
    return [Object.fromEntries(keys.map((key) => [key, valueFor(key)]))];
  }
  const names = paramList
    .split(',')
    .map((part) => part.trim().split(/[=:\s]/)[0])
    .filter((name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name));
  return names.map((name) =>
    name === 'input' || name === 'params' || name === 'options' || name === 'data'
      ? synthesizeObjectFromBody(fn)
      : valueFor(name),
  );
}

/** For `function (input) { ... input.userId ... }` shapes: harvest the
 * property names the body reads off the single object parameter. */
function synthesizeObjectFromBody(fn: (...args: unknown[]) => unknown): Record<string, unknown> {
  const source = fn.toString();
  const parameter = source
    .slice(source.indexOf('(') + 1, source.indexOf(')'))
    .split(',')[0]
    ?.trim()
    .split(/[=:\s]/)[0];
  if (parameter == null || parameter.length === 0) return {};
  const reads = [
    ...source.matchAll(new RegExp(`${parameter}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, 'g')),
  ].map((m) => m[1]);
  return Object.fromEntries([...new Set(reads)].map((key) => [key, valueFor(key)]));
}

const models = createModels(mongoose);
Object.assign(mongoose.models, models);
/** No dependency overrides: `createMethods` supplies a real
 * `removeAllPermissions` that delegates to `deleteAclEntries`, so the driven
 * deletion cascades exercise their ACL database operations. */
const methods = createMethods(mongoose);
type SweepFn = (...args: unknown[]) => unknown;
/** Every AllMethods member is a function; the per-entry conversion is the
 * variadic-unknown view the sweep needs to invoke them generically. */
const methodMap: Record<string, SweepFn> = Object.fromEntries(
  Object.entries(methods).flatMap(([name, member]) =>
    /** Error classes ride along in some method bundles (e.g. `SessionError`);
     * a constructor is not a sweepable method and would inflate the totals as
     * a permanently un-driven row. */
    typeof member === 'function' && !/^class[\s{]/.test(String(member))
      ? [[name, member as SweepFn]]
      : [],
  ),
);
const methodNames = Object.keys(methodMap).sort();

let memoryServer: MongoMemoryReplSet | undefined;

describeSweep(`data-schemas method sweep (${BASELINE ? 'MongoDB baseline' : 'DocumentDB'})`, () => {
  beforeAll(async () => {
    if (BASELINE) {
      /** A single-node replica set, not a standalone: driven methods start
       * real transactions, and a standalone baseline would reject them for
       * topology reasons and manufacture a false matrix divergence. The
       * connection options mirror the live branch exactly — model collections
       * and indexes must not be pre-created outside instrumentation in one
       * mode and absent in the other. */
      memoryServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
      await mongoose.connect(memoryServer.getUri(), {
        autoIndex: false,
        autoCreate: false,
        dbName: `librechat_sweep_${runId}`,
      });
    } else {
      const options: ConnectOptions = { autoIndex: false, autoCreate: false };
      if (process.env.DOCUMENTDB_TLS_CA_FILE) {
        options.tlsCAFile = process.env.DOCUMENTDB_TLS_CA_FILE;
      }
      if (process.env.DOCUMENTDB_TLS_ALLOW_INVALID_HOSTNAMES === 'true') {
        options.tlsAllowInvalidHostnames = true;
      }
      /** A run-scoped database: the sweep writes into real model collections
       * and drops its database afterwards, and the sibling live suites share
       * the URI — dropping THEIR database mid-run would make their results
       * nondeterministic. */
      await mongoose.connect(DOCUMENTDB_URI, {
        ...options,
        dbName: `librechat_sweep_${runId}`,
      });
    }
    instrumentDriver();
    instrumentDatabase();
    await instrumentSessions();
  }, 120_000);

  afterAll(async () => {
    /** Settle timed-out invocations (bounded) BEFORE tearing the engine down:
     * dropping the database or closing the client would abort their
     * outstanding work with closed-client errors that are not engine verdicts,
     * leaving the row unadjudicated while STRICT passes. */
    if (stragglers.length > 0) {
      await Promise.race([
        Promise.allSettled(stragglers),
        new Promise((resolve) => setTimeout(resolve, 15_000).unref()),
      ]);
    }
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db?.dropDatabase().catch(() => undefined);
      await mongoose.disconnect();
    }
    await memoryServer?.stop();

    for (const verdict of Object.values(verdicts)) {
      if (verdict.engineError != null) {
        verdict.outcome = 'engine-rejected';
      }
    }
    const rows = methodNames.map((name) => {
      const verdict = verdicts[name] ?? { queries: 0, outcome: 'no-queries' as const };
      return { name, ...verdict };
    });
    const rejected = rows.filter((row) => row.outcome === 'engine-rejected');
    const notDriven = rows.filter(
      (row) => row.outcome === 'not-driven' || row.outcome === 'no-queries',
    );
    const width = Math.max(...rows.map((row) => row.name.length));
    console.log(
      `\nMethod sweep matrix (run ${runId}, ${BASELINE ? 'baseline' : 'documentdb'}):\n` +
        rows
          .map(
            (row) =>
              `  ${row.name.padEnd(width)}  q=${String(row.queries).padStart(3)}  ${row.outcome}` +
              (row.engineError ? `  ${row.engineError}` : '') +
              (row.detail ? `  (${row.detail})` : ''),
          )
          .join('\n') +
        `\n  TOTAL ${rows.length} | rejected ${rejected.length} | not-driven ${notDriven.length}\n`,
    );
    if (REPORT_PATH) {
      /** `rows` is the canonical cross-engine payload: run-specific values are
       * normalized out (this run's id, generated ObjectIds/UUIDs, and the
       * hex/uuid fragments that synthesized arguments embed in error text), so
       * `diff <(jq .rows a.json) <(jq .rows b.json)` shows engine behavior
       * only. Run metadata stays outside it. */
      const normalize = (text?: string): string | undefined =>
        text
          ?.split(runId)
          .join('<run>')
          .replace(/[0-9a-f]{24}/gi, '<oid>')
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
      fs.writeFileSync(
        REPORT_PATH,
        JSON.stringify(
          {
            meta: { runId, baseline: BASELINE },
            rows: rows
              .map((row) => ({
                name: row.name,
                queries: row.queries,
                outcome: row.outcome,
                engineError: normalize(row.engineError),
                detail: normalize(row.detail),
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          },
          null,
          2,
        ),
      );
    }
    if (STRICT) {
      /** Enforced against the FINALIZED rows: the per-test assertion has
       * already passed for a row that timed out and only later recorded its
       * engine rejection. */
      expect(rejected.map((row) => `${row.name}: ${row.engineError}`)).toEqual([]);
    }
  }, 120_000);

  it.each(methodNames)(
    '%s',
    async (name) => {
      /** A fresh bundle per case: factory-local caches (e.g. the session
       * methods' `sessionIndexesPromise`) otherwise leak across alphabetically
       * ordered rows, so a later method returns a settled promise without
       * issuing its own queries and is misreported as `no-queries`. */
      const fn = createMethods(mongoose)[name as keyof AllMethods] as SweepFn;
      const sweepCase: SweepCase = (await ARG_OVERRIDES[name]?.()) ?? {
        args: synthesizeArgs(fn),
      };
      const args = sweepCase.args;
      const within = sweepCase.within ?? (<T>(run: () => Promise<T>) => run());
      const verdict = (verdicts[name] ??= { queries: 0, outcome: 'ok' });
      let callArgs = args;
      const deadline = Date.now() + METHOD_TIMEOUT_MS - 5_000;
      await sweepContext.run(name, async () => {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          try {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
              verdict.outcome = 'timeout';
              break;
            }
            let raceTimer: NodeJS.Timeout | undefined;
            const invocation = Promise.resolve(within(() => Promise.resolve(fn(...callArgs))));
            try {
              await Promise.race([
                invocation,
                new Promise((_, reject) => {
                  raceTimer = setTimeout(() => reject(new Error('sweep-timeout')), remaining);
                }),
              ]);
            } catch (raceError) {
              if ((raceError as Error)?.message === 'sweep-timeout') {
                /** The abandoned invocation keeps running under ITS OWN async
                 * context; the finalization pass awaits it so a late engine
                 * rejection still lands on this row before STRICT is enforced. */
                stragglers.push(invocation.catch(() => undefined));
              }
              throw raceError;
            } finally {
              clearTimeout(raceTimer);
            }
            verdict.detail = undefined;
            break;
          } catch (error) {
            const err = error as { name?: string; message?: string };
            if (err?.message === 'sweep-timeout') {
              verdict.outcome = 'timeout';
              break;
            }
            verdict.detail = `${err?.name ?? 'Error'}: ${String(err?.message).slice(0, 80)}`;
            const repaired = verdict.engineError == null ? adaptArgs(callArgs, error) : null;
            if (repaired == null) {
              break;
            }
            callArgs = repaired;
          }
        }
      });
      if (verdict.engineError != null) {
        verdict.outcome = 'engine-rejected';
      } else if (verdict.queries === 0 && verdict.outcome !== 'timeout') {
        /** `not-driven` = validation threw before any query (repairable with an
         * override); `no-queries` = returned cleanly without touching the
         * database (a pure helper, or a guard the synthesized state
         * short-circuited). Both are un-adjudicated; they differ in remedy. */
        verdict.outcome = verdict.detail != null ? 'not-driven' : 'no-queries';
      } else if (verdict.detail != null && verdict.outcome === 'ok') {
        verdict.outcome = 'threw';
      }
      if (STRICT) {
        expect(verdict.outcome).not.toBe('engine-rejected');
      }
    },
    METHOD_TIMEOUT_MS,
  );
});
