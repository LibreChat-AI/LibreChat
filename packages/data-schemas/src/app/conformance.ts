/* eslint-disable jest/no-export -- This file is a shared contract-test suite, not a
   spec: it exports the harness interface and the suite factory that each engine's
   own spec imports. The rule guards against accidental exports from spec files. */
/**
 * The portable admin-config store contract, as tests.
 *
 * `./store` defines the contract and the operations built on it. This suite checks what only
 * an engine can be asked: that it stores override documents verbatim whatever their keys, that
 * every write is a compare-and-swap on a revision, and that listing is deterministic. An
 * engine satisfies the contract by implementing `ConfigStoreHarness` and calling
 * `describeConfigStoreConformance` from a spec: Mongoose against mongodb-memory-server today
 * (`conformance.mongoose.spec.ts`, and `misc/ferretdb` against FerretDB or a real mongod), a
 * PostgreSQL/JSONB engine later.
 *
 * Engine-specific behaviour (key encoding at rest, legacy documents) stays in the engine's own
 * spec. Tenant isolation has its own contract in `~/tenant/conformance`.
 */

import { PrincipalType, PrincipalModel } from 'librechat-data-provider';
import type { TCustomConfig } from 'librechat-data-provider';
import type { ConfigDraft, ConfigStore, ConfigRecord, ConfigPrincipal } from './store';
import {
  isConfigMoveRefused,
  getConfigRevision,
  CONFIG_WRITE_ATTEMPTS,
  ABSENT_CONFIG_REVISION,
  createConfigOperations,
  isConfigRevisionConflict,
} from './store';
import { BASE_CONFIG_PRINCIPAL_ID } from '~/admin/capabilities';
import { toConfigOverrideState } from './mutations';
import { applyConfigChanges } from './changes';
import logger from '~/config/winston';

export interface ConfigStoreHarness {
  readonly name: string;
  /** Prepares the engine and returns the store under test. */
  setup(): Promise<ConfigStore>;
  teardown(): Promise<void>;
  /** Removes every document. */
  reset(): Promise<void>;
  /**
   * Makes the engine's next create commit and then lose its acknowledgement, as a connection
   * that drops after the database applied the write would. The engine must still return the
   * document it created (`ConfigStore.write`).
   */
  loseNextCreateAcknowledgement(): void;
}

const role = (principalId: string): ConfigPrincipal => ({
  principalType: PrincipalType.ROLE,
  principalId,
});

const group = (principalId: string): ConfigPrincipal => ({
  principalType: PrincipalType.GROUP,
  principalId,
});

const user = (principalId: string): ConfigPrincipal => ({
  principalType: PrincipalType.USER,
  principalId,
});

function draft(
  overrides: Record<string, unknown> = {},
  extra: Partial<ConfigDraft> = {},
): ConfigDraft {
  return {
    principalModel: PrincipalModel.ROLE,
    priority: 10,
    overrides: overrides as Partial<TCustomConfig>,
    tombstones: [],
    isActive: true,
    ...extra,
  };
}

/** Keys that MongoDB-compatible engines cannot address or store as field names, at every depth. */
const AWKWARD_KEYS = [
  'us.anthropic.claude-sonnet-4-5',
  'gpt-4.1',
  '.leading',
  'trailing.',
  'a..b',
  '$set',
  '$',
  'price$',
  'mid$dle',
  '%',
  '%25',
  '%2E',
  '%2e',
  '%24',
  '%00',
  '%%',
  '100%',
  'ünïcödé',
  '模型.名称',
  '🔑.emoji',
  'é',
  'image/*',
  'text/plain; charset=utf-8',
];

function keyedObject(depth: number): Record<string, unknown> {
  const leaf = Object.fromEntries(AWKWARD_KEYS.map((key, index) => [key, index]));
  let value: Record<string, unknown> = leaf;
  for (let level = 0; level < depth; level++) {
    value = { [AWKWARD_KEYS[level % AWKWARD_KEYS.length]]: value, plain: level };
  }
  return value;
}

