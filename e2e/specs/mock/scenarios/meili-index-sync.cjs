/** Runs the startup search sync once against MONGO_URI and MEILI_HOST, then exits. */
const path = require('path');
const mongoose = require('mongoose');
const { createModels } = require('@librechat/data-schemas');

require('module-alias')({ base: path.resolve(__dirname, '../../../../api') });
createModels(mongoose);
const indexSync = require('~/db/indexSync');

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await indexSync();
  } finally {
    await mongoose.disconnect();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
