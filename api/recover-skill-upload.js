require('module-alias/register');
const mongoose = require('mongoose');
const { createModels, createMethods, runAsSystem } = require('@librechat/data-schemas');
const { runSkillUploadRecoveryCommand } = require('@librechat/api');

createModels(mongoose);
const methods = createMethods(mongoose);

runSkillUploadRecoveryCommand(process.argv.slice(2), {
  connect: () => require('./db/connect').connectDb(),
  disconnect: () => mongoose.disconnect(),
  runAsSystem,
  getIntent: methods.getSkillUploadIntent,
  listIntents: methods.listSkillUploadIntents,
  recoverStoppedIntent: methods.recoverStoppedSkillUploadIntent,
  recoverStoppedCleanupHold: methods.recoverStoppedSkillUploadCleanupHold,
  write: console.log,
  writeError: console.error,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('Skill upload recovery failed');
    process.exitCode = 1;
  });