export function describeConfigStoreConformance(harness: ConfigStoreHarness): void {
  describe(`config store conformance: ${harness.name}`, () => {
    let store: ConfigStore;

    beforeAll(async () => {
      store = await harness.setup();
    });
    afterAll(() => harness.teardown());
    beforeEach(() => harness.reset());

    const conflictOf = async (promise: Promise<unknown>): Promise<unknown> => {
      try {
        await promise;
      } catch (error) {
        return error;
      }
      throw new Error('expected a revision conflict');
    };

    const ids = (records: ConfigRecord[]): string[] =>
      records.map((record) => `${record.principalType}:${record.principalId}`);

    /** The store with `hook` run before every removal, to land a concurrent write in between. */
    const withRemoveHook = (hook: (principal: ConfigPrincipal) => Promise<void>): ConfigStore => ({
      ...store,
      remove: async (principal, expected) => {
        await hook(principal);
        return store.remove(principal, expected);
      },
    });

    describe('documents', () => {
      it('reads nothing for a principal without a document', async () => {
        expect(await store.read(role('nobody'))).toBeNull();
      });

      it('creates a document at version 1 and reads back exactly what was written', async () => {
        const written = await store.write(
          role('editor'),
          draft({ interface: { customWelcome: 'hi' } }, { tombstones: ['memory.agent'] }),
          ABSENT_CONFIG_REVISION,
        );

        expect(written).toEqual(
          expect.objectContaining({
            principalType: PrincipalType.ROLE,
            principalId: 'editor',
            principalModel: PrincipalModel.ROLE,
            priority: 10,
            isActive: true,
            configVersion: 1,
            overrides: { interface: { customWelcome: 'hi' } },
            tombstones: ['memory.agent'],
          }),
        );
        expect(typeof written._id).toBe('string');
        expect(getConfigRevision(written)).toBe(`${written._id}:1`);
        expect(await store.read(role('editor'))).toEqual(written);
      });

      it('round-trips dotted, `$`, escape-like and unicode keys at every depth', async () => {
        const overrides = {
          ...Object.fromEntries(AWKWARD_KEYS.map((key) => [key, { nested: key }])),
          endpoints: {
            bedrock: { inferenceProfiles: keyedObject(0) },
            azureOpenAI: {
              groups: [{ group: 'g', models: { 'gpt-4.1': true, '$x.y': { 'a.b': 1 } } }],
            },
            custom: [
              {
                name: 'c',
                headers: { 'X.Trace': '${TRACE}', $ref: 'v' },
                addParams: keyedObject(3),
              },
            ],
          },
          fileConfig: { endpoints: { 'agents.v2': { supportedMimeTypes: ['image/.*', '$'] } } },
          deep: keyedObject(12),
        };

        const written = await store.write(role('keys'), draft(overrides), ABSENT_CONFIG_REVISION);

        expect(written.overrides).toEqual(overrides);
        expect((await store.read(role('keys')))?.overrides).toEqual(overrides);
        expect((await store.list())[0].overrides).toEqual(overrides);
        expect((await store.listActive([role('keys')]))[0].overrides).toEqual(overrides);
      });

      it('never rewrites values, only keys', async () => {
        const overrides = {
          interface: { customWelcome: 'a.b $c %2E %25 %24 ${VAR} 模型' },
          list: ['a.b', '$c', '%2E', { 'k.k': ['%24', null, true, 1.5] }],
        };

        await store.write(role('values'), draft(overrides), ABSENT_CONFIG_REVISION);

        expect((await store.read(role('values')))?.overrides).toEqual(overrides);
      });

      it('keeps empty objects and arrays, which carry meaning (an empty theme replaces the base one)', async () => {
        const overrides = {
          interface: { theme: {} },
          endpoints: { custom: [] },
          list: [{}, []],
          deep: { a: { b: {} } },
        };

        await store.write(role('empty'), draft(overrides), ABSENT_CONFIG_REVISION);

        expect((await store.read(role('empty')))?.overrides).toEqual(overrides);
      });

      it('keeps tombstones as written', async () => {
        const tombstones = ['mcpServers.github', 'memory.agent.id', 'endpoints.custom'];

        await store.write(role('hidden'), draft({}, { tombstones }), ABSENT_CONFIG_REVISION);

        expect((await store.read(role('hidden')))?.tombstones).toEqual(tombstones);
      });

      it('keeps keyed tombstones as written, whatever the entry key holds', async () => {
        const tombstones = [
          'endpoints.custom["api.example.com"]',
          'endpoints.custom["$cost ~ \\"quoted\\" [x]"].headers.X-Key',
          'endpoints.custom["名前 🚀"].addParams.anthropicApiUrl',
        ];

        await store.write(role('keyed'), draft({}, { tombstones }), ABSENT_CONFIG_REVISION);

        expect((await store.read(role('keyed')))?.tombstones).toEqual(tombstones);
      });

      it('reads inactive documents', async () => {
        await store.write(role('off'), draft({}, { isActive: false }), ABSENT_CONFIG_REVISION);

        expect((await store.read(role('off')))?.isActive).toBe(false);
      });
    });

    describe('compare-and-swap', () => {
      it('replaces the whole document at the current revision and bumps the version', async () => {
        const first = await store.write(
          role('cas'),
          draft({ a: { b: 1 }, keep: true }, { tombstones: ['x.y'] }),
          ABSENT_CONFIG_REVISION,
        );

        const second = await store.write(
          role('cas'),
          draft({ a: { c: 2 } }, { priority: 30, isActive: false }),
          getConfigRevision(first),
        );

        expect(second._id).toBe(first._id);
        expect(second.configVersion).toBe(2);
        expect(second.overrides).toEqual({ a: { c: 2 } });
        expect(second.tombstones).toEqual([]);
        expect(second.priority).toBe(30);
        expect(second.isActive).toBe(false);
      });

      it('refuses a create when the principal already has a document', async () => {
        const first = await store.write(role('dup'), draft({ a: 1 }), ABSENT_CONFIG_REVISION);

        const error = await conflictOf(
          store.write(role('dup'), draft({ a: 2 }), ABSENT_CONFIG_REVISION),
        );

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect(await store.read(role('dup'))).toEqual(first);
      });

      it('refuses a stale revision and leaves the document unchanged', async () => {
        const first = await store.write(role('stale'), draft({ a: 1 }), ABSENT_CONFIG_REVISION);
        const second = await store.write(role('stale'), draft({ a: 2 }), getConfigRevision(first));

        const error = await conflictOf(
          store.write(role('stale'), draft({ a: 3 }), getConfigRevision(first)),
        );

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect(await store.read(role('stale'))).toEqual(second);
      });

      it('never creates a document when a write names a revision of one that does not exist', async () => {
        const gone = await store.write(role('gone'), draft(), ABSENT_CONFIG_REVISION);
        await store.remove(role('gone'));

        const error = await conflictOf(store.write(role('gone'), draft(), getConfigRevision(gone)));

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect(await store.read(role('gone'))).toBeNull();
      });

      it('refuses a revision of a deleted document after the principal is recreated (ABA)', async () => {
        const original = await store.write(
          role('aba'),
          draft({ v: 'old' }),
          ABSENT_CONFIG_REVISION,
        );
        await store.remove(role('aba'));
        const recreated = await store.write(
          role('aba'),
          draft({ v: 'new' }),
          ABSENT_CONFIG_REVISION,
        );
        expect(recreated.configVersion).toBe(original.configVersion);

        const error = await conflictOf(
          store.write(role('aba'), draft({ v: 'stale' }), getConfigRevision(original)),
        );

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect((await store.read(role('aba')))?.overrides).toEqual({ v: 'new' });
      });

      it('lets exactly one of two concurrent writes at the same revision win', async () => {
        const base = await store.write(role('race'), draft({ n: 0 }), ABSENT_CONFIG_REVISION);

        const results = await Promise.allSettled([
          store.write(role('race'), draft({ n: 1 }), getConfigRevision(base)),
          store.write(role('race'), draft({ n: 2 }), getConfigRevision(base)),
        ]);

        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(isConfigRevisionConflict(rejected[0].reason)).toBe(true);
        const stored = await store.read(role('race'));
        expect(stored?.configVersion).toBe(2);
        expect(stored).toEqual((fulfilled[0] as PromiseFulfilledResult<ConfigRecord>).value);
      });

      it('lets exactly one of two concurrent creates win', async () => {
        const results = await Promise.allSettled([
          store.write(role('first'), draft({ n: 1 }), ABSENT_CONFIG_REVISION),
          store.write(role('first'), draft({ n: 2 }), ABSENT_CONFIG_REVISION),
        ]);

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect((await store.list()).length).toBe(1);
      });

      it('returns the document a create made even when its acknowledgement is lost', async () => {
        harness.loseNextCreateAcknowledgement();

        const created = await store.write(
          role('unacknowledged'),
          draft({ 'a.b': 1 }),
          ABSENT_CONFIG_REVISION,
        );

        expect(created).toMatchObject({
          principalId: 'unacknowledged',
          configVersion: 1,
          overrides: { 'a.b': 1 },
        });
        expect(await store.read(role('unacknowledged'))).toEqual(created);
      });

      it('rejects a malformed revision as a conflict without writing', async () => {
        await store.write(role('odd'), draft({ a: 1 }), ABSENT_CONFIG_REVISION);

        const error = await conflictOf(store.write(role('odd'), draft({ a: 2 }), 'not-a-revision'));

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect((await store.read(role('odd')))?.overrides).toEqual({ a: 1 });
      });
    });

    describe('remove and restore', () => {
      it('removes and returns the document; a missing one is null', async () => {
        const written = await store.write(role('rm'), draft({ a: 1 }), ABSENT_CONFIG_REVISION);

        expect(await store.remove(role('rm'))).toEqual(written);
        expect(await store.remove(role('rm'))).toBeNull();
        expect(await store.read(role('rm'))).toBeNull();
      });

      it('removes only at the expected revision', async () => {
        const first = await store.write(role('rmcas'), draft({ a: 1 }), ABSENT_CONFIG_REVISION);
        const second = await store.write(role('rmcas'), draft({ a: 2 }), getConfigRevision(first));

        const error = await conflictOf(store.remove(role('rmcas'), getConfigRevision(first)));
        expect(isConfigRevisionConflict(error)).toBe(true);
        expect(await store.read(role('rmcas'))).toEqual(second);

        expect(await store.remove(role('rmcas'), getConfigRevision(second))).toEqual(second);
        expect(await store.remove(role('rmcas'), ABSENT_CONFIG_REVISION)).toBeNull();
      });

      it('restores a removed document as it was, and never over a newer one', async () => {
        const written = await store.write(
          role('restore'),
          draft({ 'gpt-4.1': { $x: 1 } }, { tombstones: ['a.b'], isActive: false, priority: 7 }),
          ABSENT_CONFIG_REVISION,
        );
        const removed = await store.remove(role('restore'));

        expect(await store.restore(removed as ConfigRecord)).toBe(true);
        const restored = await store.read(role('restore'));
        expect(restored).toEqual(written);
        expect(getConfigRevision(restored as ConfigRecord)).toBe(getConfigRevision(written));

        const newer = await store.write(
          role('restore'),
          draft({ v: 2 }),
          getConfigRevision(written),
        );
        expect(await store.restore(removed as ConfigRecord)).toBe(false);
        expect(await store.read(role('restore'))).toEqual(newer);
      });
    });

    describe('listing', () => {
      async function seed(): Promise<ConfigRecord[]> {
        const records: ConfigRecord[] = [];
        for (const [principal, priority, isActive] of [
          [role('b'), 20, true],
          [role(BASE_CONFIG_PRINCIPAL_ID), 0, true],
          [group('g2'), 20, true],
          [role('a'), 20, true],
          [group('g1'), 5, false],
          [role('c'), 100, true],
        ] as Array<[ConfigPrincipal, number, boolean]>) {
          records.push(
            await store.write(principal, draft({}, { priority, isActive }), ABSENT_CONFIG_REVISION),
          );
        }
        return records;
      }

      it('orders by priority, then identity, the same way every time', async () => {
        const records = await seed();
        const tied = records
          .filter((record) => record.priority === 20)
          .sort((left, right) => (left._id < right._id ? -1 : 1));

        const listed = await store.list();
        expect(listed.map((record) => record.priority)).toEqual([0, 5, 20, 20, 20, 100]);
        expect(listed.slice(2, 5).map((record) => record._id)).toEqual(
          tied.map((record) => record._id),
        );
        expect(ids(await store.list())).toEqual(ids(listed));
      });

      it('filters the full list by active state', async () => {
        await seed();

        expect(ids(await store.list({ isActive: false }))).toEqual(['group:g1']);
        expect(await store.list({ isActive: true })).toHaveLength(5);
      });

      it('lists only the active documents of the requested principals, in store order', async () => {
        await seed();

        const listed = await store.listActive([
          role('c'),
          group('g1'),
          role(BASE_CONFIG_PRINCIPAL_ID),
          role('a'),
          group('missing'),
        ]);

        expect(ids(listed)).toEqual([`role:${BASE_CONFIG_PRINCIPAL_ID}`, 'role:a', 'role:c']);
        expect(await store.listActive([])).toEqual([]);
      });
    });

    describe('operations on this engine', () => {
      it('tombstones remove the override subtree, prune emptied parents, and are cleared by a write', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(role('ops'), PrincipalModel.ROLE, {
          'mcpServers.github.title': 'GitHub',
          'balance.enabled': true,
        });

        const hidden = await operations.tombstoneFields(role('ops'), PrincipalModel.ROLE, [
          'mcpServers.github',
          'memory.agent',
        ]);
        expect(hidden.overrides).toEqual({ balance: { enabled: true } });
        expect(hidden.tombstones).toEqual(['mcpServers.github', 'memory.agent']);

        const reset = await operations.unsetFields(role('ops'), 'balance.enabled');
        expect(reset?.overrides).toEqual({});
        expect(reset?.tombstones).toEqual(['mcpServers.github', 'memory.agent']);

        const shown = await operations.setFields(role('ops'), PrincipalModel.ROLE, {
          'mcpServers.github.title': 'Again',
        });
        expect(shown.tombstones).toEqual(['memory.agent']);
        expect(shown.configVersion).toBe(4);
      });

      it('keyed tombstones hide an entry by its key, and an entry write or a reset clears them', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(role('keyed-ops'), PrincipalModel.ROLE, {
          'endpoints.custom': [{ name: 'a.b', baseURL: 'https://a', headers: { X: 'x', Y: 'y' } }],
        });

        const hidden = await operations.tombstoneFields(role('keyed-ops'), PrincipalModel.ROLE, [
          'endpoints.custom["a.b"].headers.X',
          'endpoints.custom["yaml one"]',
        ]);
        expect(hidden.overrides).toEqual({
          endpoints: { custom: [{ name: 'a.b', baseURL: 'https://a', headers: { Y: 'y' } }] },
        });
        expect(hidden.tombstones).toEqual([
          'endpoints.custom["a.b"].headers.X',
          'endpoints.custom["yaml one"]',
        ]);

        const shown = await operations.setFields(role('keyed-ops'), PrincipalModel.ROLE, {
          'endpoints.custom': [{ name: 'yaml one', titleModel: 't' }],
        });
        expect(shown.tombstones).toEqual(['endpoints.custom["a.b"].headers.X']);

        const reset = await operations.unsetFields(role('keyed-ops'), 'endpoints.custom');
        expect(reset?.overrides).toEqual({});
        expect(reset?.tombstones).toEqual([]);
      });

      it('lists the active documents tombstoned at or below a path, in store order, without overrides', async () => {
        const operations = createConfigOperations(store);
        const tombstone = (principalId: string, fieldPath: string, priority?: number) =>
          operations.tombstoneFields(role(principalId), PrincipalModel.ROLE, fieldPath, priority);
        await operations.setFields(
          role('hides'),
          PrincipalModel.ROLE,
          { 'mcpServers.docs.title': 'Docs', 'balance.enabled': true },
          20,
        );
        await tombstone('hides', 'mcpServers.github');
        await tombstone('section', 'mcpServers', 10);
        await tombstone('field', 'mcpServers.github.headers', 30);
        await tombstone('other', 'webSearch', 5);
        await tombstone('prefix', 'mcpServersArchive', 5);
        await tombstone('off', 'mcpServers.github', 5);
        await operations.setActive(role('off'), false);

        expect(await operations.listTombstones('mcpServers')).toEqual([
          { principalType: PrincipalType.ROLE, principalId: 'section', tombstones: ['mcpServers'] },
          {
            principalType: PrincipalType.ROLE,
            principalId: 'hides',
            tombstones: ['mcpServers.github'],
          },
          {
            principalType: PrincipalType.ROLE,
            principalId: 'field',
            tombstones: ['mcpServers.github.headers'],
          },
        ]);
        expect(await operations.listTombstones('mcpServers.docs')).toEqual([]);
      });

      it('stores a batch of changes, renames and awkward keys included, as one write', async () => {
        const headers = keyedObject(2);
        const created = await store.write(
          role('batch'),
          draft({
            endpoints: {
              custom: [{ name: 'old', apiKey: 'v3:cipher', baseURL: 'https://old.example.com' }],
            },
            mcpServers: { a: { url: 'https://a.example.com', headers } },
          }),
          ABSENT_CONFIG_REVISION,
        );

        const { state, changed } = applyConfigChanges(toConfigOverrideState(created), [
          { op: 'rename', segments: ['endpoints', 'custom'], from: 'old', to: 'new' },
          { op: 'rename', segments: ['mcpServers'], from: 'a', to: 'b' },
          {
            op: 'set',
            segments: ['mcpServers', 'b', 'headers', '$set'],
            value: { 'x.y': '$', 'ünï.cödé': 1 },
          },
          {
            op: 'set',
            segments: [
              'endpoints',
              'bedrock',
              'inferenceProfiles',
              'us.anthropic.claude-sonnet-4-5',
            ],
            value: 'arn:aws:bedrock:us-east-1:1:inference-profile/x',
          },
          { op: 'tombstone', segments: ['memory', 'agent'] },
          { op: 'unset', segments: ['mcpServers', 'missing'] },
        ]);
        expect(changed).toEqual([true, true, true, true, true, false]);

        const written = await store.write(
          role('batch'),
          draft(state.overrides as Record<string, unknown>, { tombstones: state.tombstones }),
          getConfigRevision(created),
        );

        expect(written.configVersion).toBe(2);
        const stored = await store.read(role('batch'));
        expect(stored?.overrides).toEqual({
          endpoints: {
            custom: [{ name: 'new', apiKey: 'v3:cipher', baseURL: 'https://old.example.com' }],
            bedrock: {
              inferenceProfiles: {
                'us.anthropic.claude-sonnet-4-5': 'arn:aws:bedrock:us-east-1:1:inference-profile/x',
              },
            },
          },
          mcpServers: {
            b: {
              url: 'https://a.example.com',
              headers: { ...headers, $set: { 'x.y': '$', 'ünï.cödé': 1 } },
            },
          },
        });
        expect(stored?.tombstones).toEqual(['memory.agent']);
      });

      it('surfaces a conflict when a caller-supplied revision is stale', async () => {
        const operations = createConfigOperations(store);
        const first = await operations.setFields(role('stale-op'), PrincipalModel.ROLE, {
          'a.b': 1,
        });
        await operations.setFields(role('stale-op'), PrincipalModel.ROLE, { 'a.b': 2 });

        const error = await conflictOf(
          operations.setFields(role('stale-op'), PrincipalModel.ROLE, { 'a.b': 3 }, undefined, {
            expectedRevision: getConfigRevision(first),
          }),
        );

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect((await store.read(role('stale-op')))?.overrides).toEqual({ a: { b: 2 } });
      });

      it('lists and resolves documents in merge precedence order', async () => {
        const operations = createConfigOperations(store);
        for (const [principal, priority] of [
          [user('u1'), 20],
          [group('g2'), 20],
          [role('editor'), 20],
          [role(BASE_CONFIG_PRINCIPAL_ID), 50],
          [group('g1'), 20],
          [role('viewer'), 5],
        ] as Array<[ConfigPrincipal, number]>) {
          await store.write(principal, draft({}, { priority }), ABSENT_CONFIG_REVISION);
        }
        const tiedGroups = (await store.list())
          .filter((record) => record.principalType === PrincipalType.GROUP)
          .map((record) => `group:${record.principalId}`);

        const expected = [
          `role:${BASE_CONFIG_PRINCIPAL_ID}`,
          'role:viewer',
          'role:editor',
          ...tiedGroups,
          'user:u1',
        ];
        expect(ids(await operations.listConfigs())).toEqual(expected);
        expect(
          ids(
            await operations.getApplicableConfigs([
              user('u1'),
              group('g1'),
              group('g2'),
              role('editor'),
              role('viewer'),
            ]),
          ),
        ).toEqual(expected);
      });

      it('gives a document a write creates its principal type default priority', async () => {
        const operations = createConfigOperations(store);
        const fields = { 'interface.customWelcome': 'hi' };

        const created = await Promise.all([
          operations.setFields(role('defaults'), PrincipalModel.ROLE, fields),
          operations.setFields(group('defaults'), PrincipalModel.GROUP, fields),
          operations.setFields(user('defaults'), PrincipalModel.USER, fields),
          operations.setFields(role(BASE_CONFIG_PRINCIPAL_ID), PrincipalModel.ROLE, fields),
        ]);

        expect(created.map((record) => record.priority)).toEqual([10, 20, 100, 0]);
      });

      it('keeps the stored priority when a replace or patch does not name one', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(group('kept'), PrincipalModel.GROUP, { a: 1 }, 35);

        const replaced = await operations.replaceOverrides(group('kept'), PrincipalModel.GROUP, {
          interface: { customWelcome: 'x' },
        } as Partial<TCustomConfig>);
        const patched = await operations.setFields(group('kept'), PrincipalModel.GROUP, { b: 2 });

        expect(replaced?.priority).toBe(35);
        expect(patched.priority).toBe(35);
      });

      it('changes only the priority, and writes nothing when it is unchanged', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(role('prio'), PrincipalModel.ROLE, { 'a.b': 1 });
        await operations.tombstoneFields(role('prio'), PrincipalModel.ROLE, 'memory.agent');
        const before = await operations.setActive(role('prio'), false);

        const changed = await operations.setPriority(role('prio'), 42);
        expect(changed?.changed).toBe(true);
        expect(changed?.config).toMatchObject({
          priority: 42,
          overrides: { a: { b: 1 } },
          tombstones: ['memory.agent'],
          isActive: false,
          configVersion: (before?.config.configVersion ?? 0) + 1,
        });

        const unchanged = await operations.setPriority(role('prio'), 42);
        expect(unchanged).toEqual({ config: changed?.config, changed: false });
        expect(await operations.setPriority(role('nobody'), 1)).toBeNull();
      });

      it('refuses a priority change at a stale revision', async () => {
        const operations = createConfigOperations(store);
        const first = await operations.setFields(role('prio-stale'), PrincipalModel.ROLE, { a: 1 });
        await operations.setFields(role('prio-stale'), PrincipalModel.ROLE, { a: 2 });

        const error = await conflictOf(
          operations.setPriority(role('prio-stale'), 7, {
            expectedRevision: getConfigRevision(first),
          }),
        );

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect((await store.read(role('prio-stale')))?.priority).toBe(10);
      });

      it('moves a document to another principal, and never over an existing one', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(role('old'), PrincipalModel.ROLE, { 'a.b': 1 }, 15);
        await operations.tombstoneFields(role('old'), PrincipalModel.ROLE, 'memory.agent');
        await operations.setActive(role('old'), false);

        const moved = await operations.movePrincipal(role('old'), role('new'));

        expect(await store.read(role('old'))).toBeNull();
        expect(moved).toMatchObject({
          principalType: PrincipalType.ROLE,
          principalId: 'new',
          priority: 15,
          overrides: { a: { b: 1 } },
          tombstones: ['memory.agent'],
          isActive: false,
        });
        expect(await store.read(role('new'))).toEqual(moved);
        expect(await operations.movePrincipal(role('missing'), role('new'))).toBeNull();

        await operations.setFields(role('other'), PrincipalModel.ROLE, { c: 1 });
        const error = await conflictOf(operations.movePrincipal(role('other'), role('new')));
        expect(isConfigMoveRefused(error, 'CONFIG_PRINCIPAL_EXISTS')).toBe(true);
        expect(isConfigRevisionConflict(error)).toBe(false);
        expect((await store.read(role('other')))?.overrides).toEqual({ c: 1 });
        expect(await store.read(role('new'))).toEqual(moved);
      });

      it('never moves Base, nor moves a document onto it', async () => {
        const operations = createConfigOperations(store);
        const base = await operations.setFields(
          role(BASE_CONFIG_PRINCIPAL_ID),
          PrincipalModel.ROLE,
          {
            'interface.customWelcome': 'everyone',
          },
        );

        const demote = await conflictOf(
          operations.movePrincipal(role(BASE_CONFIG_PRINCIPAL_ID), role('demoted')),
        );

        expect(isConfigMoveRefused(demote, 'CONFIG_PRINCIPAL_RESERVED')).toBe(true);
        expect(await store.read(role(BASE_CONFIG_PRINCIPAL_ID))).toEqual(base);
        expect(await store.read(role('demoted'))).toBeNull();

        await operations.deleteConfig(role(BASE_CONFIG_PRINCIPAL_ID));
        const profile = await operations.setFields(role('promoted'), PrincipalModel.ROLE, {
          'interface.customWelcome': 'one role',
        });

        const promote = await conflictOf(
          operations.movePrincipal(role('promoted'), role(BASE_CONFIG_PRINCIPAL_ID)),
        );

        expect(isConfigMoveRefused(promote, 'CONFIG_PRINCIPAL_RESERVED')).toBe(true);
        expect(await store.read(role(BASE_CONFIG_PRINCIPAL_ID))).toBeNull();
        expect(await store.read(role('promoted'))).toEqual(profile);
      });

      it('withdraws the copy and moves again when the source changes before its removal', async () => {
        let edits = 0;
        const racing = withRemoveHook(async (principal) => {
          if (principal.principalId === 'racing' && edits++ === 0) {
            await createConfigOperations(store).setFields(role('racing'), PrincipalModel.ROLE, {
              late: true,
            });
          }
        });
        const operations = createConfigOperations(racing);
        await operations.setFields(role('racing'), PrincipalModel.ROLE, { early: true });

        const moved = await operations.movePrincipal(role('racing'), role('settled'));

        expect(edits).toBe(2);
        expect(moved?.overrides).toEqual({ early: true, late: true });
        expect(await store.read(role('settled'))).toEqual(moved);
        expect(await store.read(role('racing'))).toBeNull();
      });

      it('keeps the copy when the removal committed before it failed', async () => {
        let failed = false;
        const flaky: ConfigStore = {
          ...store,
          remove: async (principal, expected) => {
            const removed = await store.remove(principal, expected);
            if (!failed && principal.principalId === 'flaky') {
              failed = true;
              throw new Error('connection reset after the delete');
            }
            return removed;
          },
        };
        const operations = createConfigOperations(flaky);
        await operations.setFields(role('flaky'), PrincipalModel.ROLE, { kept: true });

        const moved = await operations.movePrincipal(role('flaky'), role('landed'));

        expect(failed).toBe(true);
        expect(moved?.overrides).toEqual({ kept: true });
        expect(await store.read(role('landed'))).toEqual(moved);
        expect(await store.read(role('flaky'))).toBeNull();
      });

      it('keeps the copy and reports the failure when a failed removal cannot be read back', async () => {
        const removalFailure = new Error('connection reset after the delete');
        let disconnected = false;
        const blind: ConfigStore = {
          ...store,
          read: async (principal) => {
            if (disconnected && principal.principalId === 'blind') {
              throw new Error('connection still down');
            }
            return store.read(principal);
          },
          remove: async (principal, expected) => {
            const removed = await store.remove(principal, expected);
            if (!disconnected && principal.principalId === 'blind') {
              disconnected = true;
              throw removalFailure;
            }
            return removed;
          },
        };
        const operations = createConfigOperations(blind);
        await operations.setFields(role('blind'), PrincipalModel.ROLE, { kept: true });

        const error = await conflictOf(operations.movePrincipal(role('blind'), role('shelter')));

        expect(disconnected).toBe(true);
        expect(error).toBe(removalFailure);
        expect(await store.read(role('blind'))).toBeNull();
        expect((await store.read(role('shelter')))?.overrides).toEqual({ kept: true });
      });

      it('finishes a move whose copy committed though its acknowledgement was lost', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(role('sender'), PrincipalModel.ROLE, { kept: true }, 12);
        harness.loseNextCreateAcknowledgement();

        const moved = await operations.movePrincipal(role('sender'), role('receiver'));

        expect(moved).toMatchObject({ overrides: { kept: true }, priority: 12 });
        expect(await store.read(role('receiver'))).toEqual(moved);
        expect(await store.read(role('sender'))).toBeNull();
      });

      it('never removes a copy it cannot confirm it created, and reports the failure', async () => {
        const unconfirmed = new Error('connection reset; the create could not be confirmed');
        const unsure: ConfigStore = {
          ...store,
          write: async (principal, next, expected) => {
            const written = await store.write(principal, next, expected);
            if (principal.principalId === 'unsure-copy') {
              throw unconfirmed;
            }
            return written;
          },
        };
        const operations = createConfigOperations(unsure);
        await operations.setFields(role('unsure'), PrincipalModel.ROLE, { kept: true });

        const error = await conflictOf(
          operations.movePrincipal(role('unsure'), role('unsure-copy')),
        );

        expect(error).toBe(unconfirmed);
        expect((await store.read(role('unsure')))?.overrides).toEqual({ kept: true });
        expect((await store.read(role('unsure-copy')))?.overrides).toEqual({ kept: true });
      });

      it('moves back only the document it moved, edits included, never one put there since', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(role('home'), PrincipalModel.ROLE, { mine: true });
        const moved = await operations.movePrincipal(role('home'), role('away'));
        await operations.setFields(role('away'), PrincipalModel.ROLE, { edited: true });

        const back = await operations.movePrincipal(role('away'), role('home'), {
          identity: moved?._id,
        });

        expect(back?.overrides).toEqual({ mine: true, edited: true });
        expect(await store.read(role('away'))).toBeNull();

        const again = await operations.movePrincipal(role('home'), role('away'));
        await operations.deleteConfig(role('away'));
        const replacement = await operations.setFields(role('away'), PrincipalModel.ROLE, {
          theirs: true,
        });

        expect(
          await operations.movePrincipal(role('away'), role('home'), { identity: again?._id }),
        ).toBeNull();
        expect(await store.read(role('away'))).toEqual(replacement);
        expect(await store.read(role('home'))).toBeNull();
      });

      it('gives up with a revision conflict, leaving the source in place, when it keeps changing', async () => {
        let edits = 0;
        const busy = withRemoveHook(async (principal) => {
          if (principal.principalId === 'busy') {
            edits++;
            await createConfigOperations(store).setFields(role('busy'), PrincipalModel.ROLE, {
              edits,
            });
          }
        });

        await createConfigOperations(store).setFields(role('busy'), PrincipalModel.ROLE, {
          seeded: true,
        });

        const exhausted = await conflictOf(
          createConfigOperations(busy).movePrincipal(role('busy'), role('never')),
        );

        expect(edits).toBe(CONFIG_WRITE_ATTEMPTS);
        expect(isConfigRevisionConflict(exhausted)).toBe(true);
        expect(isConfigMoveRefused(exhausted)).toBe(false);
        expect(await store.read(role('never'))).toBeNull();
        expect((await store.read(role('busy')))?.overrides).toEqual({
          seeded: true,
          edits: CONFIG_WRITE_ATTEMPTS,
        });
      });

      it('keeps a copy that was edited before it could be withdrawn, and reports the conflict', async () => {
        const editBoth = withRemoveHook(async (principal) => {
          if (principal.principalId !== 'source') {
            return;
          }
          const operations = createConfigOperations(store);
          await operations.setFields(role('source'), PrincipalModel.ROLE, { source: 2 });
          await operations.setFields(role('copy'), PrincipalModel.ROLE, { copy: 'edited' });
        });
        const operations = createConfigOperations(editBoth);
        await operations.setFields(role('source'), PrincipalModel.ROLE, { source: 1 });

        const error = await conflictOf(operations.movePrincipal(role('source'), role('copy')));

        expect(isConfigRevisionConflict(error)).toBe(true);
        expect(isConfigMoveRefused(error)).toBe(false);
        expect((await store.read(role('source')))?.overrides).toEqual({ source: 2 });
        expect((await store.read(role('copy')))?.overrides).toEqual({
          source: 1,
          copy: 'edited',
        });
      });

      it('names a copy it could not withdraw in the log, so it can be removed', async () => {
        const unreachable = new Error('connection refused');
        let down = false;
        const failing: ConfigStore = {
          ...store,
          remove: async (principal, expected) => {
            if (down) {
              throw unreachable;
            }
            if (principal.principalId === 'cut') {
              down = true;
              throw unreachable;
            }
            return store.remove(principal, expected);
          },
        };
        const operations = createConfigOperations(failing);
        await operations.setFields(role('cut'), PrincipalModel.ROLE, { kept: true });
        const errorLog = jest.spyOn(logger, 'error');

        const error = await conflictOf(operations.movePrincipal(role('cut'), role('stranded')));

        const copy = await store.read(role('stranded'));
        expect(error).toBe(unreachable);
        expect((await store.read(role('cut')))?.overrides).toEqual({ kept: true });
        expect(copy?.overrides).toEqual({ kept: true });
        expect(errorLog).toHaveBeenCalledWith(
          '[configStore] A moved config document could not be withdrawn from its copy',
          {
            principalType: PrincipalType.ROLE,
            principalId: 'stranded',
            revision: copy && getConfigRevision(copy),
            errName: 'Error',
            errCode: null,
          },
        );
      });

      it('absorbs concurrent writes without a revision so none is lost', async () => {
        const operations = createConfigOperations(store);
        await operations.setFields(role('merge'), PrincipalModel.ROLE, { seed: true });

        await Promise.all(
          ['a', 'b'].map((key) =>
            operations.setFields(role('merge'), PrincipalModel.ROLE, { [`fields.${key}`]: key }),
          ),
        );

        const stored = await store.read(role('merge'));
        expect(stored?.overrides).toEqual({ seed: true, fields: { a: 'a', b: 'b' } });
        expect(stored?.configVersion).toBe(3);
      });
    });
  });
}
