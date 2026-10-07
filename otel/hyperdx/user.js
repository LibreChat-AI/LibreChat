/**
 * Creates or updates the DocumentDB user HyperDX connects as. It can read and
 * write the `hyperdx` database only, so HyperDX never holds the master
 * credentials that MONGO_URI carries.
 *
 * Run as a one-off ECS task on the app image (terraform/hyperdx.tf),
 * which already ships the MongoDB driver and the DocumentDB CA bundle.
 */
const { MongoClient } = require('mongodb');

const user = 'hyperdx';
const roles = [{ role: 'readWrite', db: 'hyperdx' }];

async function main() {
  const { MONGO_URI, MONGO_TLS_CA_FILE, HYPERDX_MONGO_PASSWORD } = process.env;
  if (!MONGO_URI || !HYPERDX_MONGO_PASSWORD) {
    throw new Error('MONGO_URI and HYPERDX_MONGO_PASSWORD are required');
  }

  const client = new MongoClient(MONGO_URI, MONGO_TLS_CA_FILE ? { tlsCAFile: MONGO_TLS_CA_FILE } : {});
  await client.connect();
  try {
    const admin = client.db('admin');
    const { users } = await admin.command({ usersInfo: user });
    const exists = users.length > 0;
    await admin.command({ [exists ? 'updateUser' : 'createUser']: user, pwd: HYPERDX_MONGO_PASSWORD, roles });
    console.log(`${exists ? 'Updated' : 'Created'} DocumentDB user "${user}"`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(`Failed to provision the HyperDX database user: ${error.message}`);
  process.exit(1);
});
