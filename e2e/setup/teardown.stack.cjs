const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');

module.exports = async () => {
  const uri = process.env.MONGO_URI;
  assert(uri.startsWith('mongodb://mongo:27017/LibreChat-pilot-'), 'Not a pilot database');
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    const counts = {};
    for (const name of ['users', 'conversations', 'messages', 'agents']) {
      counts[name] = await db.collection(name).countDocuments();
    }
    fs.writeFileSync(
      path.join(process.env.PILOT_EVIDENCE, 'persistence.json'),
      JSON.stringify(counts),
    );
    assert(counts.messages > 0, 'No real MongoDB message writes observed');
  } finally {
    await client.close();
  }
};
