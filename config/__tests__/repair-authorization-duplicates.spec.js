const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const root = path.resolve(__dirname, '../..');
let mongo;
let connection;

function run(...args) {
  return spawnSync(process.execPath, ['config/repair-authorization-duplicates.js', ...args], {
    cwd: root,
    env: {
      ...process.env,
      MONGO_URI: mongo.getUri('authorization_cli'),
      MONGO_AUTO_INDEX: 'true',
      MONGO_AUTO_CREATE: 'true',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  connection = await mongoose
    .createConnection(mongo.getUri('authorization_cli'), {
      autoIndex: false,
      autoCreate: false,
    })
    .asPromise();
});
afterAll(async () => {
  await connection?.close();
  await mongo?.stop();
});
beforeEach(async () => {
  await connection.dropDatabase();
});

it('previews by default without starting seeders or creating indexes, then applies explicitly', async () => {
  const roles = connection.db.collection('roles');
  await roles.insertMany([
    { name: 'CUSTOM', permissions: {} },
    { name: 'CUSTOM', permissions: {} },
  ]);
  const preview = run();
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout.trim())).toMatchObject({ dryRun: true });
  expect(await roles.countDocuments()).toBe(2);
  expect((await roles.indexes()).map((index) => index.name)).toEqual(['_id_']);
  expect((await connection.db.listCollections().toArray()).map((item) => item.name)).toEqual([
    'roles',
  ]);

  expect(run('--apply').status).toBe(1);
  expect(run('--apply', '--dry-run', '--writers-paused').status).toBe(1);
  expect(run('--aply').status).toBe(1);
  expect(await roles.countDocuments()).toBe(2);
  const applied = run('--apply', '--writers-paused');
  expect(applied.status).toBe(0);
  expect(JSON.parse(applied.stdout.trim())).toMatchObject({ dryRun: false });
  expect(await roles.countDocuments()).toBe(1);
  expect(await connection.db.collection('authorization_duplicate_archive').countDocuments()).toBe(
    1,
  );
  expect((await roles.indexes()).find((index) => index.name === 'name_1_tenantId_1').unique).toBe(
    true,
  );
});

it('signals conflicts with aggregate-only output and leaves conflicting records intact', async () => {
  const roles = connection.db.collection('roles');
  await roles.insertMany([
    { name: 'PRIVATE_ROLE_VALUE', permissions: { allow: true } },
    { name: 'PRIVATE_ROLE_VALUE', permissions: { allow: false } },
  ]);
  const preview = run('--dry-run');
  expect(preview.status).toBe(2);
  expect(preview.stdout).not.toContain('PRIVATE_ROLE_VALUE');
  const applied = run('--apply', '--writers-paused');
  expect(applied.status).toBe(1);
  expect(applied.stderr).not.toContain('PRIVATE_ROLE_VALUE');
  expect(await roles.countDocuments()).toBe(2);
});
