/* global db, rs, sleep */

// Explicit local bootstrap only: preserve an existing configuration, never reconfigure it.
let config;
try {
  config = rs.conf();
} catch (error) {
  if (error.code !== 94) throw error; // NotYetInitialized
  const result = rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] });
  if (result.ok !== 1) throw new Error('Local replica initialization failed');
  config = rs.conf();
}
if (
  config._id !== 'rs0' ||
  config.members.length !== 1 ||
  config.members[0].host !== 'mongodb:27017'
) {
  throw new Error('Expected local rs0 with one mongodb:27017 member; refusing to reconfigure');
}
const deadline = Date.now() + 60000;
while (!db.hello().isWritablePrimary) {
  if (Date.now() >= deadline) throw new Error('MongoDB did not become primary');
  sleep(1000);
}
print('Local MongoDB replica set is ready');
