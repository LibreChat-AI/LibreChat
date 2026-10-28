const { createTwoFactorTempUser } = require('@librechat/api');

const setTwoFactorTempUser = createTwoFactorTempUser('tempToken', process.env);
module.exports = setTwoFactorTempUser;
module.exports.setTwoFactorAcknowledgementTempUser = createTwoFactorTempUser(
  'acknowledgementToken',
  process.env,
);
module.exports.setTwoFactorFinalizationTempUser = createTwoFactorTempUser(
  'finalizationToken',
  process.env,
);
